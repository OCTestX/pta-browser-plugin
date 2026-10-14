// 用桩模拟 Chrome 的扩展 API + 假的模型流，跑打包后的 background.js：
// 图标点击链路（含补注入）、设置落盘、agent loop（工具调用、结果回灌、轮数上限、参数出错）。
// executeScript 的桩会真的调用注入函数，所以 js-inject 里的超时/序列化/回退逻辑也会被执行。
// 用法：node scripts/test-background.mjs [chrome|firefox]
import { assertDistFresh } from './dist-fresh.mjs';
const target = process.argv[2] ?? 'chrome';
assertDistFresh(`dist/${target}`);

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 桩环境 ---------- */

const state = {
  storage: {},
  channels: { action: [], message: [] },
  contentScriptPresent: true,
  mainWorldSupported: true,
  /** 每次模型请求的 body */
  modelCalls: [],
  /** 每次 fetch 返回的 SSE 文本，按请求顺序取 */
  sse: [],
  worlds: [],
  tabEvents: [],
  /** 页面侧工具（url / write_document / 键盘输入）的返回值 */
  pageTool: { ok: true, result: 'https://pintia.cn/problem-sets/1' },
  /** 每次工具调用时页面侧收到的参数 */
  pageToolCalls: [],
  debuggerCalls: [],
  attachedTabs: new Set(),
  attachFails: false,
};

const encoder = new TextEncoder();

globalThis.chrome = {
  action: { onClicked: { addListener: (fn) => state.channels.action.push(fn) } },
  runtime: { onMessage: { addListener: (fn) => state.channels.message.push(fn) } },
  tabs: {
    sendMessage: async (tabId, message) => {
      if (message.type === 'tool/run') {
        state.pageToolCalls.push(message);
        return state.pageTool;
      }
      state.tabEvents.push(message);
      if (!state.contentScriptPresent) throw new Error('Could not establish connection.');
      return undefined;
    },
  },
  debugger: {
    attach: async (target, version) => {
      if (state.attachFails) throw new Error('Another debugger is already attached to the tab');
      state.debuggerCalls.push(['attach', target.tabId, version]);
      state.attachedTabs.add(target.tabId);
    },
    detach: async (target) => {
      state.debuggerCalls.push(['detach', target.tabId]);
      state.attachedTabs.delete(target.tabId);
    },
    sendCommand: async (target, method, params) => {
      state.debuggerCalls.push([method, target.tabId, params]);
      // 探针：假页面里光标右侧什么都没有、列号为 0
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('cm-line')) {
          return params.expression.includes('indent')
            ? { result: { value: { indent: 0, col: 0, stale: false } } }
            : { result: { value: '' } };
        }
        return { result: { value: null } };
      }
      return {};
    },
    onDetach: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (options) => {
      state.tabEvents.push({ type: 'scripting.executeScript', world: options.world });
      if (options.files) {
        state.contentScriptPresent = true; // 声明式补注入
        return [];
      }
      if (options.world === 'MAIN' && !state.mainWorldSupported) {
        throw new Error('world MAIN is not supported');
      }
      state.worlds.push(options.world);
      // 真的执行注入函数，覆盖 AsyncFunction / 序列化 / 错误归一化
      const result = await options.func(...options.args);
      return [{ result }];
    },
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: state.storage[key] }),
      set: async (patch) => Object.assign(state.storage, patch),
    },
  },
};

globalThis.fetch = async (_url, init) => {
  state.modelCalls.push(JSON.parse(init.body));
  const sse = state.sse[Math.min(state.modelCalls.length - 1, state.sse.length - 1)] ?? '';
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
        controller.close();
      },
    }),
    { status: 200 },
  );
};

delete globalThis.browser;
await import(`../dist/${target}/background.js`);

const click = (tabId) => state.channels.action.forEach((fn) => fn({ id: tabId }));
const respond = (message, sender = {}) =>
  new Promise((resolve) => {
    const keepOpen = state.channels.message[0](message, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });

async function waitForChatEnd(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.tabEvents.some((e) => e.type === 'chat/done' || e.type === 'chat/error')) return;
    await tick();
  }
  throw new Error('✗ 等不到 chat/done');
}

async function chat(text = '帮我看下这道题') {
  state.modelCalls = [];
  state.worlds = [];
  state.tabEvents = [];
  state.pageToolCalls = [];
  state.debuggerCalls = [];
  state.attachedTabs.clear();
  const response = await respond(
    { type: 'chat/start', requestId: 'r1', messages: [{ role: 'user', content: text }] },
    { tab: { id: 7 } },
  );
  await waitForChatEnd();
  return response;
}

const toolCallsSse = (id, name, argsChunks) =>
  [
    ...argsChunks.map((chunk, index) =>
      index === 0
        ? `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":${JSON.stringify(chunk)}}}]}}]}\n\n`
        : `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(chunk)}}}]}}]}\n\n`,
    ),
    'data: [DONE]\n\n',
  ].join('');

const textSse = (text) =>
  `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: [DONE]\n\n`;

/* ---------- 图标点击链路 ---------- */

check('background 载入后注册了图标点击监听', state.channels.action.length === 1);

state.tabEvents = [];
click(7);
await tick();
check(
  '有 content script 时直接发 toggle-panel',
  state.tabEvents.length === 1 && state.tabEvents[0].type === 'toggle-panel',
);

state.tabEvents = [];
state.contentScriptPresent = false;
click(8);
await tick();
check(
  '没有 content script 时先补注入再发 toggle-panel',
  state.tabEvents.map((e) => e.type).join(' > ') ===
    'toggle-panel > scripting.executeScript > toggle-panel',
);

/* ---------- 设置 ---------- */

await respond({ type: 'settings/save', patch: { apiKey: 'sk-secret', model: 'deepseek-v4.1-flash' } });
const view = await respond({ type: 'settings/get' });
check('settings/save 把 Key 写进了 storage', state.storage['pta-assistant-settings'].apiKey === 'sk-secret');
check('返回给页面的视图里不含 apiKey 字段', !('apiKey' in view) && view.hasApiKey === true);

/* ---------- agent loop：一轮工具调用 + 最终回答 ---------- */

state.sse = [
  `data: {"choices":[{"delta":{"content":"我先看下页面标题。"}}]}\n\n${toolCallsSse('call_1', 'js_inject', ['{"code":', '"return \\"页面标题\\""', '}'])}`,
  textSse('标题已经拿到了。'),
];
const started = await chat('页面标题是什么');
check('chat/start 立刻返回 ok，循环在后台跑', started.ok === true);
check('模型被调用了两轮（工具 → 回答）', state.modelCalls.length === 2);
check('第一轮带上了全部工具定义', state.modelCalls[0].tools?.length === 8);
check(
  '工具定义里有 PTA 三件套与键盘工具',
  ['read_problem', 'read_editor_code', 'write_editor_code', 'simulate_keyboard_input'].every((name) =>
    state.modelCalls[0].tools.some((t) => t.function.name === name),
  ),
);
check('第一轮第一条消息是系统提示', state.modelCalls[0].messages[0].role === 'system');

const second = state.modelCalls[1].messages;
const assistantWithCalls = second.find((m) => m.tool_calls?.length > 0);
const toolResult = second.find((m) => m.role === 'tool');
check('第二轮把 assistant 的 tool_calls 回灌了', assistantWithCalls?.tool_calls[0].function.name === 'js_inject');
check(
  'tool_calls 的参数是拼完整的 JSON',
  JSON.parse(assistantWithCalls?.tool_calls[0].function.arguments ?? '{}').code === 'return "页面标题"',
);
check('第二轮带上了工具执行结果', toolResult?.tool_call_id === 'call_1' && toolResult.content === '页面标题');

check('js_inject 在主世界执行', state.worlds[0] === 'MAIN');
const events = state.tabEvents.map((e) => e.type);
check(
  '页面收到了工具开始/结束与文字增量',
  events.includes('chat/tool-start') && events.includes('chat/tool-end') && events.includes('chat/done'),
);
check(
  '工具事件带上了调用 id 与结果',
  state.tabEvents.find((e) => e.type === 'chat/tool-end')?.callId === 'call_1' &&
    state.tabEvents.find((e) => e.type === 'chat/tool-end')?.result === '页面标题',
);

/* ---------- 工具执行细节 ---------- */

state.sse = [toolCallsSse('call_2', 'js_inject', ['{"code":"return 1 + 1"}']), textSse('好')];
await chat();
check('注入代码的返回值会序列化回模型', state.modelCalls[1].messages.at(-1).content === '2');

state.sse = [toolCallsSse('call_3', 'js_inject', ['{"code":"return await Promise.resolve({a: [1, 2]})"}']), textSse('好')];
await chat();
check(
  '注入代码支持顶层 await 且对象会转成 JSON',
  state.modelCalls[1].messages.at(-1).content === '{"a":[1,2]}',
);

state.sse = [toolCallsSse('call_4', 'js_inject', ['{"code":"throw new Error(\\"页面没有标题\\")"}']), textSse('好')];
await chat();
check('注入代码报错会作为失败结果回灌', state.modelCalls[1].messages.at(-1).content === '页面没有标题');
check(
  '报错时 chat/tool-end 标记为失败',
  state.tabEvents.find((e) => e.type === 'chat/tool-end')?.isError === true,
);

state.mainWorldSupported = false;
state.sse = [toolCallsSse('call_5', 'js_inject', ['{"code":"return 2"}']), textSse('好')];
await chat();
check('主世界不可用时回退隔离世界', state.worlds[0] === 'ISOLATED' && state.worlds.length === 1);
state.mainWorldSupported = true;

state.sse = [toolCallsSse('call_6', 'date', ['{}']), textSse('好')];
await chat();
check(
  'date 返回本地日期与星期',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}（周./.test(state.modelCalls[1].messages.at(-1).content),
);

state.sse = [toolCallsSse('call_7', 'url', ['{}']), textSse('好')];
await chat();
check(
  'url 走页面侧执行并回灌结果',
  state.modelCalls[1].messages.at(-1).content === 'https://pintia.cn/problem-sets/1',
);

state.pageTool = { ok: true, result: '已触发下载：题解.md（20 字符）' };
state.sse = [
  toolCallsSse('call_8', 'write_document', ['{"filename":"题解.md","content":"# 题解"}']),
  textSse('好'),
];
await chat();
check('write_document 的结果也回灌给模型', state.modelCalls[1].messages.at(-1).content === '已触发下载：题解.md（20 字符）');
state.pageTool = { ok: true, result: 'https://pintia.cn/problem-sets/1' };

state.sse = [toolCallsSse('call_9', 'js_inject', ['{"code": oops}']), textSse('好')];
await chat();
check(
  '参数不是合法 JSON 时把原因回灌给模型',
  state.modelCalls[1].messages.at(-1).content.includes('参数不是合法 JSON'),
);

state.sse = [toolCallsSse('call_10', 'no_such_tool', ['{}']), textSse('好')];
await chat();
check(
  '不存在的工具会把可用工具告诉模型',
  state.modelCalls[1].messages.at(-1).content.includes('可用工具'),
);

/* ---------- 真实按键开关 ---------- */

const keyboardArgs = ['{"text":"Hello","selector":"#answer","press":"Enter"}'];
state.pageTool = { ok: true, result: '已把焦点放到 input#answer' };

// 开关关闭（默认）：只走 DOM 事件，不碰调试器
state.sse = [toolCallsSse('call_k1', 'simulate_keyboard_input', keyboardArgs), textSse('好')];
await chat();
check('开关关闭时不使用调试器', state.debuggerCalls.length === 0);
check(
  '开关关闭时把完整参数交给页面侧',
  state.pageToolCalls[0].args.text === 'Hello' && state.pageToolCalls[0].args.press === 'Enter',
);

// 开关打开：先 focusOnly 聚焦，再用 CDP 输入文本与按键，最后断开
await respond({ type: 'settings/save', patch: { useDebuggerInput: true } });
state.pageTool = { ok: true, result: 'Hello' }; // 回读拿到编辑器里的内容
state.sse = [toolCallsSse('call_k2', 'simulate_keyboard_input', keyboardArgs), textSse('好')];
await chat();

check('开启后先让页面聚焦（focusOnly），不自己写 value', state.pageToolCalls[0].args.focusOnly === true);
check(
  '开启后页面侧只负责聚焦与回读（输入交给调试器）',
  state.pageToolCalls.length === 2 &&
    state.pageToolCalls[0].args.focusOnly === true &&
    state.pageToolCalls[1].args.readOnly === true,
);
const typedChars = state.debuggerCalls
  .filter((call) => call[0] === 'Input.dispatchKeyEvent' && call[2].type === 'char')
  .map((call) => call[2].text)
  .join('');
check('开启后逐字发真实按键输入文本', typedChars === 'Hello');
check('逐字输入走 char 事件而不是 insertText', !state.debuggerCalls.some((call) => call[0] === 'Input.insertText'));
check(
  '打字过程中会用页面探针判断光标右侧内容',
  state.debuggerCalls.some((call) => call[0] === 'Runtime.evaluate'),
);
check(
  '工具结果里带上了打字统计',
  state.modelCalls[1].messages.at(-1).content.includes('已逐字敲入'),
);
check(
  '开启后通过 CDP 按下 Enter',
  state.debuggerCalls.some(
    (call) => call[0] === 'Input.dispatchKeyEvent' && call[2].windowsVirtualKeyCode === 13,
  ),
);
check(
  '输入后会回读编辑器内容做比对',
  state.pageToolCalls.some((call) => call.args.readOnly === true),
);
check('调用结束后断开了调试器', state.debuggerCalls.some((call) => call[0] === 'detach') && !state.attachedTabs.size);
const cdpResult = state.modelCalls[1].messages.at(-1).content;
check(
  '工具结果里说明了走真实按键并带上回读比对',
  cdpResult.includes('真实按键') && cdpResult.includes('回读比对'),
);

// 调试器用不了（DevTools 占着、浏览器不支持）：退回 DOM 事件并说明原因
state.attachFails = true;
state.pageTool = { ok: true, result: '已把焦点放到 input#answer' };
state.sse = [toolCallsSse('call_k3', 'simulate_keyboard_input', keyboardArgs), textSse('好')];
await chat();
check(
  '调试器失败时退回 DOM 事件并说明原因',
  state.modelCalls[1].messages.at(-1).content.includes('已退回模拟事件'),
);
check(
  '回退时会补一次完整的页面侧输入',
  state.pageToolCalls.some((call) => call.args.text === 'Hello'),
);
state.attachFails = false;
await respond({ type: 'settings/save', patch: { useDebuggerInput: false } });

/* ---------- 轮数上限 ---------- */

state.sse = [toolCallsSse('call_loop', 'date', ['{}'])]; // 每轮都只调工具，永远不收敛
await chat();
check('一直调工具时会停在轮数上限', state.tabEvents.some((e) => e.type === 'chat/notice'));
check('上限轮数就是 MAX_TOOL_ROUNDS', state.modelCalls.length === 80);

/* ---------- 没有 Key 时不发请求 ---------- */

await respond({ type: 'settings/save', patch: { apiKey: '' } });
state.modelCalls = [];
const noKey = await respond(
  { type: 'chat/start', requestId: 'r9', messages: [{ role: 'user', content: 'hi' }] },
  { tab: { id: 9 } },
);
check('没配 Key 时 chat/start 返回提示而不是发请求', noKey.ok === false && noKey.message.includes('API Key'));
check('没配 Key 时没有调用模型', state.modelCalls.length === 0);

console.log(`\n${target} background 校验通过`);
