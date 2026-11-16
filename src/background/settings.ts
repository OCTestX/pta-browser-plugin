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

/**
 * 查最新 release 标签，与内置版本比对；顺带挑出当前浏览器能装的包。
 *
 * force=true 时跳过缓存重新请求（设置页的「检查更新」按钮用）。
 * 查不到（断网、限流、两个源都挂了）时如实说没有，但不去覆盖缓存里的旧结果。
 */
export async function checkForUpdates(force = false): Promise<UpdateCheckResponse> {
  const now = Date.now();
  if (!force && cached && now - cachedAt < CACHE_TTL) return cached;

  let latest = '';
  let assets: ReleaseAsset[] = [];
  for (const url of RELEASE_APIS) {
    const payload = await fetchLatestRelease(url);
    const tag = payload?.tag_name?.trim() ?? '';
    if (!tag) continue;
    latest = tag;
    assets = payload?.assets ?? [];
    break;
  }

  if (!latest) {
    // 没查到就不写缓存：网络多半是临时抽风，缓存一小时会把新版本硬生生挡掉。
    // 已经知道的旧结果照旧报出去——某个版本发布过是事实，不会因为这次没查到就不算数，
    // 总不能让用户点一次「检查更新」就把横幅弄没了。
    return cached ?? { available: false, latest: '', current: MANIFEST_VERSION, packageUrl: '' };
  }

  cached = {
    available: isNewerVersion(latest, MANIFEST_VERSION),
    latest,
    current: MANIFEST_VERSION,
    packageUrl: pickPackageUrl(assets, IS_FIREFOX ? 'xpi' : 'zip'),
  };
  cachedAt = now;
  return cached;
}
