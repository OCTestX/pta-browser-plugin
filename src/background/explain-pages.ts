// 讲解页（/what 生成的苏格拉底式单页）的存与取。
//
// HTML 是模型生成的，不能直接铺在扩展页上：扩展页有 chrome.* 权限，
// 模型产的脚本一旦跑在扩展页里就等于拿到 API Key。
// 现在走「PTA 站点上的固定路径 + 沙箱 iframe」：
//   · 讲解页开成 https://pintia.cn/pta-assistant/explain?id=xxx（地址栏是正常网址，没有长度上限）；
//   · 真正的内容由内容脚本放进 <iframe sandbox="allow-scripts ..."> 里（不给 allow-same-origin），
//     iframe 因此是不透明来源：拿不到 chrome.*、拿不到 cookie、读不到父页面；
//   · PTA 没发 CSP 头，srcdoc 继承不到限制，模型产的脚本能正常跑
//     （扩展页做不到这点：Chrome 不允许在扩展页 CSP 里写 'unsafe-inline'）。
import { ext } from '../shared/browser.ts';
import {
  buildExplainUrl,
  decodeRawTextEntities,
  explainStorageKey,
  EXPLAIN_STORAGE_PREFIX,
} from '../shared/explain-html.ts';

/**
 * 讲解页（/what 生成的苏格拉底式单页）的存与取。
 *
 * HTML 是模型生成的，不能直接铺在扩展页上：扩展页有 chrome.* 权限，
 * 模型产的脚本一旦跑在扩展页里就等于拿到 API Key；而且扩展页的 CSP
 * （script-src 'self' 'wasm-unsafe-eval'）根本不让跑模型产的内联脚本。
 *
 * 现在开在 PTA 站点上的一个固定路径（/pta-assistant/explain?id=xxx），
 * 由内容脚本把 HTML 装进沙箱 iframe 里渲染：
 *   · 不给 allow-same-origin → iframe 是不透明来源：拿不到 chrome.*（也就拿不到 API Key）、
 *     拿不到 cookie、读不到父页面；
 *   · PTA 没有发 CSP 头，srcdoc 继承不到限制，模型产的脚本能正常跑。
 */

/** 最多留几份，旧的清掉 */
const EXPLAIN_KEEP = 8;

function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 存一份讲解页，返回取回用的 id */
export async function storeExplanation(html: string, title: string): Promise<string> {
  const id = createId();
  // 先清旧的再写新的：反过来会把刚写的这份一起当成「旧的」删掉
  const all = await ext.storage.local.get(null);
  const existing = Object.keys(all)
    .filter((key) => key.startsWith(EXPLAIN_STORAGE_PREFIX))
    .map((key) => ({
      key,
      createdAt: Number((all[key] as { createdAt?: number } | undefined)?.createdAt ?? 0),
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
  const stale = existing.slice(0, Math.max(0, existing.length - (EXPLAIN_KEEP - 1)));
  if (stale.length) await ext.storage.local.remove(stale.map((item) => item.key));
  await ext.storage.local.set({
    [explainStorageKey(id)]: {
      // 存之前先解一层 script/style 里的实体：模型爱把 > 写成 &gt;，
      // 而 raw-text 元素里的实体浏览器不会解，页面会显示出字面的 &gt;
      html: decodeRawTextEntities(html),
      title,
      createdAt: Date.now(),
    },
  });
  return id;
}

/**
 * 打开讲解页（新标签页）。
 *
 * 开的是 PTA 站点上的一个固定路径（/pta-assistant/explain?id=xxx）：
 * 内容脚本认出这个路径后，会把模型产出的 HTML 装进沙箱 iframe 里渲染。
 *
 * 不用扩展页是因为扩展页的 CSP 不允许跑模型产的内联脚本（详见 shared/explain-html.ts 的说明）；
 * 也不用 data: URL，是因为地址栏里会显示两万多字符的 HTML，而且有长度上限。
 */
export async function openExplanation(id: string): Promise<void> {
  const key = explainStorageKey(id);
  const stored = await ext.storage.local.get(key);
  const record = stored[key] as { html?: string } | undefined;
  if (!record?.html) {
    throw new Error('这份讲解页已经不在了（只保留最近几份）');
  }
  await ext.tabs.create({ url: buildExplainUrl(id) });
}
