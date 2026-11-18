/**
 * 赶题模式（/fuck）的本轮统计。
 *
 * 只活在 background 的内存里，按标签页隔离：不写 storage、刷新页面就重来。
 * 目的有两个——走到题单末尾时能说清「这轮做了几题、过了几题、哪几题没过」，
 * 而不是让模型凭对话记忆自己数；以及随时能给面板画一张进度总览卡。
 */

import type { BatchProblemItem, BatchSnapshot } from '../shared/batch.ts';
import { emptyBatchSnapshot } from '../shared/batch.ts';

export interface BatchProblemRecord {
  /** 题目 ID 或地址：同一道题重复读题/重复看判题只算一条 */
  key: string;
  title: string;
  type: string;
  /** 题目地址：面板的「重做没过的题」靠它把用户带回那道题 */
  url: string;
  verdict: string;
  updatedAt: number;
}

export interface BatchState {
  startedAt: number;
  currentKey: string;
  problems: Map<string, BatchProblemRecord>;
  /** 整份题单还剩几题：next_problem 报来的，题单还没开始读时是 null */
  remaining: number | null;
  /** 整份题单一共几题：next_problem 报来的 */
  total: number | null;
  /** 这一轮是不是已经收工（题单走完、用户按了停止、或出错中断） */
  finished: boolean;
  /** 怎么收的：'done' 题单走完或 agent 自己收尾；'stopped' 用户按了停止；'error' 这一轮出错了 */
  stopReason: 'done' | 'stopped' | 'error' | null;
}

const states = new Map<number, BatchState>();

function stateFor(tabId: number): BatchState {
  let state = states.get(tabId);
  if (!state) {
    state = {
      startedAt: Date.now(),
      currentKey: '',
      problems: new Map(),
      remaining: null,
      total: null,
      finished: false,
      stopReason: null,
    };
    states.set(tabId, state);
  }
  return state;
}

/** 新开一轮 /fuck 时清空上一轮的统计 */
export function resetBatch(tabId: number): void {
  states.set(tabId, {
    startedAt: Date.now(),
    currentKey: '',
    problems: new Map(),
    remaining: null,
    total: null,
    finished: false,
    stopReason: null,
  });
}

/** next_problem 报来「整份题单还剩几题」，面板的进度条要用 */
export function setRemaining(tabId: number, remaining: number | null): void {
  const state = stateFor(tabId);
  state.remaining = remaining === null || !Number.isFinite(remaining) ? null : Math.max(0, Math.trunc(remaining));
}

/** next_problem 报来「整份题单一共几题」 */
export function setTotal(tabId: number, total: number | null): void {
  const state = stateFor(tabId);
  state.total = total === null || !Number.isFinite(total) ? null : Math.max(0, Math.trunc(total));
}

/** 这一轮收工了（题单走完、用户按了停止、或者中途出错） */
export function finishBatch(tabId: number, reason: 'done' | 'stopped' | 'error' = 'done'): void {
  // 只标已有的那一轮：没开过赶题模式的标签页不该凭空多出一份统计
  const state = states.get(tabId);
  if (state) {
    state.finished = true;
    state.stopReason = reason;
  }
}

/** 这个标签页上有没有正在跑的赶题模式 */
export function batchActive(tabId: number): boolean {
  return states.has(tabId);
}

/** 记下「现在在做哪道题」；读题、换题、提交都会用到 */
export function setCurrentProblem(
  tabId: number,
  problem: { key: string; title?: string; type?: string; url?: string },
): void {
  const key = String(problem.key || '').trim();
  if (!key) return;
  const state = stateFor(tabId);
  state.currentKey = key;
  const existing = state.problems.get(key);
  if (existing) {
    if (problem.title) existing.title = problem.title;
    if (problem.type) existing.type = problem.type;
    if (problem.url) existing.url = problem.url;
    existing.updatedAt = Date.now();
    return;
  }
  state.problems.set(key, {
    key,
    title: String(problem.title || key),
    type: String(problem.type || ''),
    url: String(problem.url || ''),
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
    url: '',
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

/**
 * 给面板画进度总览卡用的快照。
 *
 * 没有这一轮的记录就返回空快照（active=false）：面板据此不画这张卡。
 * 结论优先于「当前题」——刚提交完的那道题已经拿到 AC，
 * 总览里要显示 AC 而不是「正在做」。
 */
export function batchSnapshot(tabId: number): BatchSnapshot {
  const state = states.get(tabId);
  if (!state) return emptyBatchSnapshot();
  const list = [...state.problems.values()];
  const accepted = list.filter((item) => item.verdict === 'AC').length;
  const failed = list.filter((item) => item.verdict !== '' && item.verdict !== 'AC').length;
  const unknown = list.filter((item) => item.verdict === '').length;
  const current = state.currentKey ? state.problems.get(state.currentKey) : undefined;

  const problems: BatchProblemItem[] = list.map((item) => ({
    key: item.key,
    title: item.title,
    type: item.type,
    url: item.url,
    verdict: item.verdict,
    status:
      item.verdict === 'AC'
        ? 'accepted'
        : item.verdict !== ''
          ? 'failed'
          : item.key === state.currentKey
            ? 'current'
            : 'pending',
  }));

  return {
    active: true,
    attempted: list.length,
    accepted,
    failed,
    unknown,
    remaining: state.remaining,
    total: state.total,
    current: current ? { title: current.title, type: current.type } : null,
    problems,
    elapsedMinutes: Math.max(0, Math.round((Date.now() - state.startedAt) / 60000)),
    finished: state.finished,
    stopReason: state.stopReason,
    updatedAt: Date.now(),
  };
}
