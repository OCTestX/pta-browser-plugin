/**
 * 真机测试的驱动器：直接用 CDP 驱动跑着的 Chrome，走插件自己的链路。
 *
 * 用法：
 *   node scripts/pta-drive.mjs read <url>            跑一轮 read_problem，打印工具结果
 *   node scripts/pta-drive.mjs solve <url> [更多...]   用插件把题解出来并提交
 *   node scripts/pta-drive.mjs tools <url>            依次跑几个工具，打印结果
 *
 * 为什么自己写 CDP 而不用 playwright：
 *   插件的悬浮窗在 content script 的隔离世界里（拿不到 chrome.*），
 *   打开悬浮窗又需要 background 的 chrome.tabs —— playwright 的 CDPSession
 *   不支持带 sessionId 的扁平协议，这里直接连浏览器的 websocket 最省事。
 */
import { readFileSync } from 'node:fs';

const CDP_HTTP = 'http://127.0.0.1:9222';
const EXT_ID = 'jgkjmjojigjmljmennhfncpjmlmedjjb';

const PROMPT = [
  '请解决当前 PTA 页面上的这道编程题，并提交直到通过。步骤：',
  '1. 先用 read_problem 读题面（看清输入输出格式和样例）。',
  '2. 写好 Python 代码后用 write_editor_code 写进作答区。作答区里已经有代码的话，先读一遍，错了就改。',
  '3. 用 compile_and_run_python 拿题面样例跑一遍（stdin 用题面给的样例输入），输出不对就改，直到样例通过。',
  '4. 用 submit_answer 提交。**提交前先用 close_dialogs 关掉可能残留的提交结果 dialog**。',
  '5. 用 read_judge_result 等判题结论。如果结论是 PC（部分正确）或 WA，继续改代码再提交。',
  '6. 拿到 AC 就停下来，把最终代码贴给我。',
  '**必须真的提交**：没拿到 AC 之前不要结束回答，不要只做分析就收工。',
  '不要问我问题（我授权你直接改作答区），自己判断。',
].join('\n');

/** 换个提示词跑（比如代码填空题要单独交代） */
const PROMPT_OVERRIDE = process.env.PTA_PROMPT;

/* ---------- 最小 CDP 客户端 ---------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      for (const handler of this.handlers) handler(message);
    });
  }

  static async connect() {
    const version = await (await fetch(`${CDP_HTTP}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(handler) {
    this.handlers.push(handler);
  }

  /** 在某个 target 里求值（扁平协议：sessionId 直接跟在消息上） */
  async evaluate(sessionId, expression, contextId) {
    const params = { expression, awaitPromise: true, returnByValue: true };
    if (contextId) params.contextId = contextId;
    const result = await this.send('Runtime.evaluate', params, sessionId);
    if (result.exceptionDetails) {
      throw new Error(`页面里报错：${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    }
    return result.result?.value;
  }
}

/* ---------- 页面与扩展世界 ---------- */

async function attachTo(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/** 找到 pintia.cn 那个标签页，并接上它 */
async function ptaPage(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const page = targetInfos.find(
    (t) => t.type === 'page' && t.url.includes('pintia.cn') && !t.url.includes('extensions'),
  );
  if (!page) throw new Error('没找到 pintia.cn 的标签页');
  const sessionId = await attachTo(cdp, page.targetId);
  return { sessionId, targetId: page.targetId };
}

/**
 * 全程收集执行上下文。
 *
 * 页面一导航，新的隔离世界就换了一个 id，而 CDP 只在「创建的时候」报一次
 * executionContextCreated —— 导航发生在我们挂监听之前的话，那个事件就白丢了。
 * 所以监听从头到尾挂着，需要时再从里面挑最新的那个。
 */
function trackContexts(cdp, pageSession) {
  const contexts = [];
  cdp.on((message) => {
    if (message.method === 'Runtime.executionContextCreated' && message.sessionId === pageSession) {
      contexts.push(message.params.context);
    }
  });
  return () => {
    // 最新的那个才是当前页面的（导航后旧 id 会失效）
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      if (contexts[index].name === 'PTA 助手') return contexts[index].id;
    }
    return null;
  };
}

/** background 的 service worker：它才有 chrome.tabs（content script 里没有） */
async function serviceWorker(cdp, pageSession, contextId) {
  // MV3 的 service worker 是懒启动的：先从 content script 发个消息把它叫醒
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
    if (worker) return attachTo(cdp, worker.targetId);
    try {
      await cdp.evaluate(
        pageSession,
        `chrome.runtime.sendMessage({ type: 'settings/get' }).catch(() => 0)`,
        contextId,
      );
    } catch {
      // 页面正在载入，下一轮再试
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('插件的 service worker 没起来');
}

/** 打开悬浮窗：service worker 空闲会被回收，session 失效时要重新接一次 */
async function openPanel(cdp, pageSession, contextId, url) {
  // 可能同时开着好几个 PTA 标签页，要按题目地址挑对的那个
  const marker = url.match(/problemSetProblemId=(\d+)/)?.[1] ?? url;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // 悬浮窗是开关式的：已经开着就别再 toggle（否则反而关掉了）
    const opened = await cdp.evaluate(
      pageSession,
      `(() => {
        const host = document.querySelector('#pta-assistant-host');
        return !!(host && host.shadowRoot && host.shadowRoot.querySelector('textarea.composer__input'));
      })()`,
    );
    if (opened) return;
    let swSession;
    try {
      swSession = await serviceWorker(cdp, pageSession, contextId);
      await cdp.evaluate(
        swSession,
        `(async () => {
          const tabs = await chrome.tabs.query({ url: 'https://pintia.cn/*' });
          const target = tabs.find((t) => t.url.includes(${JSON.stringify(marker)})) || tabs[0];
          if (!target) return 'no tab';
          await chrome.tabs.sendMessage(target.id, { type: 'toggle-panel' });
          return 'toggled';
        })()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1200));
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/** 重新载入页面：面板的对话状态是从存盘恢复的，清了存盘要重载一次才干净 */
async function reloadPage(cdp, pageSession) {
  await cdp.evaluate(pageSession, `(() => { location.reload(); return 'reload'; })()`);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const ready = await cdp.evaluate(pageSession, `(() => document.readyState)()`);
      if (ready === 'complete') return;
    } catch {
      // 还在跳
    }
  }
}

/** 跳到某个题目页面，等它真的加载完 */
async function gotoProblem(cdp, pageSession, url) {
  await cdp.evaluate(pageSession, `(() => { location.href = ${JSON.stringify(url)}; return 'nav'; })()`);
  const marker = url.match(/problemSetProblemId=(\d+)/)?.[1] ?? '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const state = await cdp.evaluate(
        pageSession,
        `(() => ({ url: location.href, title: document.title }))()`,
      );
      if (state.url.includes(marker) && state.title.includes(' - ')) return state.title.split(' - ')[0].trim();
    } catch {
      // 正在跳转，下一轮再试
    }
  }
  return '(不知道标题)';
}

/** 在悬浮窗的输入框里打字并点「发送」——和用户操作完全一样 */
async function typeAndSend(cdp, pageSession, text) {
  await cdp.evaluate(
    pageSession,
    `(() => {
      const host = document.querySelector('#pta-assistant-host');
      const root = host && host.shadowRoot;
      if (!root) throw new Error('悬浮窗没注入');
      const input = root.querySelector('textarea.composer__input');
      if (!input) throw new Error('悬浮窗没打开（找不到输入框）');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  await cdp.evaluate(
    pageSession,
    `(() => {
      const root = document.querySelector('#pta-assistant-host').shadowRoot;
      const button = Array.from(root.querySelectorAll('button'))
        .find((b) => (b.innerText || '').trim() === '发送');
      if (!button) throw new Error('找不到「发送」按钮');
      button.click();
      return 'sent';
    })()`,
  );
}

/* ---------- 读插件的持久化对话 ---------- */

const STORE_KEY = 'pta-assistant-chat';

function bucketKey(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

async function readStored(cdp, pageSession, contextId, key) {
  const raw = await cdp.evaluate(
    pageSession,
    `(async ({ storeKey, key }) => {
      const raw = await chrome.storage.local.get(storeKey);
      return JSON.stringify((raw[storeKey] || {})[key] || []);
    })(${JSON.stringify({ storeKey: STORE_KEY, key })})`,
    contextId,
  );
  return raw ? JSON.parse(raw) : [];
}

async function clearStored(cdp, pageSession, contextId, key) {
  await cdp.evaluate(
    pageSession,
    `(async ({ storeKey, key }) => {
      const raw = await chrome.storage.local.get(storeKey);
      const store = raw[storeKey] || {};
      delete store[key];
      await chrome.storage.local.set({[storeKey]: store});
      return 'cleared';
    })(${JSON.stringify({ storeKey: STORE_KEY, key })})`,
    contextId,
  );
}

/* ---------- 一轮对话 ---------- */

const VERDICT = /判题结论：([A-Z]+)/g;

function summarize(messages) {
  const tools = messages
    .filter((message) => message.role === 'tool')
    .map((message) => [message.toolName || '?', message.content || '']);
  let verdict = null;
  for (const [, result] of tools) {
    for (const match of result.matchAll(VERDICT)) verdict = match[1];
  }
  const final = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && (message.content || '').trim());
  return { tools, verdict, final: final ? final.content : '' };
}

/** 面板是不是还忙：忙的时候「发送」按钮会变成「停止」 */
async function panelBusy(cdp, pageSession) {
  try {
    const state = await cdp.evaluate(
      pageSession,
      `(() => {
        const host = document.querySelector('#pta-assistant-host');
        const root = host && host.shadowRoot;
        if (!root) return 'no panel';
        const button = Array.from(root.querySelectorAll('button'))
          .find((b) => ['发送', '停止'].includes((b.innerText || '').trim()));
        if (!button) return 'no button';
        return (button.innerText || '').trim();
      })()`,
    );
    return state === '停止';
  } catch {
    return false;
  }
}

async function waitForTurn(cdp, pageSession, contextId, key, timeoutMs = 420_000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    // 面板自己最清楚忙不忙（按钮上写着「停止」就是还在跑）
    if (await panelBusy(cdp, pageSession)) continue;
    try {
      const messages = await readStored(cdp, pageSession, contextId, key);
      if (!messages.length) continue;
      last = messages;
      // 还有工具在跑就继续等
      if (messages.some((message) => message.toolStatus === 'running')) continue;
      // 还在流式输出就继续等（存盘里记着 streaming 标记）
      if (messages.some((message) => message.streaming)) continue;
      // 这一轮结束的标志：最后一条是**不带 tool_calls** 的 assistant 消息（最终回答）
      const tail = messages[messages.length - 1];
      if (tail.role === 'assistant' && !(tail.toolCalls || []).length && (tail.content || '').trim()) {
        return messages;
      }
    } catch {
      // 页面正在重新载入（refresh_page），下一轮再试
    }
  }
  return last;
}

/* ---------- PTA 自己的提交记录（权威结论） ---------- */

async function readSubmissionList(cdp, pageSession, setId) {
  await cdp.evaluate(
    pageSession,
    `(() => { location.href = '/problem-sets/${setId}/exam/submissions'; return 'nav'; })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const rows = await cdp.evaluate(
    pageSession,
    `(() => {
      const out = [];
      for (const row of document.querySelectorAll('tr')) {
        const cells = Array.from(row.querySelectorAll('td')).map((c) => (c.innerText || '').trim());
        if (cells.length < 4) continue;
        const problem = cells.find((c) => /^\\d+-\\d+$/.test(c));
        const status = cells.find((c) => /Accepted|Wrong Answer|Partial|Runtime|Compile|Time Limit|Memory|Presentation|Non-zero/i.test(c));
        if (!problem || !status) continue;
        out.push({ problem, status, at: cells[0] });
      }
      return out;
    })()`,
  );
  return rows || [];
}

/* ---------- 主流程 ---------- */

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const urls = command === 'solve' ? rest : rest.slice(0, 1);
  if (!command || !urls.length) {
    console.log('用法：node scripts/pta-drive.mjs <read|solve|tools> <url>');
    process.exit(1);
  }

  const cdp = await Cdp.connect();
  const { sessionId: pageSession } = await ptaPage(cdp);
  await cdp.send('Runtime.enable', {}, pageSession);
  const currentContextId = trackContexts(cdp, pageSession);

  /** 等插件的隔离世界出现（页面刚导航过去时 content script 还没注入） */
  async function waitForExtensionWorld() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const id = currentContextId();
      if (id) return id;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('没找到插件的隔离世界（扩展没注入？）');
  }

  /** 清空这道题的存盘对话并重载页面，让面板从空白开始 */
  async function freshPanel(url) {
    const key = bucketKey(url);
    const contextId = await waitForExtensionWorld();
    await clearStored(cdp, pageSession, contextId, key);
    await openPanel(cdp, pageSession, contextId, url);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // 点「新会话」把面板里还留着的旧对话也清掉（它同时会清掉存盘的那份）
    await cdp.evaluate(
      pageSession,
      `(() => {
        const root = document.querySelector('#pta-assistant-host').shadowRoot;
        const button = Array.from(root.querySelectorAll('button'))
          .find((b) => (b.innerText || '').trim() === '新会话');
        if (!button) return 'no reset button';
        button.click();
        return 'reset';
      })()`,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    return { contextId, key };
  }

  if (command === 'read') {
    await gotoProblem(cdp, pageSession, urls[0]);
    const { contextId, key } = await freshPanel(urls[0]);
    await typeAndSend(cdp, pageSession, '调用 read_problem 工具，把返回结果原样贴出来，不要做别的。');
    const messages = await waitForTurn(cdp, pageSession, contextId, key, 90_000);
    const { tools } = summarize(messages);
    const read = [...tools].reverse().find(([name]) => name === 'read_problem');
    console.log(read ? read[1] : '(没有拿到 read_problem 的结果)');
    return;
  }

  if (command === 'tools') {
    await gotoProblem(cdp, pageSession, urls[0]);
    const { contextId, key } = await freshPanel(urls[0]);
    await typeAndSend(
      cdp,
      pageSession,
      '依次调用这三个工具并把结果原样贴出来：read_problem、read_editor_code、close_dialogs。不要做别的。',
    );
    const messages = await waitForTurn(cdp, pageSession, contextId, key, 150_000);
    for (const [name, result] of summarize(messages).tools) {
      console.log(`--- ${name} ---\n${result}`);
    }
    return;
  }

  if (command === 'solve') {
    for (const url of urls) {
      const title = await gotoProblem(cdp, pageSession, url);
      console.log(`\n===== ${title} =====`);
      let contextId;
      let key;
      try {
        ({ contextId, key } = await freshPanel(url));
        await typeAndSend(cdp, pageSession, PROMPT_OVERRIDE || PROMPT);
      } catch (error) {
        console.log(`  出错：${error.message}`);
        continue;
      }
      const messages = await waitForTurn(cdp, pageSession, contextId, key);
      const { tools, verdict, final } = summarize(messages);
      for (const [name, result] of tools) {
        console.log(`  [${name}] ${result.split('\n')[0].slice(0, 130)}`);
      }
      console.log(`  => 插件读到的结论：${verdict || '（没拿到结论）'}`);
      console.log(`  => 最终回答：${final.slice(0, 400)}`);
    }

    const setId = urls[0].split('/problem-sets/')[1].split('/')[0];
    console.log('\n===== PTA 提交记录（权威结论） =====');
    for (const row of await readSubmissionList(cdp, pageSession, setId)) {
      console.log(`  ${row.problem.padEnd(8)} ${row.status.padEnd(20)} ${row.at}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
