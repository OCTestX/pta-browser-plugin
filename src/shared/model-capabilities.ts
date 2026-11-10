/**
 * 模型能力（目前只有「能不能看图」）集中在这里维护。
 *
 * 设置页的 eye 图标、agent 的视觉模式判断都从这里取：
 * 增删模型只改这一张表，别在别处再抄一份前缀列表。
 */

import type { ApiMessage } from './types';

/** 视觉模式：auto 按题面是否有图片自动切换；on 强制开启；off 强制关闭 */
export type VlmMode = 'auto' | 'on' | 'off';

export interface ModelCapability {
  /** 模型名里包含这一段就算命中（统一小写比较，按表的顺序先命中先用，具体型号写在家族前面） */
  match: string;
  /** 是否支持图像输入 */
  vision: boolean;
  /** 设置页 tooltip、降级提示里给人看的名字 */
  label: string;
}

/**
 * 实测过 / 明确已知的能力表。
 *
 * `Qwen3.8-27B` 在硅基流动上能收 image_url；`DeepSeek-V4.1-Flash` 是纯文本模型。
 * 后面几条是按家族名推断的（没有逐个型号实测），命中就算支持。
 */
export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  // 具体型号：实测结论，必须排在家族前缀前面
  { match: 'qwen3.8-27b', vision: true, label: 'Qwen3.8-27B' },
  { match: 'deepseek-v4.1-flash', vision: false, label: 'DeepSeek-V4.1-Flash' },
  // 视觉家族：名字里带这些的通常都能收图
  { match: 'qwen-vl', vision: true, label: 'Qwen-VL 系列' },
  { match: 'qwen2-vl', vision: true, label: 'Qwen2-VL 系列' },
  { match: 'qwen2.5-vl', vision: true, label: 'Qwen2.5-VL 系列' },
  { match: 'qwen3-vl', vision: true, label: 'Qwen3-VL 系列' },
  { match: 'deepseek-vl', vision: true, label: 'DeepSeek-VL 系列' },
  { match: 'gpt-4o', vision: true, label: 'GPT-4o 系列' },
  { match: 'gpt-4-turbo', vision: true, label: 'GPT-4 Turbo 系列' },
  { match: 'gpt-4-vision', vision: true, label: 'GPT-4 Vision 系列' },
  { match: 'claude-3', vision: true, label: 'Claude 3 系列' },
  { match: 'claude-4', vision: true, label: 'Claude 4 系列' },
  { match: 'gemini-', vision: true, label: 'Gemini 系列' },
];

/** 查这个模型名命中哪一条能力（没命中返回 null，视为未知） */
export function findModelCapability(model: string): ModelCapability | null {
  const name = String(model ?? '').trim().toLowerCase();
  if (!name) return null;
  return MODEL_CAPABILITIES.find((item) => name.includes(item.match)) ?? null;
}

/** 这个模型能不能收图；未知模型按不支持处理（宁可降级，也不要假装看过图） */
export function modelSupportsVision(model: string): boolean {
  return findModelCapability(model)?.vision === true;
}

/** 设置页图标/提示用的一句话说明 */
export function modelVisionTitle(model: string): string {
  const capability = findModelCapability(model);
  if (capability?.vision) return `${capability.label}：支持看图（可接收 image_url 图像输入）`;
  if (capability && !capability.vision) return `${capability.label}：纯文本模型，不支持看图`;
  return '未知模型的视觉能力：按不支持看图处理';
}

/** 视觉模式的判定结果：active 才真正发图，其余都是「没发图」的明确原因 */
export type VisionDecision = 'active' | 'off' | 'unsupported-model' | 'no-images';

/**
 * 按设置、模型能力和题面是否有图，决定这一轮要不要真的发图。
 *
 * `off` 永远优先：用户关掉了视觉模式，就算模型能看图也不发，
 * 更不能提示「支持看图」。
 */
export function decideVisionMode(options: {
  mode: VlmMode;
  model: string;
  hasImages: boolean;
}): VisionDecision {
  if (!options.hasImages) return 'no-images';
  if (options.mode === 'off') return 'off';
  if (!modelSupportsVision(options.model)) return 'unsupported-model';
  return 'active';
}

export interface ExtractedImages {
  /** 能真正发给模型的图片地址（只收 http(s)，去重、保持题面里的顺序） */
  urls: string[];
  /** 有图片占位、但拿不到可发送地址的个数（典型是内嵌 data: URI） */
  skipped: number;
}

/** 把相对地址按当前页面补全；data: / blob: 这类拿不到可发送地址的返回 null */
function resolveImageUrl(raw: string, pageUrl?: string): string | null {
  try {
    const base = pageUrl && /^https?:/i.test(pageUrl) ? pageUrl : undefined;
    // 协议相对地址（//host/x）没有页面地址时也能补成 https
    const candidate = raw.startsWith('//') ? `https:${raw}` : raw;
    const url = new URL(candidate, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 从 read_problem 的题面文字里抠出图片地址。
 *
 * 占位格式由 pta-scripts 的 imagePlaceholder 固定：
 * `[图片（476×174）：if编程.jpg <https://…>]`；没有 src 或 src 是 data: 时只有类型标记，
 * 这种情况没有可发送的地址，计入 skipped —— 绝不拿它伪造一张图。
 */
export function extractImageUrls(statement: string, pageUrl?: string): ExtractedImages {
  const urls: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const pattern = /\[图片[^\]]*<([^<>\s]+)>\]/g;
  for (const match of String(statement ?? '').matchAll(pattern)) {
    const resolved = resolveImageUrl(match[1], pageUrl);
    if (!resolved) {
      skipped += 1;
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    urls.push(resolved);
  }
  return { urls, skipped };
}

/** OpenAI 兼容的文本内容块 */
export interface ApiTextPart {
  type: 'text';
  text: string;
}

/** OpenAI 兼容的图像内容块 */
export interface ApiImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ApiContentPart = ApiTextPart | ApiImagePart;

/**
 * 带图像输入的 user 消息。
 *
 * ApiMessage 声明的 content 只有字符串；视觉消息在运行时是内容块数组，
 * 接口的 JSON 正是这个形状（见 agent 里的 pushVisionMessage）。
 */
export type VisionApiMessage = Omit<ApiMessage, 'content'> & {
  content: string | null | ApiContentPart[];
};

/** 组一条「说明文字 + N 张图」的 user 消息，顺序就是模型看到的顺序 */
export function visionUserMessage(text: string, urls: readonly string[]): VisionApiMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...urls.map((url): ApiImagePart => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}
