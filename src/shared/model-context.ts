/**
 * 上下文长度的「纯逻辑」部分：从接口返回的模型列表 / models.dev 数据集里挑出上下文字段。
 *
 * 这个文件刻意不 import 任何东西（更不 import chrome 包装），
 * 这样 node 测试脚本可以直接 import 它跑断言。
 */

/** 上下文字段的候选名（按优先级排列，大小写不敏感） */
export const CONTEXT_FIELD_CANDIDATES = [
  'context_length',
  'context_window',
  'context_size',
  'max_context_len',
  'max_context_length',
  'max_input_tokens',
  'max_sequence_length',
  'max_model_len',
  'n_ctx',
] as const;

/** 对象判定：数组不是「键值对象」，外面来的 JSON 先过这一关 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 数组判定：外面来的 JSON 只有先确认是数组才好逐条看 */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

/** 去掉厂商前缀：deepseek/deepseek-chat → deepseek-chat */
export function stripVendorPrefix(model: string): string {
  const value = (model ?? '').trim();
  const slash = value.indexOf('/');
  return slash >= 0 ? value.slice(slash + 1) : value;
}

const norm = (value: string): string => value.trim().toLowerCase();

/** 只认正数：0 / 负数 / NaN / 非数字都不算窗口大小 */
function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** 条目里的 id（模型名） */
function idOf(entry: unknown): string | null {
  const record = asRecord(entry);
  const id = record?.id;
  return typeof id === 'string' && id.trim() ? id : null;
}

/**
 * 在条目里找上下文字段：候选名按优先级来，每个候选先看顶层再看一层嵌套
 * （比如 { limits: { context_length: 128000 } }）。多个候选都命中时取优先级最高的那个。
 */
export function pickContextField(entry: unknown): number | null {
  const record = asRecord(entry);
  if (!record) return null;
  for (const candidate of CONTEXT_FIELD_CANDIDATES) {
    for (const [key, value] of Object.entries(record)) {
      if (norm(key) !== candidate) continue;
      const n = toPositiveNumber(value);
      if (n !== null) return n;
    }
    for (const nested of Object.values(record)) {
      const inner = asRecord(nested);
      if (!inner) continue;
      for (const [key, value] of Object.entries(inner)) {
        if (norm(key) !== candidate) continue;
        const n = toPositiveNumber(value);
        if (n !== null) return n;
      }
    }
  }
  return null;
}

/**
 * 从模型列表里挑出「当前模型」那一条，再取它的上下文字段。
 *
 * 匹配顺序：
 * 1. id 精确相等；
 * 2. 去掉厂商前缀后再比一次（deepseek/deepseek-chat ↔ deepseek-chat，两个方向都试）；
 * 3. id 包含当前模型名的条目——只有唯一命中时才敢用。
 */
export function extractContextWindowFromModels(payload: unknown, model: string): number | null {
  const entries = asArray(payload) ?? asArray(asRecord(payload)?.data);
  if (!entries || entries.length === 0) return null;

  const target = (model ?? '').trim();
  if (!target) return null;
  const stripped = stripVendorPrefix(target);

  const exact = entries.find((entry) => idOf(entry) === target);
  if (exact) return pickContextField(exact);

  const loose = entries.find((entry) => {
    const id = idOf(entry);
    if (!id) return false;
    return (
      id === stripped ||
      norm(id) === norm(target) ||
      norm(id) === norm(stripped) ||
      norm(stripVendorPrefix(id)) === norm(target)
    );
  });
  if (loose) return pickContextField(loose);

  const contains = entries.filter((entry) => {
    const id = idOf(entry);
    if (!id) return false;
    const low = norm(id);
    if (low.includes(norm(target))) return true;
    return stripped !== target && low.includes(norm(stripped));
  });
  if (contains.length === 1) return pickContextField(contains[0]);

  return null;
}

/**
 * 从 models.dev 的数据集里取上下文档位。
 *
 * 数据集形如 { "anthropic/claude-3-5-sonnet": { limit: { context: 200000, output: 8192 } } }。
 * 匹配顺序：键精确相等 → 键的末段等于模型名 → 包含关系且唯一命中。
 */
export function extractContextWindowFromModelsDev(dataset: unknown, model: string): number | null {
  const record = asRecord(dataset);
  if (!record) return null;
  const target = (model ?? '').trim();
  if (!target) return null;
  const stripped = stripVendorPrefix(target);
  const keys = Object.keys(record);

  let key = keys.find((k) => k === target);
  if (!key) key = keys.find((k) => k === stripped);
  if (!key) {
    key = keys.find((k) => {
      const seg = k.slice(k.lastIndexOf('/') + 1);
      return seg === target || seg === stripped || norm(seg) === norm(stripped);
    });
  }
  if (!key) {
    const hits = keys.filter((k) => {
      const low = norm(k);
      const seg = norm(k.slice(k.lastIndexOf('/') + 1));
      if (low.includes(norm(target))) return true;
      return stripped !== target && seg.includes(norm(stripped));
    });
    if (hits.length !== 1) return null;
    key = hits[0];
  }

  const entry = asRecord(record[key]);
  if (!entry) return null;
  const limit = asRecord(entry.limit);
  const fromLimit = limit ? toPositiveNumber(limit.context) : null;
  return fromLimit ?? pickContextField(entry);
}
