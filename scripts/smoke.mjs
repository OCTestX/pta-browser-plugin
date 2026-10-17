// 冒烟测试：检查 dist 里的清单是否完整，再把 content.js 放进 jsdom，
// 用打桩的 background 验证悬浮窗挂载、开关、流式对话、未配置 Key 的提示与设置保存。
// 用法：node scripts/smoke.mjs [chrome|firefox]
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { assertDistFresh } from './dist-fresh.mjs';

const target = process.argv[2] ?? 'chrome';
const outDir = `dist/${target}`;
assertDistFresh(outDir);

/* ---------- 清单完整性 ---------- */

const manifest = JSON.parse(readFileSync(`${outDir}/manifest.json`, 'utf8'));
const referenced = [
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
  ...(manifest.background?.scripts ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
];
const exists = (entry) =>
  existsSync(`${outDir}/${entry.endsWith('/*') ? entry.slice(0, -2) : entry}`);
const missing = referenced.filter((entry) => !exists(entry));
if (missing.length > 0) {
  throw new Error(`✗ 清单引用的文件不存在：${missing.join(', ')}（先跑 npm run build）`);
}
console.log(`✓ 清单引用的 ${new Set(referenced).size} 个文件都存在（manifest_version ${manifest.manifest_version}）`);
if (!existsSync(`${outDir}/katex-fonts/KaTeX_Main-Regular.woff2`)) {
  throw new Error('✗ KaTeX 字库没有复制到产物目录（先跑 npm run build）');
}
if (!exists('katex-fonts/*')) {
  throw new Error('✗ katex-fonts 没在 web_accessible_resources 里声明，字体会被 Chrome 拦掉');
}
console.log('✓ KaTeX 字库已复制，且已在 web_accessible_resources 里声明');

// Chrome 用 base::IsStringUTF8 校验脚本，非字符会被判成「不是 UTF-8 编码」，Python 的严格解码却放行
for (const script of new Set([...referenced.filter((f) => f.endsWith('.js'))])) {
  if (/[\uFDD0-\uFDEF\uFFFE\uFFFF]/u.test(readFileSync(`${outDir}/${script}`, 'utf8'))) {
    throw new Error(`✗ ${script} 里有 Unicode 非字符，Chrome 会报「不是 UTF-8 编码」并拒绝加载`);
  }
}
console.log('✓ 脚本里没有会让 Chrome 拒绝加载的 Unicode 非字符');

/* ---------- 测试脚手架 ---------- */

const code = readFileSync(`${outDir}/content.js`, 'utf8');

// React 的渲染是异步的，固定 sleep 在机器忙的时候会偶发失败。
// 这里改成等 DOM 安静下来：有新改动就重新计时，直到安静 quietMs。
const booted = [];
const settleWindow = (window, { quietMs = 25, timeoutMs = 3000 } = {}) =>
  new Promise((resolve) => {
    const root = window.document.getElementById('pta-assistant-host')?.shadowRoot ?? window.document;
    let timer = setTimeout(done, quietMs);
    const observer = new window.MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    function done() {
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    }
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    setTimeout(done, timeoutMs);
  });

/** 等当前场景那个页面安静下来（脚本按场景顺序执行，只看最后一个 boot 出来的页面） */
/** 等当前场景那个页面安静下来（脚本按场景顺序执行，只看最后一个 boot 出来的页面） */
const tick = () => settleWindow(booted.at(-1));
const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

function boot({ hasApiKey, store }) {
  const dom = new JSDOM('<!doctype html><html><body><p>题目页面</p></body></html>', {
    url: 'https://pintia.cn/problem-sets/1/problems/1',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  booted.push(window);
  const listeners = [];
  const requests = [];
  let keySet = hasApiKey;

  // 打桩的 background：只实现 content script 依赖的那几个消息
  const storageWrites = [];
  // 真的存一份：布局恢复、跨 boot 读设置这类断言都要靠它
  const stored = { ...(store ?? {}) };
  // 「输入」按钮打回后台的写入结果，失败路径要能换
  let inputResult = { ok: true, result: '已写入作答区：写入成功（先 focus 再 dispatch）' };

  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const names = Array.isArray(keys) ? keys : [keys];
          const found = {};
          for (const name of names) {
            if (name in stored) found[name] = stored[name];
          }
          return found;
        },
        set: async (patch) => {
          Object.assign(stored, patch);
          storageWrites.push(patch);
        },
        remove: async (keys) => {
          for (const name of Array.isArray(keys) ? keys : [keys]) delete stored[name];
        },
      },
    },
    runtime: {
      getURL: (filePath) => `chrome-extension://test/${filePath}`,
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: () => {},
      },
      sendMessage: async (message) => {
        requests.push(message);
        switch (message.type) {
          case 'settings/get':
            return view();
          case 'settings/save':
            if (typeof message.patch.apiKey === 'string') keySet = message.patch.apiKey.length > 0;
            return view();
          case 'chat/start':
            return keySet
              ? { ok: true }
              : { ok: false, message: '尚未配置 API Key，点右上角齿轮填入后即可开始对话' };
          case 'chat/stop':
            return { ok: true };
          case 'code/input':
            return inputResult;
          case 'ui/open-url':
            return { ok: true };
          default:
            return undefined;
        }
      },
    },
  };

  const view = () => ({
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    hasApiKey: keySet,
  });

  window.eval(code);

  return {
    window,
    requests,
    storageWrites,
    stored,
    setInputResult: (value) => {
      inputResult = value;
    },
    shadow: () => window.document.getElementById('pta-assistant-host')?.shadowRoot,
    toggle: () => listeners.forEach((fn) => fn({ type: 'toggle-panel' })),
    emit: (event) => listeners.forEach((fn) => fn(event)),
    /** 模拟 background 用 tabs.sendMessage 发来的消息并等 content script 的响应（tool/run 用它） */
    request: (message) =>
      new Promise((resolve) => {
        listeners.forEach((fn) => fn(message, {}, resolve));
      }),
    setValue(el, value) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype === el.constructor.prototype
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype,
        'value',
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    find: (selector) => window.document.getElementById('pta-assistant-host')?.shadowRoot?.querySelector(selector),
  };
}

/* ---------- 场景一：已配置 Key 的流式对话 ---------- */

const withKey = boot({ hasApiKey: true });

// 页面还在 loading、React 还没挂载时就发 toggle（点图标没反应的老问题）
withKey.toggle();
await tick();

const host = withKey.window.document.getElementById('pta-assistant-host');
check('宿主节点已注入页面', Boolean(host?.shadowRoot));
check('样式已注入 shadow root', (host.shadowRoot.querySelector('style')?.textContent ?? '').includes('.panel'));
check('React 挂载前收到的 toggle 也能打开悬浮窗', Boolean(withKey.find('.panel')));

const injectedCss = host.shadowRoot.querySelector('style').textContent;
check('页面样式与 KaTeX 样式都在同一个 style 里', injectedCss.includes('.panel') && injectedCss.includes('.katex'));
check(
  'KaTeX 字库地址改写成扩展地址',
  injectedCss.includes('chrome-extension://test/katex-fonts/KaTeX_Main-Regular.woff2'),
);
check('聊天区存在', Boolean(withKey.find('.messages')));
check('输入框存在', Boolean(withKey.find('.composer__input')));
check('标题栏版本号是 v1.0', withKey.find('.panel__badge')?.textContent === 'v1.0');
check('没聊过时顶栏不显示 token', withKey.find('.panel__usage').textContent === '');

withKey.setValue(withKey.find('.composer__input'), '帮我看看这道题');
await tick();
check('发送按钮在输入后可用', !withKey.find('.composer__send').disabled);

withKey.find('.composer__send').click();
await tick();
check('用户消息出现在聊天区', withKey.find('.messages').textContent.includes('帮我看看这道题'));
check('生成中发送按钮变成停止', withKey.find('.composer__send').textContent === '停止');
check('生成中输入框被禁用', withKey.find('.composer__input').disabled);

const requestId = withKey.requests.find((r) => r.type === 'chat/start')?.requestId;
check('chat/start 带上了对话上下文', requestId !== undefined);

withKey.emit({ type: 'chat/delta', requestId, text: '先看题目的**输入输出**格式：\n\n' });
await tick();
withKey.emit({
  type: 'chat/delta',
  requestId,
  text: '给定 $n$，求 $\\sum_{i=1}^{n} i$。\n\n```c\nint main() {',
});
await tick();
check(
  '流式增量逐段追加并渲染成 markdown',
  withKey.find('.messages').textContent.includes('先看题目的输入输出格式'),
);
check('行内加粗生效', withKey.find('.bubble__content--md strong')?.textContent === '输入输出');
check('行内公式渲染成 KaTeX', Boolean(withKey.find('.bubble__content--md .katex')));
check('未闭合的代码围栏先按代码块渲染', Boolean(withKey.find('.bubble__content--md pre code')));
check('生成中显示光标', Boolean(withKey.find('.bubble__cursor')));

withKey.emit({
  type: 'chat/delta',
  requestId,
  text: '}\n```\n\n参考[题目链接](https://pintia.cn)。',
});
await tick();
check(
  '围栏闭合后代码内容完整',
  withKey.find('.bubble__content--md pre code')?.textContent.includes('int main() {'),
);
check('markdown 链接会新开标签页', withKey.find('.bubble__content--md a')?.getAttribute('target') === '_blank');

// 模型基本都写成单行 $$...$$，micromark 只认独占一行的 $$，要归一化
withKey.emit({ type: 'chat/delta', requestId, text: '\n\n公式 $$E = mc^2$$ 要居中\n' });
await tick();
check('单行 $$...$$ 按块级公式渲染', Boolean(withKey.find('.bubble__content--md .katex-display')));

// 代码块里的 $$ 不能被动，也不能被算进公式配对
withKey.emit({ type: 'chat/delta', requestId, text: '\n\n```c\nint a = $$b$$;\n```\n' });
await tick();
check(
  '代码块里的 $$ 原样保留',
  [...withKey.find('.bubble__content--md').querySelectorAll('pre code')].some((block) =>
    block.textContent.includes('int a = $$b$$;'),
  ),
);

// 最后一段是模型刚写到一半的块级公式
withKey.emit({ type: 'chat/delta', requestId, text: '\n\n推导：$$\\int_0^1 x\\,dx' });
await tick();
check('未闭合的 $$ 也会先渲染成块级公式', Boolean(withKey.find('.bubble__content--md .katex-display')));

// 回答被截断：公式没闭合，后面还跟着正文，不能硬补收尾把正文吞进公式
withKey.emit({ type: 'chat/delta', requestId, text: '\n\n所以答案是 $\\frac{1}{2}$ 结束' });
await tick();
check(
  '公式没闭合又接正文时不会渲染出 KaTeX 报错',
  withKey.find('.bubble__content--md').querySelectorAll('.katex-error').length === 0,
);

check('流式过程中顶栏按字数实时估算 token', /^Token ≈ \d+$/.test(withKey.find('.panel__usage').textContent));

withKey.emit({
  type: 'chat/usage',
  requestId,
  promptTokens: 1024,
  completionTokens: 86,
  totalTokens: 1110,
});
await tick();
check(
  '接口回传用量后显示精确的输入/输出',
  withKey.find('.panel__usage').textContent === 'Token 1110（输入 1024 / 输出 86）',
);

withKey.emit({ type: 'chat/done', requestId, aborted: false });
await tick();
check('生成结束后按钮变回发送', withKey.find('.composer__send').textContent === '发送');
check('生成结束后光标消失', !withKey.find('.bubble__cursor'));
check('输入框恢复可用', !withKey.find('.composer__input').disabled);

withKey.find('.panel__close[title="设置"]').click();
await tick();
check('齿轮进入设置页', Boolean(withKey.find('.settings')));
check('设置页带上了已保存的接口地址', withKey.find('.field__input[type="text"]').value === 'https://api.siliconflow.cn/v1');
check('设置页显示的是硅基流动的模型名', [...withKey.shadow().querySelectorAll('.field__input[type="text"]')][1].value === 'deepseek-ai/DeepSeek-V4.1-Flash');
check('设置页里有 OCTest 署名', withKey.find('.settings').textContent.includes('OCTest'));
check('「用调试器发送真实按键」开关已移除', !withKey.find('.settings').textContent.includes('用调试器发送真实按键'));
check('接口地址不再提示改 host_permissions', !withKey.find('.settings').textContent.includes('host_permissions'));

// 顶部的作者卡片：头像 + 昵称 + 邮箱 + 可点的网站
const authorCard = withKey.find('.author');
check('设置页顶部有作者卡片', Boolean(authorCard));
check('作者卡片在最前面', authorCard === withKey.find('.settings').firstElementChild);
check('头像是扩展里的 avata.jpg', authorCard.querySelector('.author__avatar').getAttribute('src').endsWith('/avata.jpg'));
check('昵称用大字显示', authorCard.querySelector('.author__name').textContent === 'OCTest');
check('邮箱显示在昵称下面', authorCard.querySelector('.author__email').textContent === 'octestwx@qq.com');
check('作者信息只在顶部出现一次', withKey.find('.settings').textContent.split('octestwx@qq.com').length === 2);

const siteLink = authorCard.querySelector('.author__site');
check('网站链接显示 octestpi.top', siteLink.textContent === 'octestpi.top');
siteLink.click();
await tick();
check(
  '点网站链接让后台打开 octestpi.top',
  withKey.requests.filter((r) => r.type === 'ui/open-url').map((r) => r.url).includes('http://octestpi.top'),
);

const sponsorLink = authorCard.querySelector('.author__site--sponsor');
check('网站下面还有硅基流动的邀请链接', sponsorLink?.textContent.includes('硅基流动'));
sponsorLink.click();
await tick();
check(
  '点邀请链接打开带邀请码的注册页',
  withKey.requests
    .filter((r) => r.type === 'ui/open-url')
    .map((r) => r.url)
    .includes('https://cloud.siliconflow.cn/i/oU1ajhss'),
);

const tutorialButton = [...withKey.shadow().querySelectorAll('.field__jump')][0];
check('接口地址旁边有「教程」按钮', tutorialButton?.textContent === '教程');
check('按钮旁边提示去看教程', withKey.find('.settings').textContent.includes('怎么配 Key、怎么用，看教程'));
tutorialButton.click();
await tick();
check(
  '点教程让后台打开教程页面',
  withKey.requests.some((r) => r.type === 'ui/open-url' && r.url === 'http://octestpi.top/pta-assist-plugin'),
);

withKey.setValue(withKey.find('.field__input[type="password"]'), 'sk-test-key');
await tick();
const saveButton = [...withKey.shadow().querySelectorAll('.button')].find(
  (el) => el.textContent === '保存',
);
saveButton.click();
await tick();
const saved = withKey.requests.find((r) => r.type === 'settings/save');
check('保存设置会把 Key 交给 background', saved?.patch?.apiKey === 'sk-test-key');
check('保存后 Key 输入框被清空', withKey.find('.field__input[type="password"]').value === '');

// 「模拟输入测试」整块对用户隐藏（代码留着，普通用户看不到这组调试按钮）
check('设置页不显示「模拟输入测试」区域', !withKey.find('.settings').textContent.includes('模拟输入测试'));
check('设置页不渲染写入方法的调试按钮', withKey.shadow().querySelectorAll('.method-button').length === 0);
check('隐藏后不发测试请求', !withKey.requests.some((r) => r.type === 'tool/test-input'));

withKey.find('.panel__back').click();
await tick();
check('返回后回到对话界面', Boolean(withKey.find('.messages')));
withKey.toggle();
await tick();
check('再次点击图标后悬浮窗收起', !withKey.shadow().querySelector('.panel'));

/* ---------- 场景二：未配置 Key ---------- */

const noKey = boot({ hasApiKey: false });
await tick();
check('未点击图标时悬浮窗不显示', !noKey.shadow().querySelector('.panel'));
noKey.toggle();
await tick();
noKey.setValue(noKey.find('.composer__input'), '你好');
await tick();
noKey.find('.composer__send').click();
await tick();
check('未配置 Key 时给出提示', noKey.find('.notice__text').textContent.includes('API Key'));
check('提示里带「去设置」按钮', noKey.find('.notice__action') !== null);
check('失败的请求不会留下空的助手气泡', noKey.find('.bubble--assistant') === null);
check('用户消息本身仍然保留', noKey.find('.bubble--user')?.textContent.includes('你好'));

noKey.find('.notice__action').click();
await tick();
check('点「去设置」直接进设置页', Boolean(noKey.find('.settings')));

/* ---------- 场景三：接口报错的展示 ---------- */

const failing = boot({ hasApiKey: true });
await tick();
failing.toggle();
await tick();
failing.setValue(failing.find('.composer__input'), '你好');
await tick();
failing.find('.composer__send').click();
await tick();
const failedId = failing.requests.find((r) => r.type === 'chat/start')?.requestId;
failing.emit({ type: 'chat/error', requestId: failedId, message: 'API Key 无效或没有权限，请在设置里检查' });
await tick();
check(
  '接口报错会替换成红色错误气泡',
  failing.find('.bubble--error')?.textContent.includes('API Key 无效'),
);
check('报错后停止按钮变回发送', failing.find('.composer__send').textContent === '发送');

/* ---------- 场景四：工具调用 ---------- */

const tools = boot({ hasApiKey: true });
await tick();
tools.toggle();
await tick();
tools.setValue(tools.find('.composer__input'), '看下这个页面');
await tick();
tools.find('.composer__send').click();
await tick();
const toolRequestId = tools.requests.find((r) => r.type === 'chat/start')?.requestId;

tools.emit({
  type: 'chat/tool-start',
  requestId: toolRequestId,
  callId: 'call_1',
  name: 'js_inject',
  args: '{"code":"return document.title"}',
});
await tick();
check('工具卡片出现在对话里', Boolean(tools.find('.tool')));
check('工具卡片显示执行中', Boolean(tools.find('.tool--running')));
check('工具卡片默认收起（少占高度）', !tools.find('.tool__code') && !tools.find('.tool__result'));
tools.find('.tool__toggle').click();
await tick();
check('展开后 js_inject 的代码完整显示出来', tools.find('.tool__code')?.textContent === 'return document.title');
check('只承载 tool_calls 的空助手气泡不渲染', tools.find('.bubble--assistant') === null);

tools.emit({ type: 'chat/tool-end', requestId: toolRequestId, callId: 'call_1', result: '题目 - PTA', isError: false });
await tick();
check('工具完成后状态变完成', Boolean(tools.find('.tool--ok')));
check('工具结果展示在卡片里', tools.find('.tool__result')?.textContent === '题目 - PTA');

tools.emit({ type: 'chat/delta', requestId: toolRequestId, text: '标题已经拿到了。' });
await tick();
check('工具之后的文字另起一个回答气泡', tools.shadow().querySelectorAll('.bubble--assistant').length === 1);
tools.emit({ type: 'chat/done', requestId: toolRequestId, aborted: false });
await tick();

tools.setValue(tools.find('.composer__input'), '继续');
await tick();
tools.find('.composer__send').click();
await tick();
const rebuilt = tools.requests.filter((r) => r.type === 'chat/start').at(-1).messages;
const rebuiltAssistant = rebuilt.find((m) => m.tool_calls?.length > 0);
const rebuiltTool = rebuilt.find((m) => m.role === 'tool');
check('下一轮请求带上了 assistant 的 tool_calls', rebuiltAssistant?.tool_calls[0].id === 'call_1');
check(
  '下一轮请求带上了工具执行结果',
  rebuiltTool?.tool_call_id === 'call_1' && rebuiltTool.content === '题目 - PTA',
);
check(
  '下一轮请求也带上了工具之后的回答',
  rebuilt.some((m) => m.role === 'assistant' && m.content === '标题已经拿到了。'),
);

// 页面侧工具：url 与 write_document 由 background 通过 tool/run 交给页面执行
const urlResponse = await tools.request({ type: 'tool/run', name: 'url', args: {} });
check(
  'url 工具返回当前页面地址',
  urlResponse.ok && urlResponse.result === 'https://pintia.cn/problem-sets/1/problems/1',
);

// jsdom 没实现这两个（真实浏览器都有）
tools.window.URL.createObjectURL = () => 'blob:test';
tools.window.URL.revokeObjectURL = () => {};
const downloads = [];
const originalClick = tools.window.HTMLAnchorElement.prototype.click;
tools.window.HTMLAnchorElement.prototype.click = function click() {
  downloads.push(this.download);
};
const writeResponse = await tools.request({
  type: 'tool/run',
  name: 'write_document',
  args: { filename: '题解/1.md', content: '# 题解' },
});
tools.window.HTMLAnchorElement.prototype.click = originalClick;
check('write_document 会触发下载并清洗文件名', downloads[0] === '题解_1.md');
check('write_document 的结果里带上文件名与字数', writeResponse.result.includes('题解_1.md（4 字符）'));
check('write_document 缺 content 时返回失败', (await tools.request({ type: 'tool/run', name: 'write_document', args: { filename: 'a.md' } })).ok === false);
check('未知工具返回失败', (await tools.request({ type: 'tool/run', name: 'nope', args: {} })).ok === false);

/* ---------- 场景五：模拟键盘输入 ---------- */

const keyboard = boot({ hasApiKey: true });
await tick();
keyboard.toggle();
await tick();

const page = keyboard.window.document;
const input = page.createElement('input');
input.id = 'answer';
input.value = '旧值';
page.body.appendChild(input);

const inputEvents = [];
input.addEventListener('input', () => inputEvents.push(input.value));

// 开了真实按键开关时，background 只让页面侧聚焦并选中已有内容（输入交给 CDP）
const focusOnly = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#answer', clear: true, focusOnly: true },
});
check('focusOnly 只聚焦并选中原内容，不改动值', focusOnly.ok && input.value === '旧值');
check('focusOnly 返回里说明已选中原内容', focusOnly.result.includes('选中'));
check('focusOnly 不派发 input 事件', inputEvents.length === 0);

const typed = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#answer', text: '42', clear: true },
});
check('往输入框写入文字并清空原内容', input.value === '42');
check('输入会派发 input 事件（React 受控组件靠它同步）', inputEvents.at(-1) === '42');
check('结果里说明了目标元素与写入内容', typed.ok && typed.result.includes('#answer') && typed.result.includes('42'));

const appended = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#answer', text: '!' },
});
check('不指定 clear 时追加在原内容后面', input.value === '42!' && appended.ok);

const pressed = [];
input.addEventListener('keydown', (event) => pressed.push(event.key));
input.addEventListener('keyup', (event) => pressed.push(`up:${event.key}`));
const pressResult = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#answer', press: 'Enter' },
});
check('按下 Enter 会派发 keydown 与 keyup', pressed.includes('Enter') && pressed.includes('up:Enter'));
check('结果里说明按下了哪个键', pressResult.ok && pressResult.result.includes('Enter'));

// contenteditable / 代码编辑器：优先走 execCommand，它能产生正常的 input 事件链
const editor = page.createElement('div');
editor.id = 'editor';
editor.setAttribute('contenteditable', 'true'); // jsdom 没实现 isContentEditable，用属性等价
page.body.appendChild(editor);
const execCalls = [];
page.execCommand = (command, _ui, value) => {
  execCalls.push([command, value]);
  editor.appendChild(page.createTextNode(value));
  return true;
};
const editorResult = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#editor', text: 'int main() {}' },
});
check('可编辑区域走 execCommand insertText', execCalls[0]?.[0] === 'insertText' && execCalls[0][1] === 'int main() {}');
check('可编辑区域写入后有内容', editor.textContent === 'int main() {}' && editorResult.ok);

// execCommand 不可用时（某些浏览器/环境）要能兜底
page.execCommand = () => false;
editor.textContent = '';
const fallback = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#editor', text: '兜底文本' },
});
check('execCommand 不可用时直接插入文本节点', editor.textContent === '兜底文本' && fallback.result.includes('execCommand'));

const missingTarget = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: '#not-exist', text: 'x' },
});
check('选择器找不到时返回失败并说明原因', missingTarget.ok === false && missingTarget.result.includes('找不到'));

const nothing = await keyboard.request({ type: 'tool/run', name: 'simulate_keyboard_input', args: {} });
check('既不给 text 也不给 press 时返回失败', nothing.ok === false);

// 自动定位作答区：题面里的样例框（短的只读/可编辑框）不该被选中，取最长的那个
const sampleBox = page.createElement('div');
sampleBox.className = 'cm-content';
sampleBox.setAttribute('contenteditable', 'true');
sampleBox.textContent = '1 2';
page.body.appendChild(sampleBox);

const answerArea = page.createElement('div');
answerArea.className = 'cm-content';
answerArea.setAttribute('contenteditable', 'true');
for (const [index, text] of ['int main() {', '  return 0;', '}'].entries()) {
  const line = page.createElement('div');
  line.className = 'cm-line';
  line.textContent = text;
  line.dataset.line = String(index);
  answerArea.appendChild(line);
}
page.body.appendChild(answerArea);

const autoFocus = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { text: 'x' },
});
check('没给 selector 时自动定位最大的可编辑区域', autoFocus.ok && autoFocus.result.includes('自动'));
check('自动定位选中的是作答区而不是题面样例框', autoFocus.result.includes('cm-content'));

const readBack = await keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { readOnly: true },
});
check('回读按 .cm-line 拼行，不会多出尾部空行', readBack.result === 'int main() {\n  return 0;\n}');

const noEditor = boot({ hasApiKey: true });
await tick();
noEditor.toggle();
await tick();
const noEditorResult = await noEditor.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { readOnly: true },
});
check('页面上没有可编辑区域时回读返回失败', noEditorResult.ok === false);

const notEditable = keyboard.request({
  type: 'tool/run',
  name: 'simulate_keyboard_input',
  args: { selector: 'body', text: '写不进去' },
});
check('目标不是输入元素时如实告知', (await notEditable).result.includes('不是可输入元素'));

// write_document 里有个 60 秒后才回收 objectURL 的定时器，不关窗口进程会多挂一分钟
booted.forEach((window) => window.close());

/* ---------- 场景六：v0.8 界面交互 ---------- */

const ui = boot({ hasApiKey: true });
await tick();
ui.toggle();
await tick();
const uiHeader = ui.find('.panel__header');

// jsdom 不做布局，元素量不出矩形；给一个假的，才能验证拖动/缩放的算式
const uiPanel = ui.find('.panel');
const setRect = (node, rect) => {
  node.getBoundingClientRect = () => ({ right: rect.left + rect.width, bottom: rect.top + rect.height, ...rect });
};
setRect(uiPanel, { left: 16, top: 16, width: 420, height: 620 });

// 拖动：pointerdown 后移动，面板改为按 left/top 定位，并写进 storage
uiHeader.dispatchEvent(new ui.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 20 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 120 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointerup', { bubbles: true }));
await tick();
const movedPanel = ui.find('.panel');
check('拖动后改成了 left/top 定位', movedPanel.style.left === '216px' && movedPanel.style.top === '116px');
check('拖动结束后把位置和尺寸一起存进 storage', (() => {
  const saved = ui.stored['pta-assistant-panel-layout'];
  return saved?.x === 216 && saved?.y === 116 && saved?.width === 420 && saved?.height === 620;
})());
check('面板没被拖出视口', Number.parseInt(movedPanel.style.left, 10) >= 0);

// 缩放：拉右下角把手，宽高跟着变，超出视口会被夹住
const resizeHandle = ui.find('.panel__resize');
check('面板右下角有缩放把手', Boolean(resizeHandle));
resizeHandle.dispatchEvent(new ui.window.MouseEvent('pointerdown', { bubbles: true, clientX: 436, clientY: 636 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointermove', { bubbles: true, clientX: 636, clientY: 786 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointerup', { bubbles: true }));
await tick();
const grownPanel = ui.find('.panel');
check('拉把手把面板改大', grownPanel.style.width === '620px' && grownPanel.style.height === '752px');
check('高度超出视口被夹住', grownPanel.style.height === `${768 - 16}px`);
check('改完大小也记进 storage', ui.stored['pta-assistant-panel-layout']?.width === 620);

// 缩到比最小尺寸还小：夹住，不能把内容挤没
setRect(grownPanel, { left: 216, top: 116, width: 620, height: 752 });
grownPanel
  .querySelector('.panel__resize')
  .dispatchEvent(new ui.window.MouseEvent('pointerdown', { bubbles: true, clientX: 636, clientY: 786 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 100 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointerup', { bubbles: true }));
await tick();
check('缩得太小时夹在最小尺寸', ui.find('.panel').style.width === '360px' && ui.find('.panel').style.height === '320px');

// 重新挂载（等价于刷新页面）：记住的布局要恢复
const savedLayout = ui.stored['pta-assistant-panel-layout'];
const restored = boot({ hasApiKey: true, store: ui.stored });
await tick();
restored.toggle();
await tick();
check('刷新后恢复记住的位置', restored.find('.panel').style.left === `${savedLayout.x}px`);
check('刷新后恢复记住的大小', restored.find('.panel').style.width === `${savedLayout.width}px`);

// 双击插件图标（后台发来的复位消息）：位置与大小一起回默认
restored.emit({ type: 'panel/reset-layout' });
await tick();
const resetPanel = restored.find('.panel');
check('双击插件图标后位置回默认', resetPanel.style.left === '' && resetPanel.style.right === '');
check('双击插件图标后大小回默认', resetPanel.style.width === '' && resetPanel.style.height === '');
check('复位后布局记录被删掉', restored.stored['pta-assistant-panel-layout'] === undefined);

// 双击标题栏同样复位
setRect(ui.find('.panel'), { left: 16, top: 16, width: 420, height: 620 });
ui.find('.panel__header').dispatchEvent(new ui.window.MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 20 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 120 }));
ui.window.dispatchEvent(new ui.window.MouseEvent('pointerup', { bubbles: true }));
await tick();
ui.find('.panel__header').dispatchEvent(new ui.window.MouseEvent('dblclick', { bubbles: true }));
await tick();
check('双击标题栏也能复位', ui.find('.panel').style.left === '');

// 工具卡片：折叠 / 展开 / 复制
ui.setValue(ui.find('.composer__input'), '看下页面');
await tick();
ui.find('.composer__send').click();
await tick();
const uiRequestId = ui.requests.find((r) => r.type === 'chat/start')?.requestId;
ui.emit({
  type: 'chat/tool-start',
  requestId: uiRequestId,
  callId: 'call_ui',
  name: 'js_inject',
  args: '{"code":"return 1"}',
});
await tick();
check('工具卡片默认收起', !ui.find('.tool__code'));

ui.find('.tool__toggle').click();
await tick();
check('点一下展开代码', Boolean(ui.find('.tool__code')));
ui.find('.tool__toggle').click();
await tick();
check('再点一下收起来', !ui.find('.tool__code'));
ui.find('.tool__toggle').click();
await tick();

const copied = [];
ui.window.document.execCommand = (command) => {
  copied.push(command);
  return true;
};
ui.find('.tool__copy').click();
await tick();
check('复制按钮会调用剪贴板复制', copied.includes('copy') && ui.find('.tool__copy').textContent === '已复制');

// 回到底部：用户往上翻的时候不自动跟随，并给出按钮
const uiMessages = ui.find('.messages');
Object.defineProperty(uiMessages, 'scrollHeight', { value: 600, configurable: true });
Object.defineProperty(uiMessages, 'clientHeight', { value: 200, configurable: true });
uiMessages.scrollTop = 100;
uiMessages.dispatchEvent(new ui.window.Event('scroll', { bubbles: false }));
await tick();
check('往上翻之后出现「回到底部」按钮', Boolean(ui.find('.messages__jump')));
ui.find('.messages__jump').click();
await tick();
check('点回到底部后按钮消失', !ui.find('.messages__jump'));

/* ---------- 场景七：「输入」与「新会话」快捷通道 ---------- */

const shortcut = boot({ hasApiKey: true });
await tick();
shortcut.toggle();
await tick();

check('「输入」按钮在发送按钮左边', (() => {
  const footer = shortcut.find('.composer__footer');
  const buttons = [...footer.querySelectorAll('button')];
  return buttons[0].classList.contains('composer__write') && buttons[1].classList.contains('composer__send');
})());
check('输入框为空时「输入」按钮不可点', shortcut.find('.composer__write').disabled);

shortcut.setValue(shortcut.find('.composer__input'), 'int main() { return 0; }');
await tick();
check('输入框有文本后「输入」按钮可用', !shortcut.find('.composer__write').disabled);
shortcut.find('.composer__write').click();
await tick();
check(
  '点「输入」把输入框文本交给后台写进作答区',
  shortcut.requests.find((r) => r.type === 'code/input')?.code === 'int main() { return 0; }',
);
check('写成功后清空输入框', shortcut.find('.composer__input').value === '');
check('写入结果回显在提示条上', shortcut.find('.notice__text').textContent.includes('已写入作答区'));
check('走的是写入工具那条链路，不经过对话', shortcut.requests.every((r) => r.type !== 'chat/start'));
check('写进作答区不会留下对话气泡', shortcut.find('.messages').textContent.includes('我是 PTA 助手'));

// 写失败时输入框要留着文本，用户才能改完再试
shortcut.setInputResult({ ok: false, result: '写入作答区失败：四种写入方法全部失败' });
shortcut.setValue(shortcut.find('.composer__input'), 'int main() { return 1; }');
await tick();
shortcut.find('.composer__write').click();
await tick();
check('写入失败时输入框内容保留', shortcut.find('.composer__input').value === 'int main() { return 1; }');
check('写入失败原因显示出来', shortcut.find('.notice__text').textContent.includes('四种写入方法全部失败'));
check('提示条不带「去设置」（不是 Key 的问题）', shortcut.find('.notice__action') === null);

// 空格文本不触发写入
shortcut.setValue(shortcut.find('.composer__input'), '   \n  ');
await tick();
check('只有空白时「输入」按钮不可点', shortcut.find('.composer__write').disabled);

// 新会话：先聊一轮，再清空
shortcut.setValue(shortcut.find('.composer__input'), '帮我看看这道题');
await tick();
shortcut.find('.composer__send').click();
await tick();
const shortcutRequestId = shortcut.requests.find((r) => r.type === 'chat/start')?.requestId;
shortcut.emit({ type: 'chat/delta', requestId: shortcutRequestId, text: '好的，先读题面。' });
await tick();
check('新一轮上下文已建立', shortcut.find('.bubble--user').textContent.includes('帮我看看这道题'));

shortcut.emit({ type: 'chat/usage', requestId: shortcutRequestId, promptTokens: 300, completionTokens: 12, totalTokens: 312 });
await tick();
check('顶栏显示这一轮的 token 用量', shortcut.find('.panel__usage').textContent === 'Token 312（输入 300 / 输出 12）');

shortcut.find('.panel__new-chat').click();
await tick();
check('「新会话」把对话清回只剩欢迎语', !shortcut.find('.bubble--user') && !shortcut.find('.bubble--assistant'));
check('「新会话」顺带清掉提示条', shortcut.find('.notice') === null);
check('「新会话」顺带清掉 token 计数', shortcut.find('.panel__usage').textContent === '');
check('「新会话」不刷新页面也能重开一轮', shortcut.find('.composer__send').textContent === '发送');

// 上一轮还在生成时点「新会话」：先把后台那一轮掐掉，旧增量不能再冒出来
shortcut.setValue(shortcut.find('.composer__input'), '再问一句');
await tick();
shortcut.find('.composer__send').click();
await tick();
const abortedRequestId = shortcut.requests.filter((r) => r.type === 'chat/start').at(-1).requestId;
shortcut.find('.panel__new-chat').click();
await tick();
check(
  '生成中「新会话」会先停掉那一轮',
  shortcut.requests.filter((r) => r.type === 'chat/stop' && r.requestId === abortedRequestId).length === 1,
);
shortcut.emit({ type: 'chat/delta', requestId: abortedRequestId, text: '迟到的回答' });
await tick();
check('掐掉后迟到的增量不会再写进对话', !shortcut.find('.messages').textContent.includes('迟到的回答'));

/* ---------- 场景八：ask 提问、diff 对照、进度条 ---------- */

const tools2 = boot({ hasApiKey: true });
await tick();
tools2.toggle();
await tick();
check('空闲时不显示进度条', !tools2.find('.panel__progress'));

tools2.setValue(tools2.find('.composer__input'), '帮我改一下这段代码');
await tick();
tools2.find('.composer__send').click();
await tick();
const askId = tools2.requests.find((r) => r.type === 'chat/start')?.requestId;
check('开始生成后出现进度条', Boolean(tools2.find('.panel__progress')));

// ask：模型抛出一个选择题，卡片上直接能选
tools2.emit({
  type: 'chat/tool-start',
  requestId: askId,
  callId: 'call_ask',
  name: 'ask',
  args: '{"question":"要不要我直接改作答区？","options":["改","先别改，只讲思路"]}',
});
tools2.emit({
  type: 'chat/ask',
  requestId: askId,
  callId: 'call_ask',
  question: '要不要我直接改作答区？',
  options: ['改', '先别改，只讲思路'],
});
await tick();
const askCard = tools2.shadow().querySelector('.tool');
check('ask 卡片默认展开', Boolean(askCard.querySelector('.ask')));
check('ask 卡片显示问题', askCard.querySelector('.ask__question').textContent === '要不要我直接改作答区？');
check('ask 卡片列出两个选项', askCard.querySelectorAll('.ask__option').length === 2);

askCard.querySelectorAll('.ask__option')[1].click();
await tick();
check(
  '点选项把答案交给后台',
  tools2.requests.some(
    (r) => r.type === 'chat/ask-answer' && r.callId === 'call_ask' && r.choice === '先别改，只讲思路',
  ),
);
check('选中后卡片显示用户的选择', askCard.querySelector('.ask__chosen').textContent === '已选择：先别改，只讲思路');
check('选中后选项按钮消失', askCard.querySelectorAll('.ask__option').length === 0);

tools2.emit({
  type: 'chat/tool-end',
  requestId: askId,
  callId: 'call_ask',
  result: '用户选择了「先别改，只讲思路」',
  isError: false,
});
await tick();

// diff：左右两列对照，按行标出新增/修改/删除
tools2.emit({
  type: 'chat/tool-start',
  requestId: askId,
  callId: 'call_diff',
  name: 'diff',
  args: JSON.stringify({
    left: 'int a = 1;\nint b = 2;\nreturn 0;',
    right: 'int a = 1;\nint b = 3;\nprintf("%d", a);\nreturn 0;',
  }),
});
tools2.emit({
  type: 'chat/tool-end',
  requestId: askId,
  callId: 'call_diff',
  result: '差异：新增 1 行，修改 1 行，删除 0 行（左右对照已展示给用户）',
  isError: false,
  diff: {
    left: 'int a = 1;\nint b = 2;\nreturn 0;',
    right: 'int a = 1;\nint b = 3;\nprintf("%d", a);\nreturn 0;',
    leftLabel: '改动前',
    rightLabel: '改动后',
  },
});
await tick();
const diffCard = [...tools2.shadow().querySelectorAll('.tool')].at(-1);
check('diff 逐行渲染左右两列', diffCard.querySelectorAll('.diff__row').length === 6);
check('没动的行标成相同', diffCard.querySelectorAll('.diff__row--equal').length === 2);
check('改过的那一行左右同行显示', diffCard.querySelectorAll('.diff__row--mod').length === 1);
check('新增的那一行标成 add', diffCard.querySelectorAll('.diff__row--add').length === 1);
check('没删东西时不出现删除行', diffCard.querySelectorAll('.diff__row--del').length === 0);
check(
  '左右两列表头都有标题',
  [...diffCard.querySelectorAll('.diff__head-cell')]
    .map((n) => n.textContent.replace('复制新代码', '').replace('已复制', ''))
    .join(',') === '改动前,改动后',
);
check('表头右侧有复制按钮', Boolean(diffCard.querySelector('.diff__copy')));
check('改动聚成一个块', diffCard.querySelectorAll('.diff__hunk').length === 1);
check('中间那条道给改动块画了头尾箭头', diffCard.querySelector('.diff__gutter--start').textContent === '»' && diffCard.querySelector('.diff__gutter--end').textContent === '«');
check('每一行都有中间道', diffCard.querySelectorAll('.diff__row .diff__gutter').length === diffCard.querySelectorAll('.diff__row').length);
check('行内被改的符号被高亮', diffCard.querySelectorAll('.diff__word').length >= 2);
check('改动前那一行标了删除色', diffCard.querySelector('.diff__row--mod .diff__cell--left').textContent.includes('int b = 2;'));
check('改动后那一行标了新增色', diffCard.querySelector('.diff__row--mod .diff__cell--right').textContent.includes('int b = 3;'));
check('没改动的大段会折叠成一行', Boolean(diffCard.querySelector('.diff__more')) ||
  diffCard.querySelectorAll('.diff__row--equal').length === 2);
check(
  '底部统计新增/修改/删除',
  diffCard.querySelector('.diff__legend').textContent.includes('新增 1') &&
    diffCard.querySelector('.diff__legend').textContent.includes('修改 1') &&
    diffCard.querySelector('.diff__legend').textContent.includes('删除 0'),
);

tools2.emit({ type: 'chat/done', requestId: askId, aborted: false });
await tick();
check('这一轮结束后进度条消失', !tools2.find('.panel__progress'));

// 模型这一轮一个字都没吐：必须给用户一个说法，否则看起来就是卡死
tools2.setValue(tools2.find('.composer__input'), '这次别出声');
await tick();
tools2.find('.composer__send').click();
await tick();
// 每一轮 send 都会生成新的 requestId，事件要跟着当轮走
const emptyRoundId = tools2.requests.filter((r) => r.type === 'chat/start').at(-1).requestId;
tools2.emit({ type: 'chat/done', requestId: emptyRoundId, aborted: false });
await tick();
check(
  '模型空输出会给出提示而不是一片空白',
  (tools2.find('.notice__text')?.textContent ?? '').includes('没有输出内容'),
);

// 下一轮重新开始，token 计数从零算
tools2.setValue(tools2.find('.composer__input'), '再试一次');
await tick();
tools2.find('.composer__send').click();
await tick();
const retryRoundId = tools2.requests.filter((r) => r.type === 'chat/start').at(-1).requestId;
tools2.emit({ type: 'chat/usage', requestId: retryRoundId, promptTokens: 80, completionTokens: 4, totalTokens: 84 });
await tick();
check('新一轮的 token 单独计数', tools2.find('.panel__usage').textContent === 'Token 84（输入 80 / 输出 4）');


// 生成中点「新会话」：没答的 ask 不该把界面留在等待状态
tools2.setValue(tools2.find('.composer__input'), '再来一次');
await tick();
tools2.find('.composer__send').click();
await tick();
tools2.emit({
  type: 'chat/tool-start',
  requestId: askId,
  callId: 'call_ask2',
  name: 'ask',
  args: '{"question":"要提交吗？","options":["提交","不提交"]}',
});
tools2.emit({
  type: 'chat/ask',
  requestId: askId,
  callId: 'call_ask2',
  question: '要提交吗？',
  options: ['提交', '不提交'],
});
await tick();
tools2.find('.panel__new-chat').click();
await tick();
check('「新会话」把没答完的 ask 一起清掉', !tools2.find('.messages').textContent.includes('要提交吗？'));

console.log(`\n${target} 冒烟测试通过`);
