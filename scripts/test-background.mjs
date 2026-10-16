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
  createdTabs: [],
  injectArgs: [],
  hangJudge: false,
  abortFlags: 0,
};

globalThis.chrome = {
  action: { onClicked: { addListener: (fn) => state.channels.action.push(fn) } },
  runtime: { onMessage: { addListener: (fn) => state.channels.message.push(fn) } },
  tabs: {
    create: async (options) => { state.createdTabs.push(options); return { id: 99 }; },
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
      // 中止标记的注入（args 只有标记名，没有 source）
      if (options.func && options.args && options.args.length === 1 && typeof options.args[0] === 'string' && !options.args[1]) {
        state.abortFlags += 1;
        return [{ result: undefined }];
      }
      if (options.world === 'MAIN' && !state.mainWorldSupported) throw new Error('no MAIN');
      state.worlds.push(options.world);
      const source = String((options.args && options.args[0]) || '');
      // 卡住的判题读取：executeScript 撤不回来，模拟页面里死循环的轮询，只能靠后台中止
      if (state.hangJudge && source.includes('__ptaJudgeSnapshot')) {
        return await new Promise(() => {});
      }
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
        // json 模式（写入链路用）：返回结构化的成功/失败，由 state.writeOk 控制
        if (parsed.json === true) {
          return [{
            result: {
              ok: state.writeOk !== false,
              method: parsed.method,
              detail: state.writeOk === false ? '回读比对：与目标不一致' : '回读比对：与目标一致',
              length: String(parsed.text ?? '').length,
            },
          }];
        }
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

/* ---------- 双击插件图标：复位位置与大小 ---------- */

state.contentScriptPresent = true;
state.tabEvents.length = 0;
click(9);
click(9);
await tick();
check(
  '双击图标时第一下开关、第二下只发复位',
  state.tabEvents.filter((e) => e.type === 'toggle-panel').length === 1 &&
    state.tabEvents.filter((e) => e.type === 'panel/reset-layout').length === 1,
);
check('复位消息排在开关之后（面板不会被连点两次关掉）', state.tabEvents.at(-1).type === 'panel/reset-layout');

// 单击仍然只是开关，不会误触发复位
state.tabEvents.length = 0;
click(10);
await tick(450);
click(10);
await tick();
check('两次单击各自开关，不会当成双击', state.tabEvents.filter((e) => e.type === 'panel/reset-layout').length === 0);
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

/* ---------- 默认值：硅基流动；旧版本存的调试器开关不再出现 ---------- */

await respond2({ type: 'settings/save', patch: { apiKey: '' } });
const defaults = await respond2({ type: 'settings/get' });
check('默认接口地址是硅基流动', defaults.baseURL === 'https://api.siliconflow.cn/v1');
check('默认模型是 deepseek-ai/DeepSeek-V4.1-Flash', defaults.model === 'deepseek-ai/DeepSeek-V4.1-Flash');
check('设置视图里没有「用调试器发送真实按键」', !('useDebuggerInput' in defaults));

// 旧版本存过的开关字段，读出来时不再带
state.storage['pta-assistant-settings'] = {
  apiKey: 'sk-old',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  useDebuggerInput: true,
};
const legacy = await respond2({ type: 'settings/get' });
check('旧版本存过的调试器开关被丢掉', !('useDebuggerInput' in legacy));

/* ---------- 教程按钮开新标签页 ---------- */

const opened = await respond2({ type: 'ui/open-url', url: 'http://octestpi.top/pta-assist-plugin' });
check('点教程会开新标签页去教程页', opened.ok === true && state.createdTabs.at(-1).url === 'http://octestpi.top/pta-assist-plugin');
const refused = await respond2({ type: 'ui/open-url', url: 'javascript:alert(1)' });
check('只放行 http/https 链接', refused.ok === false);

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

/* ---------- 停止能打断正在等待的工具 ---------- */

// 模型调 read_judge_result，页面那边永远不返回（真 PTA 上就是「一直在轮询等结论」）
state.hangJudge = true;
state.sse = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"read_judge_result","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n`,
];
state.tabEvents.length = 0;
await respond2({ type: 'chat/start', requestId: 'r3', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
check('工具已经开跑', state.tabEvents.some((e) => e.type === 'chat/tool-start' && e.name === 'read_judge_result'));
check('工具还没结束时没有 done', !state.tabEvents.some((e) => e.type === 'chat/done'));

await respond2({ type: 'chat/stop', requestId: 'r3' });
await tick(50);
const stopped = state.tabEvents.filter((e) => e.type === 'chat/done');
check('点停止能立刻结束这次生成（不必等页面里的轮询结束）', stopped.length === 1 && stopped[0].aborted === true);
check('卡住的工具也收到收尾通知（面板上的工具卡片不会一直转）', state.tabEvents.some((e) => e.type === 'chat/tool-end' && e.result === '已停止'));
check('中止时往页面里置了取消标记，页面里的轮询循环能自己退出', state.abortFlags >= 1);
state.hangJudge = false;

/* ---------- ask：等用户点选；diff：把左右两栏交给面板 ---------- */

// 模型先问一句「要不要改」，这一轮会一直挂在等用户点选上
state.sse = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c3","function":{"name":"ask","arguments":"{\\"question\\":\\"要不要我直接改作答区？\\",\\"options\\":[\\"改\\",\\"先别改，只讲思路\\"]}"}}]}}]}\n\ndata: [DONE]\n\n`,
  `data: {"choices":[{"delta":{"content":"好的，先不动你的代码。"}}]}\n\ndata: [DONE]\n\n`,
];
state.tabEvents.length = 0;
// fetch 桩按累计调用次数回放 SSE，新场景先归零，否则拿到的是上一段剧本的回答
state.modelCalls.length = 0;
await respond2({ type: 'chat/start', requestId: 'r4', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
const asked = state.tabEvents.find((e) => e.type === 'chat/ask');
check('ask 把问题与选项发给面板', asked?.question === '要不要我直接改作答区？' && asked.options.length === 2);
check('用户还没点选时这一轮挂着（没有 done）', !state.tabEvents.some((e) => e.type === 'chat/done'));

await respond2({ type: 'chat/ask-answer', requestId: 'r4', callId: asked.callId, choice: '先别改，只讲思路' });
await tick(50);
check(
  '用户的回答作为工具结果回灌给模型',
  state.tabEvents.some((e) => e.type === 'chat/tool-end' && e.callId === asked.callId && e.result.includes('先别改，只讲思路')),
);
check('拿到回答后这一轮继续跑完', state.tabEvents.some((e) => e.type === 'chat/done'));

// 用户点了「停止」，还没答的 ask 不能把后台挂死
state.sse = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c4","function":{"name":"ask","arguments":"{\\"question\\":\\"要提交吗？\\",\\"options\\":[\\"提交\\",\\"不提交\\"]}"}}]}}]}\n\ndata: [DONE]\n\n`,
  `data: {"choices":[{"delta":{"content":"好。"}}]}\n\ndata: [DONE]\n\n`,
];
state.tabEvents.length = 0;
state.modelCalls.length = 0;
await respond2({ type: 'chat/start', requestId: 'r5', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
check('第二个 ask 也发出去了', state.tabEvents.some((e) => e.type === 'chat/ask' && e.question === '要提交吗？'));
await respond2({ type: 'chat/stop', requestId: 'r5' });
await tick(50);
check('停止会解掉没答完的 ask 并正常收尾', state.tabEvents.some((e) => e.type === 'chat/done' && e.aborted === true));

// 已经超时的提问（或者已经结束的那一轮）再作答：要如实说没收到，别假装收到了
const late = await respond2({ type: 'chat/ask-answer', requestId: 'r5', callId: 'call_never', choice: '提交' });
check('对已经结束的提问作答会被拒绝', late.ok === false);

// diff：把左右两栏交给面板，同时给模型一句统计
state.sse = [
  `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c5","function":{"name":"diff","arguments":"{\\"left\\":\\"int b = 2;\\",\\"right\\":\\"int b = 3;\\\\nprintf(1);\\"}"}}]}}]}\n\ndata: [DONE]\n\n`,
  `data: {"choices":[{"delta":{"content":"改好了。"}}]}\n\ndata: [DONE]\n\n`,
];
state.tabEvents.length = 0;
state.modelCalls.length = 0;
await respond2({ type: 'chat/start', requestId: 'r6', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
const diffEnd = state.tabEvents.find((e) => e.type === 'chat/tool-end' && e.callId === 'c5');
check('diff 把改动前后两栏传给面板', diffEnd?.diff?.left === 'int b = 2;' && diffEnd?.diff?.right.startsWith('int b = 3;'));
check('diff 的列标题有默认值', diffEnd?.diff?.leftLabel === '改动前' && diffEnd?.diff?.rightLabel === '改动后');
check('diff 的工具结果带行数统计', diffEnd?.result.includes('新增 1 行') && diffEnd.result.includes('修改 1 行'));

// token 用量：接口在最后一帧回传 usage 时，面板要收到累计值
state.sse = [
  `data: {"choices":[{"delta":{"content":"好。"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56,"total_tokens":1290}}\n\ndata: [DONE]\n\n`,
];
state.tabEvents.length = 0;
state.modelCalls.length = 0;
await respond2({ type: 'chat/start', requestId: 'r7', messages: [{ role: 'user', content: 'hi' }] }, { tab: { id: 7 } });
await tick(50);
const usageEvent = state.tabEvents.find((e) => e.type === 'chat/usage');
check(
  '接口回传 usage 时上报给面板',
  usageEvent?.promptTokens === 1234 && usageEvent?.completionTokens === 56 && usageEvent?.totalTokens === 1290,
);

/* ---------- 「输入」按钮：面板输入框 → 作答区（PTA 禁粘贴时的快捷通道） ---------- */

state.injectArgs.length = 0;
state.writeOk = true;
const inputOk = await respond2({ type: 'code/input', code: 'int main(){return 0;}' }, { tab: { id: 7 } });
check(
  'code/input 走写入链路：先清空再用默认实现写',
  state.injectArgs.some((a) => a.method === 'clear') &&
    state.injectArgs.some((a) => a.method === 'dispatchFocus' && a.text === 'int main(){return 0;}'),
);
check('写入成功时回一句能直接展示的结果', inputOk.ok === true && inputOk.result.includes('已写入作答区'));

state.writeOk = false;
const inputFail = await respond2({ type: 'code/input', code: 'int main(){return 0;}' }, { tab: { id: 7 } });
check('四种方法都失败时如实回报失败（面板据此不清空输入框）', inputFail.ok === false);
check('失败时把每一次尝试的原因带回去', inputFail.result.includes('四种写入方法全部失败'));
state.writeOk = true;

const inputNoTab = await respond2({ type: 'code/input', code: 'x' });
check('拿不到标签页时给出提示而不是抛异常', inputNoTab.ok === false && inputNoTab.result.includes('当前页面不支持'));

/* ---------- 无 Key 短路 ---------- */

await respond2({ type: 'settings/save', patch: { apiKey: '' } });
const noKey = await respond2({ type: 'chat/start', requestId: 'r2', messages: [] }, { tab: { id: 7 } });
check('没配 Key 时返回提示', noKey.ok === false && noKey.message.includes('API Key'));

console.log(`\n${target} background 校验通过`);
