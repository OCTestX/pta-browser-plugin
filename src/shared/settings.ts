export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** 可以发给 content script 的部分，apiKey 永远不出 background */
export interface SettingsView {
  baseURL: string;
  model: string;
  hasApiKey: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4.1-flash',
};

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}
