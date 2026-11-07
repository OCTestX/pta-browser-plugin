export interface Settings {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 视觉模式：auto 按题面是否有图片自动切换；on 强制开启；off 强制关闭 */
  vlmMode: 'auto' | 'on' | 'off';
  /**
   * 强制用 PTA 自己的运行环境跑代码（默认关）。
   * 打开后 compile_and_run_c / _python / _js 一律改走 PTA 的测试面板，
   * 用 PTA 的编译器编译、PTA 的机器跑，编译错误也从 PTA 的「编译器输出」里读。
   */
  forcePtaRun: boolean;
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
  /** 视觉模式（自/开/关） */
  vlmMode?: 'auto' | 'on' | 'off';
  /** 是否强制用 PTA 的运行环境跑代码（默认关） */
  forcePtaRun?: boolean;
  /** 是否检测到有新版本可用 */
  updateAvailable?: boolean;
  /** 最新发布的标签名（如 v3.4.0），用于在提示里展示 */
  latestVersion?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  // 默认走硅基流动：OpenAI 兼容，/v1/chat/completions 正好对上下面拼的 /chat/completions
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  vlmMode: 'auto',
  // 默认不强制：还是用插件内置的编译器（PTA 自己的运行环境留给没有内置编译器的语言）
  forcePtaRun: false,
};

/** 设置页「教程」按钮跳到的地址（作者自己的站点，讲清楚怎么配 Key 怎么用） */
export const TUTORIAL_URL = 'https://me.octest.top/pta-assist-plugin';

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

/** 已知能看图的模型前缀，命中才允许按 VLM 模式工作 */
export function modelSupportsVlm(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  const visionPrefixes = [
    'qwen-vl', 'qwen-vl-',
    'deepseek-vl',
    'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision',
    'claude-3', 'claude-3.5', 'claude-4',
    'gemini-',
  ];
  return visionPrefixes.some((prefix) => m.startsWith(prefix));
}

/** 判断题面文字里是否包含图片占位（read_problem 把图片摊平成 [图片 ...]） */
export function statementHasImages(text: string): boolean {
  return /\[图片/.test(text ?? '');
}

/**
 * 模型的上下文窗口（估算值）。
 *
 * 接口只回传用量、不回传窗口大小，所以这里按模型名猜一个：
 * 猜不准只影响那个小圆环的百分比，tooltip 里会写明是按多少算的。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: string): number {
  const name = (model ?? '').toLowerCase();
  if (name.startsWith('claude-')) return 200_000;
  if (name.startsWith('gemini-')) return 1_000_000;
  if (name.startsWith('gpt-4')) return 128_000;
  if (name.startsWith('qwen')) return 128_000;
  return DEFAULT_CONTEXT_WINDOW;
}
