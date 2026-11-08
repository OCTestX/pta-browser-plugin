// 讲解页（/what 生成的那份 HTML）在页面里的渲染。
//
// 为什么要单独一套：
//   · 模型产出的 HTML 是不可信内容，不能铺在扩展页上（扩展页有 chrome.*，等于把 API Key 摆给它）；
//   · 也不能铺在顶层文档里（那样它就跟着 PTA 的来源走，能碰到 PTA 的 cookie）；
//   · 扩展页的 CSP 又根本不让跑模型产的内联脚本（Chrome 不允许在扩展页 CSP 里写 'unsafe-inline'）。
//
// 所以：讲解页开在 PTA 站点上的固定路径（/pta-assistant/explain?id=xxx），
// 由这里把整份 HTML 装进一个**沙箱 iframe**：
//   · sandbox 不给 allow-same-origin → iframe 是不透明来源（origin 为 null）：
//     读不到父页面、拿不到 cookie、拿不到 chrome.*；
//   · PTA 没发 CSP 头，srcdoc 继承不到限制，模型产的脚本能正常跑。
import { ext } from '../shared/browser';
import { explainStorageKey, parseExplainPageId } from '../shared/explain-html';

const HOST_ID = 'pta-assistant-explain';
/** 页面不是从插件进来的（用户自己敲地址）时，最多等这么久去要内容 */
const LOAD_TIMEOUT_MS = 8000;

/** 这个页面是不是讲解页 */
export function explainPageId(): string | null {
  return parseExplainPageId(location.href);
}

/** 讲解页的标题（拿不到就先用默认的） */
function setTitle(title: string): void {
  document.title = title;
}

/** 从扩展的存储里取出讲解页的内容 */
async function loadExplain(pageId: string): Promise<{ html: string; title: string } | null> {
  try {
    const stored = await ext.storage.local.get(explainStorageKey(pageId));
    const record = stored[explainStorageKey(pageId)] as { html?: unknown; title?: unknown } | undefined;
    if (!record || typeof record.html !== 'string' || !record.html) return null;
    return {
      html: record.html,
      title: typeof record.title === 'string' ? record.title : '讲解页',
    };
  } catch {
    return null;
  }
}

/** 页面上的提示（内容取不到时用） */
function showMessage(text: string): void {
  const box = document.createElement('div');
  box.style.cssText = [
    'position:fixed', 'inset:0', 'display:flex', 'align-items:center', 'justify-content:center',
    'background:#fff', 'color:#555', 'font:14px/1.8 system-ui, sans-serif', 'z-index:2147483647',
    'text-align:center', 'padding:24px',
  ].join(';');
  box.textContent = text;
  document.documentElement.appendChild(box);
}

/**
 * 把讲解页渲染出来。
 *
 * 返回 true 表示「这个页面已经被讲解页接管了」，调用方就不该再挂悬浮窗。
 */
export async function renderExplainPage(): Promise<boolean> {
  const pageId = explainPageId();
  if (!pageId) return false;
  if (document.getElementById(HOST_ID)) return true;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;';
  document.documentElement.appendChild(host);

  setTitle('PTA 助手 · 讲解页');

  const record = await Promise.race([
    loadExplain(pageId),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LOAD_TIMEOUT_MS)),
  ]);
  if (!record) {
    host.remove();
    showMessage('这份讲解页已经不在了（只保留最近几份）');
    return true;
  }

  setTitle(`PTA 助手 · ${record.title}`);

  const frame = document.createElement('iframe');
  // 不给 allow-same-origin：iframe 因此是不透明来源，拿不到 chrome.*、cookie，也读不到父页面
  frame.setAttribute('sandbox', 'allow-scripts allow-popups allow-forms');
  // 用属性赋值而不是拼 HTML 字符串：srcdoc 的值原样进入文档，不会多解一层实体
  frame.setAttribute('srcdoc', record.html);
  frame.style.cssText = 'display:block;width:100%;height:100%;border:0;';
  host.appendChild(frame);

  // PTA 自己那个 404 页面在下面，用白底盖住，免得闪一下
  document.documentElement.style.background = '#fff';
  return true;
}
