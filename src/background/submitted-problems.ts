/**
 * 这一页里插件提交过的题（题目 ID）。
 *
 * 为什么需要自己记一份：
 * PTA 的考试页是单页应用，提交之后**侧栏不会重渲染**——
 * 「已答 / 总数」一直停在旧数，网格里的 `PROBLEM_ACCEPTED` 标记也还是旧的。
 * 于是页面脚本看到的是「这些题都还没做」：
 *   · next_problem 会把刚做完的题再挑一遍（转一圈又回到老题上）；
 *   · 总览卡的「还剩 N 题」一直等于题单总数。
 *
 * 插件自己知道提交过哪些题，把这份名单喂给页面脚本，
 * 脚本就知道该跳过哪些题、还剩几题。
 *
 * 整页重新加载时清掉：重载之后侧栏的计数会刷新、页面的标记也就准了，
 * 两边再一起算就重复了（提交过的题会被数两遍）。
 * 单页应用内部的跳转不会重新加载页面，所以名单能一直留着。
 */

/** 按标签页记：同一道题在不同标签页里各算各的 */
const submitted = new Map<number, Set<string>>();

function setFor(tabId: number): Set<string> {
  let set = submitted.get(tabId);
  if (!set) {
    set = new Set<string>();
    submitted.set(tabId, set);
  }
  return set;
}

/** 记下「这道题提交过了」 */
export function markSubmitted(tabId: number, problemId: string): void {
  const id = String(problemId ?? '').trim();
  if (!id) return;
  setFor(tabId).add(id);
}

/** 这一页里插件提交过的题（给页面脚本用） */
export function submittedProblems(tabId: number): string[] {
  return [...(submitted.get(tabId) ?? [])];
}

/** 整页重新加载后清掉：页面的标记这时已经刷新了 */
export function clearSubmitted(tabId: number): void {
  submitted.delete(tabId);
}

/** 标签页关掉后清掉，别一直占着内存 */
export function forgetSubmitted(tabId: number): void {
  submitted.delete(tabId);
}
