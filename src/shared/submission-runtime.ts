// 提交记录里「运行时间」的解析：纯逻辑，Node 能直接单测。
//
// 实测 PTA 的提交记录是标准 table，表头是英文的：
//   Submit At | Status | Score | Problem | Compiler | Memory Usage | Time Usage | Submitter | Detail
// 时间列形如「2 ms」「0.012 s」。内存列是「564 KB」——绝不能被当成时间。
//
// 这里只做「这段文本是什么时长」这一件事；找 DOM、画图在 content/submission-chart.ts。

/** 一整行文本里的运行时间：中文「运行时间 12 ms」、英文「Run Time 0.012 s」都认 */
export const RUNTIME_LABEL_PATTERN =
  /(?:运行时间|运行用时|耗时|run\s*time|runtime)\s*[：:]?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?/i;

/**
 * 单元格里那种裸时长：「2 ms」「0.012 s」「7 毫秒」。
 * 结尾不能用 \b：中文单位不算 \w，`7 毫秒` 在字符串末尾就匹配不上了。
 */
export const RUNTIME_CELL_PATTERN = /(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)(?![A-Za-z])/i;

/** 表头哪一列是运行时间 */
export const TIME_HEADER_PATTERN = /time\s*usage|^time$|运行时间|运行用时|耗时/i;

/** 把「数值 + 单位」换成毫秒；没有单位按毫秒算 */
export function runtimeToMilliseconds(value: number, unit: string | undefined): number {
  const lower = (unit ?? '').toLowerCase();
  if (lower === 's' || lower === '秒') return value * 1000;
  return value;
}

/** 表头是不是运行时间那一列 */
export function isTimeUsageHeader(text: string): boolean {
  return TIME_HEADER_PATTERN.test((text ?? '').trim());
}

/**
 * 一个单元格里的时长换算成毫秒：`2 ms` → 2、`0.012 s` → 12、`564 KB` → null。
 * 认不出单位就返回 null（内存那一列不能被当成时间）。
 */
export function parseRuntimeCell(text: string): number | null {
  const match = RUNTIME_CELL_PATTERN.exec((text ?? '').trim());
  if (!match) return null;
  const ms = runtimeToMilliseconds(Number(match[1]), match[2]);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms);
}

/** 一整行文本里的时长（没有独立时间列时用） */
export function parseRuntimeText(text: string): number | null {
  const match = RUNTIME_LABEL_PATTERN.exec(text ?? '');
  if (!match) return null;
  const ms = runtimeToMilliseconds(Number(match[1]), match[2]);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms);
}
