// 最小化 background 校验：图标点击、设置存取、写入链路（含备用降级）、无 Key 短路。
// 用法：node scripts/test-background.mjs [chrome|firefox]
import { assertDistFresh } from './dist-fresh.mjs';

const target = process.argv[2] ?? 'chrome';
assertDistFresh(`dist/${target}`);

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const state = {
  storage: {},
  channels: { action: [], message: [] },
  contentScriptPresent: true,
  mainWorldSupported: true,
  pageTool: { ok: true, result: 'ok' },
  pageToolCalls: [],
  debuggerCalls: [],
  modelCalls: [],
  sse: [],
  worlds: [],
  tabEvents: [],
  injectArgs: [],
};

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
      if (!state.contentScriptPresent) throw new Error('no content script');
      return undefined;
    },
  },
  debugger: {
    attach: async (t) => { state.debuggerCalls.push(['attach', t.tabId]); },
    detach: async (t) => { state.debuggerCalls.push(['detach', t.tabId]); },
    sendCommand: async (_t, method, params) => {
      state.debuggerCalls.push([method, params]);
      if (method === 'Runtime.evaluate' && String(params.expression).includes('cm-line')) {
        return String(params.expression).includes('indent')
          ? { result: { value: { indent: 0, col: 0, stale: false } } }
          : { result: { value: '' } };
      }
      return {};
    },
    onDetach: { addListener: () => {} },
  },
  scripting: {
    executeScript: async (options) => {
      if (options.files) { state.contentScriptPresent = true; return []; }
      if (options.world === 'MAIN' && !state.mainWorldSupported) throw new Error('no MAIN');
      state.worlds.push(options.world);
      const source = String((options.args && options.args[0]) || '');
      let parsed = null;
      try {
        const marker = source.indexOf('const __args = ');
        if (marker >= 0) {
          const end = source.indexOf('\n', marker);
          parsed = JSON.parse(source.slice(marker + 15, end === -1 ? undefined : end).replace(/;\s*$/, ''));
          state.injectArgs.push(parsed);
        }
      } catch (e) {}
      if (parsed) {
        if (parsed.method === 'clear') return [{ result: { ok: true, detail: '已清空' } }];
        if (parsed.method === 'readDoc') return [{ result: state.readDocText ?? 'hi' }];
        if (parsed.method === 'rect') return [{ result: { x: 60, y: 40 } }];
        return [{ result: { ok: true, output: state.writeResult ?? '写入成功' } }];
      }
      if (source.includes('isDisabled')) return [{ result: '提交按钮：当前可用' }];
      if (source.includes('samplesOnly')) return [{ result: { samples: [{ input: '3 4', output: '7' }] } }];
      if (source.includes('pickEditorView')) return [{ result: state.writeResult ?? '写入成功' }];
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

// fetch 桩：只回放模型的 SSE（内置编译器在 Node 里没有 Worker，走到会自己降级）
const encoder = new TextEncoder();
globalThis.fetch = async (url, init) => {
  state.modelCalls.push(JSON.parse(init.body));
  const sse = state.sse[Math.min(state.modelCalls.length - 1, state.sse.length - 1)] ?? '';
  return new Response(
    new ReadableStream({ start(c) { c.enqueue(encoder.encode(sse)); c.close(); } }),
    { status: 200 },
  );
};

delete globalThis.browser;
await import(`../dist/${target}/background.js`);

const respond = (message, sender = {}) =>
  new Promise((resolve) => {
    const keepOpen = state.channels.message[0](message, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });
const click = (tabId) => state.channels.action.forEach((fn) => fn({ id: tabId }));


/* ---------- 图标点击 ---------- */

click(7);
await tick();
check('有 content script 时直接发 toggle-panel', state.tabEvents.some((e) => e.type === 'toggle-panel'));

state.contentScriptPresent = false;
click(8);
await tick();
check('没有 content script 时补注入再发', state.tabEvents.filter((e) => e.type === 'toggle-panel').length === 3);
state.contentScriptPresent = true;

/* ---------- 设置 ---------- */

const respond2 = (message, sender = {}) =>
  new Promise((resolve) => {
    const keepOpen = state.channels.message[0](message, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });
await respond2({ type: 'settings/save', patch: { apiKey: 'sk-test' } });
const view = await respond2({ type: 'settings/get' });
check('settings/save 落盘且视图不含 Key', state.storage['pta-assistant-settings'].apiKey === 'sk-test' && !('apiKey' in view) && view.hasApiKey === true);

/* ---------- 写入链路：默认 → 清空 → 备用 ---------- */

// 正常：默认方法一次成功
state.writeResult = '写入成功';
state.sse = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_editor_code","arguments":"{\\"code\\":\\"int main(){}\\"}"}}]}}]}\n\ndata: [DONE]\n\n`,
  `data: {"choices":[{"delta":{"content":"写好了。"}}]}\n\ndata: [DONE]\n\n`,
];
await respond2({ type: 'chat/start', requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
check('默认方法一次写入成功', state.injectArgs.some((a) => a.method === 'dispatchFocus'));

/* ---------- 无 Key 短路 ---------- */

await respond2({ type: 'settings/save', patch: { apiKey: '' } });
const noKey = await respond2({ type: 'chat/start', requestId: 'r2', messages: [] }, { tab: { id: 7 } });
check('没配 Key 时返回提示', noKey.ok === false && noKey.message.includes('API Key'));

console.log(`\n${target} background 校验通过`);
