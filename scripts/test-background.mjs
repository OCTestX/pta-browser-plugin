// 用桩模拟 Chrome 的扩展 API，跑打包后的 background.js，验证「点图标」这条链路：
// 正常情况直接发 toggle-panel；页面里没有 content script 时先补注入再发；设置能落进 storage。
// 用法：node scripts/test-background.mjs [chrome|firefox]
const target = process.argv[2] ?? 'chrome';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const calls = [];
const storage = {};
const channels = { action: [], message: [] };
// 页面里是否已有 content script，用来控制 tabs.sendMessage 成功还是失败
let contentScriptPresent = true;

// 这个测试不该真的发请求
globalThis.fetch = async () => {
  throw new Error('测试里不应该真的请求接口');
};

globalThis.chrome = {
  action: { onClicked: { addListener: (fn) => channels.action.push(fn) } },
  runtime: { onMessage: { addListener: (fn) => channels.message.push(fn) } },
  tabs: {
    sendMessage: async (tabId, message) => {
      calls.push(`tabs.sendMessage(${tabId}, ${message.type})`);
      if (!contentScriptPresent) throw new Error('Could not establish connection.');
      return undefined;
    },
  },
  scripting: {
    executeScript: async ({ target: tabTarget, files }) => {
      calls.push(`scripting.executeScript(${tabTarget.tabId}, ${files.join(',')})`);
      contentScriptPresent = true; // 注入之后页面里就有 content script 了
    },
  },
  storage: {
    local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (patch) => Object.assign(storage, patch),
    },
  },
};

delete globalThis.browser;
await import(`../dist/${target}/background.js`);

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
check('background 载入后注册了图标点击监听', channels.action.length === 1);
check('background 载入后注册了消息监听', channels.message.length === 1);

/* 场景一：页面里已经有 content script */
calls.length = 0;
channels.action.forEach((fn) => fn({ id: 7 }));
await tick();
check(
  '有 content script 时直接发 toggle-panel',
  calls.length === 1 && calls[0] === 'tabs.sendMessage(7, toggle-panel)',
);

/* 场景二：页面在插件安装之前就打开了，没有 content script */
calls.length = 0;
contentScriptPresent = false;
channels.action.forEach((fn) => fn({ id: 8 }));
await tick();
check(
  '没有 content script 时先补注入再发 toggle-panel',
  calls.join(' > ') ===
    'tabs.sendMessage(8, toggle-panel) > scripting.executeScript(8, content.js) > tabs.sendMessage(8, toggle-panel)',
);

/* 场景三：设置经由 background 落到 storage，且返回给页面的视图里没有 Key */
calls.length = 0;
const respond = (message, sender = {}) =>
  new Promise((resolve) => {
    const keepOpen = channels.message[0](message, sender, resolve);
    if (!keepOpen) resolve(undefined);
  });

await respond({ type: 'settings/save', patch: { apiKey: 'sk-secret', model: 'deepseek-v4.1-flash' } });
const view = await respond({ type: 'settings/get' });
check('settings/save 把 Key 写进了 storage', storage['pta-assistant-settings'].apiKey === 'sk-secret');
check('返回给页面的视图里不含 apiKey 字段', !('apiKey' in view) && view.hasApiKey === true);

/* 场景四：没有 Key 时 chat/start 直接返回失败，不会去请求接口 */
await respond({ type: 'settings/save', patch: { apiKey: '' } });
calls.length = 0;
const noKey = await respond({ type: 'chat/start', requestId: 'r1', turns: [] }, { tab: { id: 9 } });
check('没配 Key 时 chat/start 返回提示而不是发请求', noKey.ok === false && noKey.message.includes('API Key'));
check('没配 Key 时没有发出任何请求', calls.length === 0);

console.log(`\n${target} background 校验通过`);
