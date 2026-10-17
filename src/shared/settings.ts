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
  // 默认走硅基流动：OpenAI 兼容，/v1/chat/completions 正好对上下面拼的 /chat/completions
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
};

/** 设置页「教程」按钮跳到的地址（作者自己的站点，讲清楚怎么配 Key 怎么用） */
export const TUTORIAL_URL = 'http://octestpi.top/pta-assist-plugin';

/** 作者卡片里的硅基流动邀请链接（带邀请码的注册页） */
export const SILICONFLOW_INVITE_URL = 'https://cloud.siliconflow.cn/i/oU1ajhss';

export function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, '');
}
