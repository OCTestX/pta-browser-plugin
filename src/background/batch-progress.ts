/**
 * 赶题模式（/fuck）的本轮统计。
 *
 * 只活在 background 的内存里，按标签页隔离：不写 storage、刷新页面就重来。
 * 目的只有一个——走到题单末尾时能说清「这轮做了几题、过了几题、哪几题没过」，
 * 而不是让模型凭对话记忆自己数。
 */

export interface BatchProblemRecord {
  /** 题目 ID 或地址：同一道题重复读题/重复看判题只算一条 */
  key: string;
  title: string;
  type: string;
  verdict: string;
  updatedAt: number;
}

export interface BatchState {
  startedAt: number;
  currentKey: string;
  problems: Map<string, BatchProblemRecord>;
}

const states = new Map<number, BatchState>();

function stateFor(tabId: number): BatchState {
  let state = states.get(tabId);
  if (!state) {
    state = { startedAt: Date.now(), currentKey: '', problems: new Map() };
    states.set(tabId, state);
  }
  return state;
}

/** 新开一轮 /fuck 时清空上一轮的统计 */
export function resetBatch(tabId: number): void {
  states.set(tabId, { startedAt: Date.now(), currentKey: '', problems: new Map() });
}

/** 记下「现在在做哪道题」；读题、换题、提交都会用到 */
export function setCurrentProblem(
  tabId: number,
  problem: { key: string; title?: string; type?: string },
): void {
  const key = String(problem.key || '').trim();
  if (!key) return;
  const state = stateFor(tabId);
  state.currentKey = key;
  const existing = state.problems.get(key);
  if (existing) {
    if (problem.title) existing.title = problem.title;
    if (problem.type) existing.type = problem.type;
    existing.updatedAt = Date.now();
    return;
  }
  state.problems.set(key, {
    key,
    title: String(problem.title || key),
    type: String(problem.type || ''),
    verdict: '',
    updatedAt: Date.now(),
  });
}

/** 记一次判题结论（AC / WA / CE …）；同一题重复读只更新结论，不重复计数 */
export function recordVerdict(tabId: number, verdict: string): void {
  const normalized = String(verdict || '').trim().toUpperCase();
  if (!normalized) return;
  const state = stateFor(tabId);
  const key = state.currentKey || '（当前题）';
  const existing = state.problems.get(key);
  if (existing) {
    existing.verdict = normalized;
    existing.updatedAt = Date.now();
    return;
  }
  state.problems.set(key, {
    key,
    title: key,
    type: '',
    verdict: normalized,
    updatedAt: Date.now(),
  });
}

/** 这一轮做了多少题、结果分布 */
export interface BatchStats {
  attempted: number;
  accepted: number;
  failed: number;
  unknown: number;
  elapsedMinutes: number;
  failedList: { title: string; verdict: string }[];
}

export function batchStats(tabId: number): BatchStats | null {
  const state = states.get(tabId);
  if (!state || state.problems.size === 0) return null;
  const list = [...state.problems.values()];
  const accepted = list.filter((item) => item.verdict === 'AC').length;
  const failed = list.filter((item) => item.verdict !== '' && item.verdict !== 'AC');
  return {
    attempted: list.length,
    accepted,
    failed: failed.length,
    unknown: list.filter((item) => item.verdict === '').length,
    elapsedMinutes: Math.max(0, Math.round((Date.now() - state.startedAt) / 60000)),
    failedList: failed.map((item) => ({ title: item.title, verdict: item.verdict })),
  };
}

/** 一段给模型和用户看的中文汇总；没有记录时返回空串 */
export function batchSummary(tabId: number): string {
  const stats = batchStats(tabId);
  if (!stats) return '';
  const parts = [
    `本轮统计：做过 ${stats.attempted} 题，AC ${stats.accepted} 题，未过 ${stats.failed} 题`,
  ];
  if (stats.unknown > 0) parts[0] += `，另有 ${stats.unknown} 题没拿到判题结论`;
  parts[0] += `，用时 ${stats.elapsedMinutes} 分钟。`;
  if (stats.failedList.length > 0) {
    const list = stats.failedList
      .slice(0, 12)
      .map((item) => `${item.title}（${item.verdict}）`)
      .join('、');
    parts.push(`未过的题：${list}${stats.failedList.length > 12 ? ' 等' : ''}`);
  }
  return parts.join('\n');
}
