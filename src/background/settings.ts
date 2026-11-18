import { ext } from '../shared/browser';
import { fetchModelContextWindow } from './model-context';
import { DEFAULT_SETTINGS, normalizeBaseURL, type Settings, type SettingsView } from '../shared/settings';
import { isNewerVersion, pickPackageUrl, type ReleaseAsset } from '../shared/update-check';
import type { UpdateCheckResponse } from '../shared/messages';

const STORAGE_KEY = 'pta-assistant-settings';
/** 查上下文长度的总预算：用户点「保存」后最多多等这么久，超时就用兜底估算 */
const CONTEXT_LOOKUP_TIMEOUT_MS = 8000;

export async function loadSettings(): Promise<Settings> {
  const stored = await ext.storage.local.get(STORAGE_KEY);
  const saved = stored[STORAGE_KEY] as (Partial<Settings> & { useDebuggerInput?: unknown }) | undefined;
  // useDebuggerInput（用调试器发送真实按键）这个开关已经删掉，旧版本存过的值在这里顺手丢掉
  const { useDebuggerInput: _legacy, ...rest } = saved ?? {};
  return { ...DEFAULT_SETTINGS, ...rest };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  next.apiKey = next.apiKey.trim();
  next.baseURL = normalizeBaseURL(next.baseURL) || DEFAULT_SETTINGS.baseURL;
  next.model = next.model.trim() || DEFAULT_SETTINGS.model;
  // 换了模型或接口，之前查到的上下文长度就不作数了，先清掉，免得圆环按旧模型的窗口算
  if (next.model !== current.model || next.baseURL !== current.baseURL) {
    delete next.contextWindow;
  }
  await ext.storage.local.set({ [STORAGE_KEY]: next });

  // 顺手查一下模型真实的上下文长度（接口的 /models 优先，其次 models.dev 数据集）。
  // 查得到就存下来；查不到就不写这一项，前端会退回按模型名估算。
  // 整个查询有时间预算，用户点「保存」后不会干等。
  const result = await fetchModelContextWindow({
    baseURL: next.baseURL,
    apiKey: next.apiKey,
    model: next.model,
    timeoutMs: CONTEXT_LOOKUP_TIMEOUT_MS,
  }).catch(() => null);
  if (result?.window) {
    next.contextWindow = result.window;
    await ext.storage.local.set({ [STORAGE_KEY]: next });
  }
  return next;
}

export function toSettingsView(settings: Settings): SettingsView {
  return {
    baseURL: settings.baseURL,
    model: settings.model,
    hasApiKey: settings.apiKey.length > 0,
    vlmMode: settings.vlmMode,
    forcePtaRun: settings.forcePtaRun,
    contextWindow: settings.contextWindow,
  };
}

const MANIFEST_VERSION = ext.runtime.getManifest().version;

/**
 * 跑在 Firefox 上吗？
 * Firefox 的扩展页地址是 moz-extension://，Chrome 是 chrome-extension://，
 * 按协议头判最稳（不依赖构建时选了哪个 target）。
 */
const IS_FIREFOX = ext.runtime.getURL('').startsWith('moz-extension://');

/**
 * 查最新 release 的接口：先 GitHub（发版更勤），拿不到再退 Gitee。
 * 两个都是匿名访问，GitHub 每个源每小时只有 60 次，所以顺序请求、不并发。
 */
const RELEASE_APIS = [
  'https://api.github.com/repos/OCTestX/pta-browser-plugin/releases/latest',
  'https://gitee.com/api/v5/repos/octestx/pta-browser-plugin/releases/latest',
];

/** 单个源的等待上限（毫秒）：接口卡住时别把设置页挂在那儿不动 */
const RELEASE_TIMEOUT_MS = 8000;

/** release 接口回来的东西：只要标签与资产列表 */
interface ReleasePayload {
  tag_name?: string;
  assets?: ReleaseAsset[];
}

/** 带超时的 fetch：超时、限流、没网都安静地当作「这个源没查到」 */
async function fetchLatestRelease(url: string): Promise<ReleasePayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as ReleasePayload;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let cached: UpdateCheckResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 小时内不重复请求
/** 查失败的缓存只留 5 分钟：网络抽风时别把新版本挡太久，但别反复去打接口 */
const FAILURE_TTL = 1000 * 60 * 5;

/**
 * 检查结果存在 storage.local 里，不只放在内存里。
 *
 * MV3 的 service worker 空闲三十秒左右就被回收，内存缓存跟着一起没了：
 * 「打开设置页」这个动作几乎等于一次 GitHub 匿名请求，而 GitHub 匿名配额是
 * 60 次/小时/IP——PTA 的用户群集中在校园网，很容易被打到限流，
 * 之后两个源一起返回空，界面上只剩「没查到新版本（可能网络不通）」。
 */
const UPDATE_CACHE_KEY = 'pta-assistant-update-cache';

interface UpdateCacheEntry {
  result: UpdateCheckResponse | null;
  at: number;
  /** true 表示这次是查失败的（缓存只留 FAILURE_TTL 那么久） */
  failed?: boolean;
}

async function readUpdateCache(): Promise<UpdateCacheEntry | null> {
  try {
    const stored = await ext.storage.local.get(UPDATE_CACHE_KEY);
    const entry = stored[UPDATE_CACHE_KEY];
    if (entry && typeof entry === 'object' && 'at' in entry) {
      const value = entry as { at?: unknown; result?: unknown; failed?: unknown };
      if (typeof value.at !== 'number') return null;
      const result = value.result && typeof value.result === 'object' ? (value.result as UpdateCheckResponse) : null;
      return { at: value.at, result, failed: value.failed === true };
    }
  } catch {
    /* 读不到就当没有缓存 */
  }
  return null;
}

async function writeUpdateCache(entry: UpdateCacheEntry): Promise<void> {
  try {
    await ext.storage.local.set({ [UPDATE_CACHE_KEY]: entry });
  } catch {
    /* 写不进去不影响功能 */
  }
}

/**
 * 查最新 release 标签，与内置版本比对；顺带挑出当前浏览器能装的包。
 *
 * force=true 时跳过缓存重新请求（设置页的「检查更新」按钮用）。
 * 查不到（断网、限流、两个源都挂了）时如实说没有，但不去覆盖缓存里的旧结果。
 */
export async function checkForUpdates(force = false): Promise<UpdateCheckResponse> {
  const now = Date.now();
  if (!force) {
    // 内存里没有就从 storage 里捞：service worker 被回收过之后缓存还在
    if (!cached) {
      const entry = await readUpdateCache();
      if (entry) {
        const ttl = entry.failed ? FAILURE_TTL : CACHE_TTL;
        if (now - entry.at < ttl) {
          if (entry.result) {
            cached = entry.result;
            cachedAt = entry.at;
          } else {
            // 五分钟前刚查失败过：别再去打接口了（配额有限），先把「没有新版本」报出去。
            // 用户点设置页的「检查更新」按钮能强制重来。
            return cached ?? { available: false, latest: '', current: MANIFEST_VERSION, packageUrl: '' };
          }
        }
      }
    }
    if (cached && now - cachedAt < CACHE_TTL) return cached;
  }

  let latest = '';
  let assets: ReleaseAsset[] = [];
  let tagWithoutPackage = '';
  for (const url of RELEASE_APIS) {
    const payload = await fetchLatestRelease(url);
    const tag = payload?.tag_name?.trim() ?? '';
    if (!tag) continue;
    // 光有标签不算数：GitHub 上可能建了 release 却没传安装包，
    // 这时应该接着问另一个源，而不是拿着一份「有新版但下不了」的结果就收工。
    const packageUrl = pickPackageUrl(payload?.assets ?? [], IS_FIREFOX ? 'xpi' : 'zip');
    if (!packageUrl) {
      if (!tagWithoutPackage) tagWithoutPackage = tag;
      continue;
    }
    latest = tag;
    assets = payload?.assets ?? [];
    break;
  }

  if (!latest && tagWithoutPackage && isNewerVersion(tagWithoutPackage, MANIFEST_VERSION)) {
    // 两个源都只有标签、没有能装的包：如实说「有新版但下不了」，
    // 装成「没有新版本」等于骗用户——版本确实发布了，只是作者还没传包。
    cached = {
      available: true,
      latest: tagWithoutPackage,
      current: MANIFEST_VERSION,
      packageUrl: '',
    };
    cachedAt = now;
    await writeUpdateCache({ result: cached, at: now });
    return cached;
  }

  if (!latest) {
    // 查不到：把「这次没查到」也记下来（只留 5 分钟），别让用户每开一次设置页
    // 就打一次匿名接口——GitHub 的匿名配额是 60 次/小时/IP，校园网很容易被打爆。
    // 已经知道的旧结果照旧报出去——某个版本发布过是事实，不会因为这次没查到就不算数，
    // 总不能让用户点一次「检查更新」就把横幅弄没了。
    await writeUpdateCache({ result: null, at: now, failed: true });
    return cached ?? { available: false, latest: '', current: MANIFEST_VERSION, packageUrl: '' };
  }

  cached = {
    available: isNewerVersion(latest, MANIFEST_VERSION),
    latest,
    current: MANIFEST_VERSION,
    packageUrl: pickPackageUrl(assets, IS_FIREFOX ? 'xpi' : 'zip'),
  };
  cachedAt = now;
  await writeUpdateCache({ result: cached, at: now });
  return cached;
}
