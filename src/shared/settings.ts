export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 用 chrome.debugger 发真实按键（会让标签页顶部出现调试横幅），默认关 */
  useDebuggerInput: boolean;
}

/** 可以发给 content script 的部分，apiKey 永远不出 background */
export interface SettingsView {
  baseURL: string;
  model: string;
  hasApiKey: boolean;
  useDebuggerInput: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4.1-flash',
  useDebuggerInput: false,
};

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}
