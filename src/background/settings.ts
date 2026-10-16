import { ext } from '../shared/browser';
import { DEFAULT_SETTINGS, normalizeBaseURL, type Settings, type SettingsView } from '../shared/settings';

const STORAGE_KEY = 'pta-assistant-settings';

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
  await ext.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

export function toSettingsView(settings: Settings): SettingsView {
  return {
    baseURL: settings.baseURL,
    model: settings.model,
    hasApiKey: settings.apiKey.length > 0,
  };
}
