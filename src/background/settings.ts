import { ext } from '../shared/browser';
import { fetchModelContextWindow } from './model-context';
import { DEFAULT_SETTINGS, normalizeBaseURL, type Settings, type SettingsView } from '../shared/settings';

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

function parseSemver(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function isNewer(candidate: string, baseline: string): boolean {
  const [ma, pa, ta] = parseSemver(candidate);
  const [mb, pb, tb] = parseSemver(baseline);
  if (ma !== mb) return ma > mb;
  if (pa !== pb) return pa > pb;
  return ta > tb;
}

let cached: { available: boolean; latest: string } | null = null;
let cachedAt = 0;
const CACHE_TTL = 1000 * 60 * 60; // 1 小时内不重复请求

/** 检查 GitHub（失败则回退 Gitee）的最新 release 标签，与内置版本比对。 */
export async function checkForUpdates(): Promise<{ available: boolean; latest: string }> {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL) return cached;

  let latest = '';
  for (const url of [
    'https://api.github.com/repos/omp/PTA-BrowserPlugin/releases/latest',
    'https://gitee.com/api/v5/repos/omp/PTA-BrowserPlugin/releases/latest',
  ]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = (await res.json()) as { tag_name?: string };
      latest = json.tag_name || '';
      if (latest) break;
    } catch {
      continue;
    }
  }

  cached = { available: latest ? isNewer(latest, MANIFEST_VERSION) : false, latest };
  cachedAt = now;
  return cached;
}
