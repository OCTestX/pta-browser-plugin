// 冒烟测试：检查 dist 里的清单是否完整，再把 content.js 放进 jsdom，
// 用打桩的 background 验证悬浮窗挂载、开关、流式对话、未配置 Key 的提示与设置保存。
// 用法：node scripts/smoke.mjs [chrome|firefox]
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const target = process.argv[2] ?? 'chrome';
const outDir = `dist/${target}`;

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
const tick = () => new Promise((resolve) => setTimeout(resolve, 100));
const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

function boot({ hasApiKey }) {
  const dom = new JSDOM('<!doctype html><html><body><p>题目页面</p></body></html>', {
    url: 'https://pintia.cn/problem-sets/1/problems/1',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const listeners = [];
  const requests = [];
  let keySet = hasApiKey;

  // 打桩的 background：只实现 content script 依赖的那几个消息
  window.chrome = {
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
          default:
            return undefined;
        }
      },
    },
  };

  const view = () => ({
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4.1-flash',
    hasApiKey: keySet,
  });

  window.eval(code);

  return {
    window,
    requests,
    shadow: () => window.document.getElementById('pta-assistant-host')?.shadowRoot,
    toggle: () => listeners.forEach((fn) => fn({ type: 'toggle-panel' })),
    emit: (event) => listeners.forEach((fn) => fn(event)),
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

withKey.emit({ type: 'chat/done', requestId, aborted: false });
await tick();
check('生成结束后按钮变回发送', withKey.find('.composer__send').textContent === '发送');
check('生成结束后光标消失', !withKey.find('.bubble__cursor'));
check('输入框恢复可用', !withKey.find('.composer__input').disabled);

withKey.find('.panel__close[title="设置"]').click();
await tick();
check('齿轮进入设置页', Boolean(withKey.find('.settings')));
check('设置页带上了已保存的接口地址', withKey.find('.field__input[type="text"]').value === 'https://api.deepseek.com');

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

console.log(`\n${target} 冒烟测试通过`);
