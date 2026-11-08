import {
  extractContextWindowFromModels,
  extractContextWindowFromModelsDev,
} from '../shared/model-context.ts';
import { isCompleteBaseURL, normalizeBaseURL } from '../shared/settings.ts';

// 纯逻辑也在后台这边再导出一次，方便直接从本模块引用
export { extractContextWindowFromModels, extractContextWindowFromModelsDev };

/**
 * 查模型真实的上下文长度。
 *
 * API Key 只有后台拿得到，所以联网查询必须放后台；content script 只能用存下来的结果。
 * 查找顺序：接口自己说的 → models.dev 公共数据集 → 兜底（交给调用方那张按模型名猜的表）。
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
/** 整次查询的时间预算：用户点「保存」后最多多等这么久，超时就用兜底估算 */
const DEFAULT_TIMEOUT_MS = 8000;
/** 每一步各占一半预算，免得接口那边卡住把数据集那一步饿死 */
const PER_STEP_TIMEOUT_MS = DEFAULT_TIMEOUT_MS / 2;

export interface ModelContextResult {
  /** 上下文窗口大小；查不到就是 null（调用方走兜底表） */
  window: number | null;
  /** 这个值是从哪儿来的 */
  source: 'provider' | 'models.dev' | 'fallback';
}

/** models.dev 的数据集挺大，service worker 活着的时候只用下一次 */
let modelsDevDataset: unknown = null;

/** 带超时的 fetch：超时/失败都当成「没查到」，绝不把异常抛给调用方 */
async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    // CORS、host 权限缺失、超时、网络断了：都安静失败，交给下一步
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchModelContextWindow(options: {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 整次查询的时间预算（毫秒），默认 8 秒 */
  timeoutMs?: number;
}): Promise<ModelContextResult> {
  const model = (options.model ?? '').trim();
  if (!model) return { window: null, source: 'fallback' };

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const remaining = () => deadline - Date.now();

  // 第一步：接口自己说的（OpenAI 兼容的 GET {baseURL}/models）
  const base = normalizeBaseURL(options.baseURL ?? '');
  if (isCompleteBaseURL(base) && remaining() > 0) {
    const headers: Record<string, string> = {};
    const apiKey = (options.apiKey ?? '').trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const payload = await fetchJson(`${base}/models`, { headers }, Math.min(remaining(), PER_STEP_TIMEOUT_MS));
    const found = extractContextWindowFromModels(payload, model);
    if (found) return { window: found, source: 'provider' };
  }

  // 第二步：models.dev 公共数据集（无需 Key，需要 manifest 里放行 models.dev）
  if (remaining() > 0) {
    try {
      if (modelsDevDataset === null) {
        const dataset = await fetchJson(MODELS_DEV_URL, {}, Math.min(remaining(), PER_STEP_TIMEOUT_MS));
        if (dataset !== null) modelsDevDataset = dataset;
      }
      const found = extractContextWindowFromModelsDev(modelsDevDataset, model);
      if (found) return { window: found, source: 'models.dev' };
    } catch {
      // 权限没加 / 断网：继续走兜底
    }
  }

  // 第三步：查不到，交给调用方的兜底表
  return { window: null, source: 'fallback' };
}
