// 专注题目模式：把 PTA 页面上的无关面板收起来，只留题面（题目面板）。
//
// 做法：先找到题面在哪一列，然后
//   · 作答区（编辑器那一列）收起来；
//   · 从分栏区往上，每一层不在题面这条路上的兄弟都收起来
//     （顶部标题栏、左侧图标栏、题目列表侧栏、「查看上次提交」浮条等）；
//   · 题面那一列留在一屏宽的中间，行宽收到读着舒服的长度。
//
// 收起用「加属性 + 一张样式表」：页面自己的样式一点没动，
// 关掉时把属性摘掉、样式表删掉就行，页面不用重绘。

/** 样式表挂在页面上（不是 shadow root）：它要管的是页面自己的元素 */
const STYLE_ID = 'pta-assistant-focus-style';
/** 被收起来的元素 */
const HIDE_ATTR = 'data-pta-focus-hidden';
/** 题面那一列 */
const COLUMN_ATTR = 'data-pta-focus-column';
/** 题面与作答区之间的分栏区 */
const SPLIT_ATTR = 'data-pta-focus-split';

/** 页面自己那些「看不见但存在」的元素别动：图标雪碧图、脚本、样式表 */
const SKIP_TAGS: Record<string, true> = {
  SCRIPT: true,
  STYLE: true,
  LINK: true,
  META: true,
  NOSCRIPT: true,
  TEMPLATE: true,
  SVG: true,
};

const STYLE_TEXT = `
[${HIDE_ATTR}] { display: none !important; }
/* 分栏区：右边给插件自己的悬浮窗让出位置 */
[${SPLIT_ATTR}] { padding-right: var(--pta-focus-right, 0px) !important; }
/* 题面那一列：撑到舒服的行宽，在剩下的空间里居中 */
[${COLUMN_ATTR}] {
  width: auto !important;
  flex: 0 1 820px !important;
  max-width: 820px !important;
  margin-left: auto !important;
  margin-right: auto !important;
}
`;

/** 题面里的分节小标题（中英文两套页面都有） */
const STATEMENT_MARKERS = [
  '题目描述', '题目背景', '题目要求', '问题描述',
  '输入格式', '输出格式', '样例输入', '样例输出', '输入样例', '输出样例',
  'Problem Description', 'Input Format', 'Output Format', 'Sample Input', 'Sample Output',
];

let observer: MutationObserver | null = null;
let ticker: number | undefined;

/** 专注题目模式：页面只留题面 */
export function applyFocusMode(): void {
  ensureStyle();
  hideChrome();
  watchChanges();
  // 悬浮窗能被拖着走，它占着的地方要随时让出来
  if (ticker === undefined) {
    ticker = window.setInterval(updateReservedSpace, 500);
  }
}

/** 退出专注题目模式：把页面恢复原样 */
export function clearFocusMode(): void {
  observer?.disconnect();
  observer = null;
  if (ticker !== undefined) {
    window.clearInterval(ticker);
    ticker = undefined;
  }
  for (const node of Array.from(document.querySelectorAll(`[${HIDE_ATTR}], [${COLUMN_ATTR}], [${SPLIT_ATTR}]`))) {
    node.removeAttribute(HIDE_ATTR);
    node.removeAttribute(COLUMN_ATTR);
    node.removeAttribute(SPLIT_ATTR);
  }
  document.documentElement.style.removeProperty('--pta-focus-right');
  document.getElementById(STYLE_ID)?.remove();
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.documentElement.appendChild(style);
}

/**
 * 页面是前端路由（换题不刷新），元素会被重新渲染掉，
 * 所以盯着 DOM 变化，变了就把「要收起来的」重新算一遍。
 */
function watchChanges(): void {
  if (observer) return;
  let timer: number | undefined;
  observer = new MutationObserver(() => {
    if (timer !== undefined) window.clearTimeout(timer);
    // 页面改动很密，攒一会儿再算，别一改就重算一遍
    timer = window.setTimeout(() => hideChrome(), 120);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/** 重新算一遍要收起来的元素，并打上标记 */
function hideChrome(): void {
  const appRoot = document.getElementById('exam-app') ?? document.body;

  // 页面外壳（顶部标题栏、左侧图标栏、题目列表侧栏）：跟有没有题面无关，先收掉
  hidePageShell(appRoot);

  const statement = findStatement();
  if (!statement) return;

  const editor = findAnswerEditor();
  // 作答区在的时候，题面与编辑器共同的上层就是分栏区
  const splitArea = editor ? commonAncestor(statement, editor) : appRoot;

  // 题面这条路上的元素要留着
  const keep = new Set<Element>();
  for (let node: Element | null = statement; node; node = node.parentElement) {
    keep.add(node);
    if (node === splitArea) break;
  }

  // 分栏区里：题面这一列留着，编辑器那一列（和中间的分隔条）收起来
  if (splitArea !== appRoot) {
    for (const child of Array.from(splitArea.children)) {
      if (!keep.has(child)) hide(child);
    }
  }

  // 往上每一层：不在题面路上的兄弟都收起来（顶部标题栏、侧栏、图标栏、浮条…）
  let ancestor: Element | null = splitArea;
  while (ancestor && ancestor !== appRoot) {
    const parent: Element | null = ancestor.parentElement;
    if (!parent) break;
    for (const child of Array.from(parent.children)) {
      if (child !== ancestor && !keep.has(child)) hide(child);
    }
    ancestor = parent;
  }

  // 题面那一列：撑开 + 居中
  const column = splitArea === appRoot ? null : childContaining(splitArea, statement);
  if (column) column.setAttribute(COLUMN_ATTR, '');
  if (splitArea !== appRoot) splitArea.setAttribute(SPLIT_ATTR, '');
  updateReservedSpace();
}

/** 收起来一个元素：打个标记，样式表负责让它别显示 */
function hide(node: Element): void {
  if (SKIP_TAGS[node.tagName]) return;
  if (node.getAttribute('aria-hidden') === 'true') return;
  (node as HTMLElement).setAttribute(HIDE_ATTR, '');
}

/**
 * 页面外壳：顶部标题栏、左侧图标栏、题目列表侧栏。
 *
 * 这几块跟有没有题面没关系（选择题、判断题那种页面没有题面容器），
 * 所以单独收：主内容区在 `main` 里，主网格里跟它同一层的其它格子、
 * 以及 `main` 旁边的题目列表侧栏，都是与题目无关的外壳。
 */
function hidePageShell(appRoot: Element): void {
  const main = appRoot.querySelector('main');
  if (!main) return;
  // 主网格：跟主内容区同一层的其它格子（顶部标题栏、左侧图标栏）
  const grid = Array.from(appRoot.children).find((child) => child.contains(main));
  if (grid) {
    for (const child of Array.from(grid.children)) {
      if (!child.contains(main)) hide(child);
    }
  }
  // 主内容区旁边那一块：题目列表侧栏
  const parent = main.parentElement;
  if (parent) {
    for (const child of Array.from(parent.children)) {
      if (child !== main) hide(child);
    }
  }
}

/**
 * 插件自己的悬浮窗停在右上角时，右边给它让出来，题面在剩下的空间里居中。
 *
 * 只看悬浮窗自己在哪儿（不看题面现在在哪）——两边互相影响会来回抖。
 */
function updateReservedSpace(): void {
  if (!document.querySelector(`[${COLUMN_ATTR}]`)) return;
  const panel = document
    .getElementById('pta-assistant-host')
    ?.shadowRoot?.querySelector('.panel');
  const rect = panel?.getBoundingClientRect();
  let reserved = 0;
  if (rect && rect.width > 0 && rect.right >= window.innerWidth - 40 && rect.top < window.innerHeight / 2) {
    reserved = Math.max(0, window.innerWidth - rect.left) + 16;
  }
  document.documentElement.style.setProperty('--pta-focus-right', `${reserved}px`);
}

/** 题面：先按类名找，找不到再按小标题找（跟 read_problem 同一套思路） */
function findStatement(): HTMLElement | null {
  const specific = [
    '.rendered-markdown',
    '.problem-content', '.problem-statement', '.pt12-problem-content', '.problem-description',
  ];
  for (const selector of specific) {
    let best: HTMLElement | null = null;
    for (const node of Array.from(document.querySelectorAll(selector))) {
      const length = (node.textContent || '').trim().length;
      if (length > 40 && (!best || length > (best.textContent || '').length)) best = node as HTMLElement;
    }
    if (best) return best;
  }
  // 按小标题定位：同时出现两个以上小标题的最小容器。
  // 先看整页有没有小标题——没有就别扫全页的 div 了（页面改动频繁时这一步很贵）
  const bodyText = document.body?.textContent ?? '';
  if (!STATEMENT_MARKERS.some((marker) => bodyText.includes(marker))) return null;
  let best: { node: HTMLElement; hits: number; length: number } | null = null;
  for (const node of Array.from(document.querySelectorAll('div, section, article, main, form'))) {
    const text = node.textContent || '';
    if (text.length < 80 || text.length > 30000) continue;
    const hits = STATEMENT_MARKERS.filter((marker) => text.includes(marker)).length;
    if (hits < 2) continue;
    if (!best || hits > best.hits || (hits === best.hits && text.length < best.length)) {
      best = { node: node as HTMLElement, hits, length: text.length };
    }
  }
  return best ? best.node : null;
}

/** 作答区：可写的 CodeMirror（题面里的样例框是只读的，不算） */
function findAnswerEditor(): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLength = 0;
  for (const node of Array.from(document.querySelectorAll('.cm-content, [contenteditable="true"]'))) {
    if (!isEditableElement(node as HTMLElement)) continue;
    const length = (node.textContent || '').length;
    if (length > bestLength) {
      best = node as HTMLElement;
      bestLength = length;
    }
  }
  return best;
}

function isEditableElement(node: HTMLElement): boolean {
  if (node.getAttribute('aria-readonly') === 'true') return false;
  const attr = node.getAttribute('contenteditable');
  if (attr === 'false') return false;
  return node.isContentEditable || attr === '' || attr === 'true' || attr === 'plaintext-only';
}

/** 两个节点的共同祖先里最深的那个 */
function commonAncestor(a: Element, b: Element): Element {
  const ancestors = new Set<Element>();
  for (let node: Element | null = a; node; node = node.parentElement) ancestors.add(node);
  for (let node: Element | null = b; node; node = node.parentElement) {
    if (ancestors.has(node)) return node;
  }
  return document.body;
}

/** 父节点里装着目标的那一个 */
function childContaining(parent: Element, target: Element): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (child === target || child.contains(target)) return child as HTMLElement;
  }
  return null;
}
