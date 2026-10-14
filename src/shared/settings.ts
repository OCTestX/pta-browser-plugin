export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 用 chrome.debugger 发真实按键（会让标签页顶部出现调试横幅），默认关 */
  useDebuggerInput: boolean;
  /** 编译运行 C 用的服务地址，按 Judge0 协议；默认是公共实例，可以换成自建的 */
  compileServiceURL: string;
  /** Judge0 的语言 ID：50 = C (GCC)，54 = C++ (GCC) */
  compileLanguageId: number;
}

/** 可以发给 content script 的部分，apiKey 永远不出 background */
export interface SettingsView {
  baseURL: string;
  model: string;
  hasApiKey: boolean;
  useDebuggerInput: boolean;
  compileServiceURL: string;
  compileLanguageId: number;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-v4.1-flash',
  useDebuggerInput: false,
  compileServiceURL: 'https://ce.judge0.com',
  compileLanguageId: 50,
};

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

export function normalizeLanguageId(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_SETTINGS.compileLanguageId;
}
