/**
 * 跳转到别的地址之前的安全判定。
 *
 * 插件里有两处会跳页面：面板总览卡里的「跳到那道题」，以及给模型用的 open_problem 工具。
 * 两者都是拿着一个地址去改标签页的当前页——地址一旦被伪造（比如模型自己编一个），
 * 用户眼前的页面就被换掉了。所以判定放在 shared 里，脱离浏览器单测。
 */

/** 只放行 http(s)：javascript: / data: 这类地址一律不跳 */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 取地址里的源（scheme://host:port），取不到就空串 */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * 能不能跳到这个地址。
 *
 * 规则只有一条：必须是 http(s)，而且跟当前页面同源。
 * 同源这条是关键——PTA 的考试页、题目页都在同一个站里，
 * 而模型编出来的外站地址（钓鱼页、广告页）一律不跳。
 */
export function canNavigateTo(target: string, currentPageUrl: string): boolean {
  const url = String(target || '').trim();
  if (!url || !isHttpUrl(url)) return false;
  const from = originOf(String(currentPageUrl || ''));
  const to = originOf(url);
  if (!from || !to) return false;
  return from === to;
}
