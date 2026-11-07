// 讲解页（/what 生成的苏格拉底式单页）的存与取。
//
// HTML 是模型生成的，不能直接塞进扩展页：扩展页有 chrome.* 权限，
// 而扩展页的 CSP 又拦掉内联脚本。这里用「沙箱 iframe + blob URL」两头都绕开：
//   · blob URL 不继承扩展页的 CSP，页面里的内联脚本能跑；
//   · iframe 加 sandbox（不给 allow-same-origin）→ 页面拿到的是不透明来源，
//     拿不到 chrome.*，也就碰不到 API Key。
import { ext } from '../shared/browser.ts';

const EXPLAIN_STORAGE_PREFIX = 'pta-assistant-explain:';
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
    [EXPLAIN_STORAGE_PREFIX + id]: { html, title, createdAt: Date.now() },
  });
  return id;
}

/**
 * 打开讲解页（新标签页）。
 *
 * 用 data: URL 直接开：生成页里的内联 <script> 在扩展页里会被扩展的 CSP 拦掉
 * （script-src 'self'），而 data: URL 自带一套 CSP，内联脚本能正常跑。
 * 页面本身是不透明来源，拿不到 chrome.*，也就碰不到 API Key。
 */
export async function openExplanation(id: string): Promise<void> {
  const stored = await ext.storage.local.get(EXPLAIN_STORAGE_PREFIX + id);
  const record = stored[EXPLAIN_STORAGE_PREFIX + id] as { html?: string } | undefined;
  if (!record?.html) {
    throw new Error('这份讲解页已经不在了（只保留最近几份）');
  }
  await ext.tabs.create({
    url: 'data:text/html;charset=utf-8,' + encodeURIComponent(record.html),
  });
}
