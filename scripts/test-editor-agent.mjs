// 「作答区增强」页面 agent（src/background/editor-agent.ts 里的 EDITOR_AGENT_SOURCE）的 jsdom 测试。
//
// 思路和 scripts/test-pta-tools.mjs 一致：在 jsdom 里搭一个假 CodeMirror 6，
// EditorView 挂在 .cm-content 的 cmTile.view 上（PTA 页面的真实位置），
// 源码用页面 realm 的 AsyncFunction 执行（先注入 __args 再跑源码字符串），
// 和插件里 injectScript 的注入方式同构。
// 隔离世界 ↔ agent 的来回都走 window.postMessage / window.dispatchEvent('message')。
//
// 用法：node scripts/test-editor-agent.mjs
import { JSDOM } from 'jsdom';
import { EDITOR_AGENT_SOURCE } from '../src/background/editor-agent.ts';
import { RAINBOW_COLORS } from '../src/shared/code-brackets.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 下标 1 必须是括号：rainbow 消息只给「真的是括号字符」的位置上色
const INITIAL_TEXT = 'f(1);\nf(2);';
const TOKEN = 'test-token-editor-agent';
const NOTE = '内置编译器只支持 C，其他语言不做实时检查';
const ERROR_BOX = { from: 0, to: 1, severity: 'error', message: "expected ';'", advice: '少分号' };
const WARN_BOX = { from: 0, to: 1, severity: 'warning', message: 'w', advice: 'a' };

const INSTALL_ARGS = {
  token: TOKEN,
  version: 1,
  docs: { printf: { signature: 'int printf(const char *fmt, ...);', summary: '按格式串输出' } },
  features: { format: true, rainbow: true, check: true, hover: true },
};

/**
 * 假 CodeMirror 6。只实现 agent 真正用到的那几个接口：
 *   state.doc（length / toString / sliceString / lineAt）、dispatch、domAtPos、
 *   coordsAtPos、posAtCoords、visibleRanges、scrollDOM。
 * DOM 结构按真机：.cm-editor > .cm-scroller > .cm-content[contenteditable]
 * 里面每行一个 .cm-line，行内每个字符一个 span（agent 只给单字符 span 上色）。
 */
function createEditorPage(initialText) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-1 函数题</title></head><body></body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/problems/1150901824503297/description',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  const document = window.document;

  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.setAttribute('contenteditable', 'true');
  scroller.appendChild(content);
  editor.appendChild(scroller);

  // 真机结构：编辑器在 CodingProblemAnswerForm 里，后面紧跟「Test Case」状态栏。
  // 工具栏应该嵌进这条栏，而不是浮在它上面。
  const form = document.createElement('div');
  form.className = 'CodingProblemAnswerForm';
  form.appendChild(editor);
  const bottomBar = document.createElement('div');
  bottomBar.className = 'testcase-bar';
  bottomBar.id = 'testcase-bar';
  const testCaseButton = document.createElement('button');
  testCaseButton.type = 'button';
  testCaseButton.textContent = 'Test Case';
  bottomBar.appendChild(testCaseButton);
  document.body.append(form, bottomBar);

  const rect = (width, height, top) => ({
    width, height, top, bottom: top + height, left: 0, right: width, x: 0, y: top,
    toJSON: () => ({}),
  });
  form.getBoundingClientRect = () => rect(600, 240, 0);
  editor.getBoundingClientRect = () => rect(600, 200, 0);
  bottomBar.getBoundingClientRect = () => rect(600, 32, 200);

  let doc = initialText;
  let lines = [];
  // 每个字符下标对应的 span 与其单字符文本节点；换行位置留 null
  let chars = [];

  const splitLines = (value) => {
    const out = [];
    let from = 0;
    for (const text of value.split('\n')) {
      out.push({ from, to: from + text.length, text });
      from += text.length + 1;
    }
    return out;
  };
  const lineIndexAt = (pos) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (pos >= lines[index].from) return index;
    }
    return 0;
  };

  // 真 CM6 在事务之后重建视图 DOM。这里同样重建 cm-content 的子节点，
  // 但保留 .cm-content 元素本身：agent 靠 el/view 的引用判断「换没换编辑器」，
  // 换掉节点就会被当成 SPA 换题重新 bind，噪声很大。
  const render = () => {
    content.textContent = '';
    lines = splitLines(doc);
    chars = new Array(doc.length).fill(null);
    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'cm-line';
      for (let index = 0; index < line.text.length; index += 1) {
        const span = document.createElement('span');
        span.textContent = line.text[index];
        lineEl.appendChild(span);
        chars[line.from + index] = { span, text: span.firstChild };
      }
      content.appendChild(lineEl);
    }
  };

  const docFacade = () => ({
    length: doc.length,
    toString: () => doc,
    sliceString: (from, to) => doc.slice(from, to),
    lineAt: (pos) => lines[lineIndexAt(pos)],
  });

  const view = {
    get state() {
      return { doc: docFacade(), readOnly: false };
    },
    get visibleRanges() {
      return [{ from: 0, to: doc.length }];
    },
    // agent 在上面挂 scroll 监听；EventTarget 就够
    scrollDOM: new window.EventTarget(),
    dispatch: (transaction) => {
      const change = transaction && transaction.changes;
      if (!change || typeof change.from !== 'number') return;
      // 和 test-pta-tools 一样：{from, insert} 不写 to 就表示在 from 处插入
      const to = typeof change.to === 'number' ? change.to : change.from;
      doc = doc.slice(0, change.from) + (change.insert ?? '') + doc.slice(to);
      render();
    },
    domAtPos: (pos) => {
      const char = chars[pos];
      if (char) return { node: char.text, offset: 0 };
      // 换行位置没有 span：交出所在行元素，agent 见到多字符节点会自己跳过
      const index = Math.min(lineIndexAt(pos), content.children.length - 1);
      return { node: content.children[index], offset: 0 };
    },
    coordsAtPos: (pos) => {
      const top = lineIndexAt(pos) * 18;
      return { left: pos * 7, right: pos * 7 + 7, top, bottom: top + 18 };
    },
    // coordsAtPos 的逆：x/7 就是字符下标（含换行，反正是近似）
    posAtCoords: (coords) => Math.max(0, Math.min(doc.length, Math.floor(coords.x / 7))),
  };
  // agent 就是从 .cm-content 的 cmTile 上拿 EditorView（PTA 的实际位置）
  content.cmTile = { view };

  render();

  return {
    window,
    document,
    content,
    bottomBar,
    text: () => doc,
    close: () => window.close(),
  };
}

/** 跟 injectScript 一样：先挂 __args，再用页面 realm 的 AsyncFunction 跑源码 */
async function runAgent(page, args) {
  const AsyncFunction = Object.getPrototypeOf(page.window.eval('(async function () {})')).constructor;
  const body = 'globalThis.__ptaAborted = false; const __args = ' + JSON.stringify(args) + '; ' + EDITOR_AGENT_SOURCE;
  return await new AsyncFunction(body)();
}

/** 收 agent → 隔离世界的消息 */
function listen(window) {
  const inbox = [];
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && data.__ptaEditorAssist === TOKEN) inbox.push(data);
  });
  return inbox;
}

/** 发 隔离世界 → agent 的消息（agent 会检查 event.source === window） */
function send(window, payload) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { __ptaEditorAssist: TOKEN, ...payload },
    source: window,
  }));
}

// jsdom 会把 #b06d00 这类颜色序列化成 rgb(...)，用同一个元素换算，避免手写期望值
function cssColor(window, value) {
  const probe = window.document.createElement('div');
  probe.style.color = value;
  return probe.style.color;
}

async function runScenario(page) {
  const { window, document } = page;
  const inbox = listen(window);

  const first = await runAgent(page, INSTALL_ARGS);
  check(
    '第一次注入返回 installed 与 token',
    !!first && first.status === 'installed' && first.token === TOKEN,
    first,
  );

  await sleep(120);
  check('绑定编辑器后立刻发出 hello', inbox.some((message) => message.kind === 'hello'));

  // hello 之后 syncDoc(true) 用 setTimeout(350) 防抖，再留一点 postMessage 排队的时间
  await sleep(600);
  const docSyncs = inbox.filter((message) => message.kind === 'doc');
  check(
    '停手后同步一次全文',
    docSyncs.length === 1 && docSyncs[0].text === INITIAL_TEXT,
    docSyncs.map((message) => message.text),
  );

  const layer = document.getElementById('pta-assist-editor-layer');
  const toolbar = document.getElementById('pta-assist-bar');
  const buttons = toolbar ? [...toolbar.querySelectorAll('button')].map((node) => node.textContent.trim()) : [];
  check('工具栏里有「整理代码」按钮', !!layer && !!toolbar && buttons.includes('整理代码'), buttons);

  const bar = toolbar;
  const badge = bar ? bar.querySelector('div') : null;
  check('工具栏上有诊断徽标', !!badge);

  // ── 彩虹括号 ──────────────────────────────────────────────────────────
  send(window, { kind: 'rainbow', text: page.text(), marks: [{ at: 1, depth: 1 }] });
  // 上色发生在 agent 的定时巡检里（每 500ms 一次），等一轮
  await sleep(650);
  const marked = page.content.querySelectorAll('.cm-line span')[1];
  const expectedColor = cssColor(window, RAINBOW_COLORS[1 % RAINBOW_COLORS.length]);
  check(
    '彩虹括号给下标 1 的括号上了对应层的颜色',
    !!marked && marked.textContent === '(' && marked.style.color === expectedColor,
    marked && { text: marked.textContent, color: marked.style.color },
  );

  // ── 整理代码：过期保护 / 正常应用 ──────────────────────────────────────
  send(window, { kind: 'format-apply', source: '不匹配的原文', text: 'X', summary: 's' });
  check('source 对不上的整理结果被丢掉（不覆盖用户刚敲的内容）', page.text() === INITIAL_TEXT, page.text());

  send(window, { kind: 'format-apply', source: INITIAL_TEXT, text: 'Y', summary: '已整理 1 行' });
  check('source 对得上时把整理结果写回编辑器', page.text() === 'Y', page.text());

  // agent 的 state.text 要等下一轮巡检才更新成 'Y'；不更新的话下一批诊断会被当成过期消息扔掉
  await sleep(650);

  // ── 诊断：波浪线 + 徽标 ───────────────────────────────────────────────
  send(window, { kind: 'diagnostics', text: 'Y', boxes: [ERROR_BOX, WARN_BOX] });
  check(
    '徽标报出 1 个错误和 1 个警告',
    badge.textContent.includes('1 个错误') && badge.textContent.includes('1 个警告'),
    badge.textContent,
  );

  await sleep(650);
  // jsdom 把 `background:#fff` 这种简写序列化成 backgroundImage: 'none'，
  // 只判「非空」会把徽标也算进来；按 url(...) 判才是真的「有图片背景」，也就是波浪线
  const isWave = (node) => node.tagName === 'DIV' && node.style.backgroundImage.startsWith('url(');
  const squiggles = layer ? [...layer.querySelectorAll('div')].filter(isWave) : [];
  // 只有 error 画波浪线：warning 只进徽标计数，不画线
  check('只有 error 画波浪线', squiggles.length === 1, squiggles.length);

  send(window, { kind: 'diagnostics', text: 'Y', boxes: [], note: NOTE });
  check('没做检查时徽标换成 note 文案', badge.textContent === NOTE, badge.textContent);

  // 空 boxes 会把波浪线和命中矩形一起清掉。真机上下一批编译结果几百毫秒内就回来，
  // 这里补发一次带诊断的结果来等价模拟「等下一批结果」，再测悬停命中。
  send(window, { kind: 'diagnostics', text: 'Y', boxes: [ERROR_BOX, WARN_BOX] });
  await sleep(650);
  page.content.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
  const tip = document.getElementById('pta-assist-tip');
  check(
    '鼠标压在波浪线上弹出报错原文与中文建议',
    !!tip
      && tip.style.display !== 'none'
      && tip.textContent.includes("expected ';'")
      && tip.textContent.includes('少分号'),
    tip && { display: tip.style.display, text: tip.textContent },
  );

  // ── 重复注入 ─────────────────────────────────────────────────────────
  const second = await runAgent(page, INSTALL_ARGS);
  check('同一个 token 再注入一次直接复用', !!second && second.status === 'already', second);
  check(
    '页面上只有一层浮层（没有叠出第二层工具栏）',
    document.querySelectorAll('#pta-assist-editor-layer').length === 1,
    document.querySelectorAll('#pta-assist-editor-layer').length,
  );
  const attachedBar = document.getElementById('pta-assist-bar');
  const toolbarSlot = document.getElementById('pta-assist-bar-slot');
  check(
    '工具栏嵌进 Test Case 父状态栏',
    !!attachedBar && !!toolbarSlot &&
      attachedBar.parentElement === toolbarSlot &&
      toolbarSlot.parentElement === page.bottomBar &&
      attachedBar.style.position === 'static',
    attachedBar && { parent: attachedBar.parentElement?.id, position: attachedBar.style.position },
  );
}

const page = createEditorPage(INITIAL_TEXT);
try {
  await runScenario(page);
} finally {
  // agent 起了 500ms 的巡检 interval，不关窗 node 不会退出
  page.close();
}
console.log('\n页面 agent 的行为通过。');
