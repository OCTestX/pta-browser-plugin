export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** 内置的模型提供商：设置页点一下就把接口地址填上，省得手打 */
export interface ProviderPreset {
  id: string;
  label: string;
  baseURL: string;
}

/**
 * 这两家的接口地址是 manifest 里放行了 host 权限的，所以「加载模型列表」能直接请求。
 * 想接别家就自己填接口地址（模型列表可能要那个站点也放行跨域）。
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'siliconflow', label: '硅基流动', baseURL: 'https://api.siliconflow.cn/v1' },
  { id: 'deepseek', label: '深度求索', baseURL: 'https://api.deepseek.com/v1' },
];

/** 可以发给 content script 的部分，apiKey 永远不出 background */
export interface SettingsView {
  baseURL: string;
  model: string;
  hasApiKey: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  // 默认走硅基流动：OpenAI 兼容，/v1/chat/completions 正好对上下面拼的 /chat/completions
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
};

/** 设置页「教程」按钮跳到的地址（作者自己的站点，讲清楚怎么配 Key 怎么用） */
export const TUTORIAL_URL = 'http://octestpi.top/pta-assist-plugin';

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}

/** 接口地址填完整了没有：要能当成 http(s) 地址用，才好去问它「有哪些模型」 */
export function isCompleteBaseURL(baseURL: string): boolean {
  const value = normalizeBaseURL(baseURL);
  if (!value) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
