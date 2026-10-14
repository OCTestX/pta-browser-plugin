// 冒烟测试：检查 dist 里的清单是否完整，再把 content.js 放进 jsdom 验证悬浮窗能挂载、能被开关、能收发消息。
// 用法：node scripts/smoke.mjs [chrome|firefox]
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const target = process.argv[2] ?? 'chrome';
const outDir = `dist/${target}`;

const manifest = JSON.parse(readFileSync(`${outDir}/manifest.json`, 'utf8'));
const referenced = [
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
  ...(manifest.background?.scripts ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
];
const missing = referenced.filter((file) => !existsSync(`${outDir}/${file}`));
if (missing.length > 0) {
  throw new Error(`✗ 清单引用的文件不存在：${missing.join(', ')}（先跑 npm run build）`);
}
console.log(`✓ 清单引用的 ${new Set(referenced).size} 个文件都存在（manifest_version ${manifest.manifest_version}）`);

const code = readFileSync(`${outDir}/content.js`, 'utf8');

const dom = new JSDOM('<!doctype html><html><body><p>题目页面</p></body></html>', {
  url: 'https://pintia.cn/problem-sets/1/problems/1',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});
const { window } = dom;

const messageListeners = [];
window.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => messageListeners.push(fn),
      removeListener: () => {},
    },
  },
};
window.eval(code);

const tick = () => new Promise((resolve) => setTimeout(resolve, 100));
const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

await tick();

const host = window.document.getElementById('pta-assistant-host');
check('宿主节点已注入页面', Boolean(host?.shadowRoot));
const shadow = host.shadowRoot;
check('样式已注入 shadow root', (shadow.querySelector('style')?.textContent ?? '').includes('.panel'));
check('未点击图标时悬浮窗不显示', !shadow.querySelector('.panel'));

messageListeners.forEach((fn) => fn({ type: 'toggle-panel' }));
await tick();
check('点击图标后悬浮窗出现', Boolean(shadow.querySelector('.panel')));
check('聊天区存在', Boolean(shadow.querySelector('.messages')));
check('输入框存在', Boolean(shadow.querySelector('.composer__input')));

const textarea = shadow.querySelector('.composer__input');
const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setValue.call(textarea, '帮我看看这道题');
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
await tick();
check('发送按钮在输入后可用', !shadow.querySelector('.composer__send').disabled);

shadow.querySelector('.composer__send').click();
await tick();
check('消息出现在聊天区', shadow.querySelector('.messages').textContent.includes('帮我看看这道题'));
check('输入框已清空', shadow.querySelector('.composer__input').value === '');

messageListeners.forEach((fn) => fn({ type: 'toggle-panel' }));
await tick();
check('再次点击图标后悬浮窗收起', !shadow.querySelector('.panel'));

console.log(`\n${target} 冒烟测试通过`);
