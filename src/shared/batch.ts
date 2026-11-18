/**
 * 赶题模式（/fuck）的进度快照。
 *
 * background 负责记（batch-progress.ts），面板负责画（BatchPanel.tsx），
 * 两边只靠这一个结构交换数据：谁都不用知道对方的内部实现。
 */

/** 一道题在赶题进度里的状态 */
export type BatchProblemStatus = 'current' | 'accepted' | 'failed' | 'pending';

export interface BatchProblemItem {
  /** 题目 ID：同一道题重复读只算一条 */
  key: string;
  title: string;
  /** 题型编号（PTA 的 type/1、type/7…），拿不到就空串 */
  type: string;
  /** 题目地址：面板靠它把用户带回那道题；拿不到就空串 */
  url: string;
  /** 判题结论：AC / WA / CE…；空串表示还没拿到结论 */
  verdict: string;
  status: BatchProblemStatus;
}

export interface BatchSnapshot {
  /** 这一轮是不是赶题模式 */
  active: boolean;
  /** 已经动过的题数 */
  attempted: number;
  /** 过了几题 */
  accepted: number;
  /** 没过的题数 */
  failed: number;
  /** 动了但还没拿到结论的题数 */
  unknown: number;
  /** 整份题单里还剩几题（next_problem 报来的；题单还没开始读时是 null） */
  remaining: number | null;
  /** 整份题单一共几题（next_problem 报来的） */
  total: number | null;
  /** 现在正在做哪道题 */
  current: { title: string; type: string } | null;
  /** 本轮做过的题（按第一次出现的顺序） */
  problems: BatchProblemItem[];
  /** 这一轮跑了多少分钟 */
  elapsedMinutes: number;
  /** 这一轮是不是已经结束（做完题单 / 用户按了停止） */
  finished: boolean;
  /** 怎么结束的：'done' 题单走完或 agent 自己收尾；'stopped' 用户按了停止；null 还在跑 */
  stopReason: 'done' | 'stopped' | null;
  /** 快照生成时间 */
  updatedAt: number;
}

/** 空快照：还没进过赶题模式时给面板用 */
export function emptyBatchSnapshot(): BatchSnapshot {
  return {
    active: false,
    attempted: 0,
    accepted: 0,
    failed: 0,
    unknown: 0,
    remaining: null,
    total: null,
    current: null,
    problems: [],
    elapsedMinutes: 0,
    finished: false,
    stopReason: null,
    updatedAt: 0,
  };
}

/**
 * 拼出「重做这几道没过的题」的那条指令。
 *
 * 只带标题不够：agent 得知道跳到哪儿去，所以每道题都把地址带上。
 * 这条指令会作为用户消息发出去，后台认出是 /fuck，于是这一轮不问、不解释、直接做。
 */
export function buildRedoCommand(problems: BatchProblemItem[]): string {
  const targets = problems.filter((problem) => problem.url);
  if (targets.length === 0) return '';
  const lines = targets.map((problem, index) => {
    const verdict = problem.verdict ? `（${problem.verdict}）` : '';
    return `${index + 1}. ${problem.title}${verdict}\n   地址：${problem.url}`;
  });
  return ['/fuck 重做这几道没过的题（每道题后面是它的地址）：', ...lines].join('\n');
}

/**
 * 从「重做这几道题」的消息里把题目地址抠出来。
 *
 * 抠出来有什么用：这一轮是用户点名重做的，next_problem 不能用
 * （它会跳到题目列表里的下一道题，直接跳出用户点名的那几道），
 * 所以后台要知道自己被点名了哪几道。
 *
 * 认的是 buildRedoCommand 写出来的那个格式（`地址：https://…`）；
 * 半角冒号也认一份，免得用户自己手打的时候对不上。
 */
export function parseRedoTargets(text: string): string[] {
  const matches = String(text ?? '').matchAll(/地址[：:]\s*(\S+)/g);
  return [...matches].map((match) => match[1]).filter(Boolean);
}
