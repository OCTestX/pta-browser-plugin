/**
 * PTA 的题型编号 → 中文名。
 *
 * 一份数据两处用：页面脚本（next_problem / list_problems 的返回里带题型名）
 * 与面板上的赶题总览卡（按题型分组显示）。
 * 放在 shared 里，页面脚本那边用 JSON.stringify 插值进脚本文本，
 * 免得两处各写一份、改一处忘另一处。
 */

export interface ProblemTypeInfo {
  /** 短名：面板上的小标签用 */
  name: string;
  /** 全名：给模型看的（带英文原名，省得它自己猜题型） */
  full: string;
}

export const PROBLEM_TYPES: Record<string, ProblemTypeInfo> = {
  '1': { name: '判断题', full: '判断题（True or False）' },
  '2': { name: '选择题', full: '选择题（Multiple Choice）' },
  '6': { name: '代码填空', full: '代码填空（Code Completion）' },
  '7': { name: '编程题', full: '编程题（Programming）' },
  '9': { name: '多文件题', full: '多文件（Multiple Files）' },
};

/** 题型编号（字符串或数字）→ 全名；认不出来就写「题型 12」这样，不编造 */
export function problemTypeName(type: string | number | undefined): string {
  const key = String(type ?? '').trim();
  if (!key) return '';
  return PROBLEM_TYPES[key]?.full ?? `题型 ${key}`;
}

/** 题型编号 → 短名；面板上的小标签用 */
export function problemTypeShortName(type: string | number | undefined): string {
  const key = String(type ?? '').trim();
  if (!key) return '';
  return PROBLEM_TYPES[key]?.name ?? `题型 ${key}`;
}
