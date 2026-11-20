// PTA 站点配色：**只把页面的强调色**换成用户选的色（面板配色在 App.tsx 里单独做）。
//
// 强调色 = PTA 自己拿来做链接/主按钮的那种蓝（rgb(28, 128, 242) 一族）。
// 正文、说明文字、限制表格这些「本来就是默认字色」的一个字都不动——
// 早先按「大部分文字都染」做过一版，用户明确说染得太多了。
//
// 只改字色、不改底色：早先按「谁是蓝色底就把它的底色换掉」做过一版，结果整页都是
// 一块块的色块（按钮、标签、导航全变绿底），用户明确否掉。
// 现在染的是「文字直接铺在页面底色上」的元素——导航、标签、标题、提示、正文里的普通文字都算；
// 题目描述（.rendered-markdown）与代码区（.cm-editor / pre / code）一律不碰，
// 有实底色的色块与白字（按钮、徽章）也不碰，免得变成看不见的字。
//
// 为什么直接给元素写 inline color，而不是生成 `.类名{color}` 的样式表：
//   1. PTA 的类名是打包哈希，但同时也用了大量 Tailwind 工具类（.flex / .pc-text …），
//      按类名写规则会波及一大片，连正文都被染色；
//   2. 更糟的是会自激：上一版按「当前字色是不是蓝」判断，把我们自己染成的绿色
//      当成「不是蓝色」→ 清空样式表 → 弹回蓝色 → 又变绿，屏幕上就是一直闪。
// 现在每次重算前先把自己写过的 color 摘掉，读到的永远是页面原本的颜色。

import { ext } from '../shared/browser';
import { PTA_THEMES, type PtaTheme, type SettingsView } from '../shared/settings';

/** 老版本留下的样式表 id：只用于清理 */
const LEGACY_STYLE_ID = 'pta-assistant-site-theme';
/** 扫多少个元素为止：整页几千个节点，扫太多会明显卡一下 */
const SCAN_LIMIT = 4000;
/** 题面与代码区：一个字符都不许改色 */
const PROTECTED_SELECTOR = '.rendered-markdown, .cm-editor, pre, code';
/**
 * 题面根节点。
 *
 * PTA 现版的题面**不在** `.rendered-markdown` 里（那个类名换版后就不用了），
 * 所以再按「同时出现两个小标题标记的最小容器」找一次——跟读题面用的是同一套思路。
 * 找到以后整个子树都不染色：用户明确要求题面文字不许改色。
 */
let statementRoots: Element[] = [];
let statementUrl = '';

function findStatementRoots(): Element[] {
  // 只缓存「找到了」的结果：页面刚加载时题面还没渲染，那时找不到不能写成缓存，
  // 否则这一页以后都按「没有题面」处理，题面文字会被染色
  if (statementRoots.length > 0 && statementUrl === location.href) return statementRoots;
  const markerCount = (text: string): number => {
    const markers = text.match(/题目描述|输入格式|输出格式|样例输入|样例输出|Problem Description|Input Format|Output Format|Sample Input|Sample Output/g);
    return markers ? markers.length : 0;
  };
  // 先找最小长度，再把「同样差不多短」的都算进去：
  // PTA 常常同时渲染一份正文和一份隐藏/全屏副本，只保护一个会漏掉另一个
  let minLength = Infinity;
  const candidates: { node: Element; length: number }[] = [];
  for (const node of document.querySelectorAll('div,section,article,main')) {
    if (node.closest('#pta-assistant-host')) continue;
    const text = (node.textContent ?? '').trim();
    if (text.length < 120 || text.length > 20000) continue;
    if (markerCount(text) < 2) continue;
    candidates.push({ node, length: text.length });
    if (text.length < minLength) minLength = text.length;
  }
  const limit = Math.min(minLength * 1.15, minLength + 120);
  statementRoots = candidates.filter((item) => item.length <= limit).map((item) => item.node);
  statementUrl = statementRoots.length > 0 ? location.href : '';
  return statementRoots;
}

/** 不参与染色的标签：里面没有可见文字，或者本来就是插件自己的浮层 */
const SKIP_TAGS: Record<string, true> = {
  SCRIPT: true, STYLE: true, LINK: true, META: true, HEAD: true, TITLE: true,
  NOSCRIPT: true, TEMPLATE: true, IFRAME: true,
};

/** 这个元素该不该被染色：插件自己的浮层、题面、代码一律跳过 */
function isEligible(node: Element): boolean {
  if (SKIP_TAGS[node.tagName]) return false;
  if (node.closest('#pta-assistant-host')) return false;
  // 编辑器浮层挂在 body 上，不在 host 里，单独挡一下
  if (node.closest('#pta-assist-editor-layer')) return false;
  if (node.closest(PROTECTED_SELECTOR)) return false;
  return true;
}

/** 解析 rgb()/rgba() 成三个通道 */
function rgbOf(color: string): [number, number, number] | null {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 这是不是 PTA 的强调色（品牌蓝）。
 *
 * 用色相 + 饱和度判断，而不是写死一个 rgb：PTA 的链接是 rgb(28,128,242)，
 * 也有 rgb(0,122,255) 这种变体，但都落在同一个蓝色区间。
 * 灰、黑、白、红绿黄（判定结果色）都不在这个区间里，不会被误染。
 */
function isAccentColor(color: string): boolean {
  const rgb = rgbOf(color);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return false;
  const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return hue >= 198 && hue <= 228 && sat >= 0.5 && light >= 0.28 && light <= 0.72;
}

/** 底色是不是不透明的（有实底色的元素字色通常是对比色，不能直接换） */
function hasOpaqueBackground(node: HTMLElement): boolean {
  const bg = getComputedStyle(node).backgroundColor;
  const alpha = /rgba?\([^)]*,\s*([\d.]+)\)$/.exec(bg);
  if (!alpha) return bg !== '' && bg !== 'transparent';
  return Number(alpha[1]) > 0.05;
}

/** 强调色底的按钮/链接：把底也换成主题色，字色保持原样 */
function recolorAccentBackground(node: HTMLElement, accent: string): boolean {
  if (!node.matches('button, a, [role="button"], [class*="button"]')) return false;
  if (!isAccentColor(getComputedStyle(node).backgroundColor)) return false;
  node.style.setProperty('background-color', accent, 'important');
  node.setAttribute(MARK, '');
  return true;
}

let currentTheme: PtaTheme = 'off';
/** 染色标记：重算时按这个属性把上一次写的颜色全摘掉（不依赖 JS 里的数组，节点被替换也不怕） */
const MARK = 'data-pta-theme-color';

/** 主题只给 PTA 自己的页面用：插件挂在所有站点上，别去改别人家页面的字色 */
function onPtaSite(): boolean {
  const host = location.hostname;
  return host === 'pintia.cn' || host.endsWith('.pintia.cn');
}

/** 把上一次染上的颜色全摘掉 */
function resetTouched(): void {
  document.querySelectorAll(`[${MARK}]`).forEach((element) => {
    (element as HTMLElement).style.removeProperty('color');
    element.removeAttribute(MARK);
  });
  // 题面原色的记录也一并清掉：下次重新记，别拿旧值写回去
  document.querySelectorAll('[data-pta-statement-color]').forEach((element) => {
    element.removeAttribute('data-pta-statement-color');
  });
}

/**
 * 按当前页面重新染一遍**文字**颜色。
 *
 * 顺序很重要：先摘掉上一次写的 inline color，再读计算样式，最后重新染色。
 * 全程同步完成，浏览器只在任务结束时绘制一次，所以不会看到闪。
 */
export function applySiteTheme(theme: PtaTheme): void {
  // 不是 pintia.cn 就不染：在别人家的页面上改字色是越界的
  if (!onPtaSite()) {
    clearSiteTheme();
    return;
  }
  currentTheme = theme;
  // 老版本的样式表可能还挂在页面上：清掉
  document.getElementById(LEGACY_STYLE_ID)?.remove();

  if (theme === 'off') {
    resetTouched();
    return;
  }

  const { accent } = PTA_THEMES[theme];
  if (!accent) return;

  const statementRoots = findStatementRoots();
  const inStatement = (node: Element): boolean => statementRoots.some((root) => root.contains(node));
  // 题面原来的字色先记下来：题面不许染，但它的字色可能被上游容器带着变，
  // 记下来就能原样写回去
  for (const root of statementRoots) {
    if (!(root instanceof HTMLElement)) continue;
    if (root.dataset.ptaStatementColor) continue;
    const original = getComputedStyle(root).color;
    if (original) root.dataset.ptaStatementColor = original;
  }
  const nodes = document.body ? document.body.querySelectorAll('*') : [];
  const limit = Math.min(nodes.length, SCAN_LIMIT);
  for (let index = 0; index < limit; index += 1) {
    const node = nodes[index];
    if (!(node instanceof HTMLElement)) continue;
    // 该不该染，先判；不该染但以前染过 → 把我们的颜色摘掉
    const eligible = isEligible(node)
      && !inStatement(node)
      && !node.querySelector(PROTECTED_SELECTOR);
    if (!eligible) {
      if (node.hasAttribute(MARK)) {
        node.style.removeProperty('color');
        node.removeAttribute(MARK);
      }
      continue;
    }
    const style = getComputedStyle(node);
    // 强调色底的按钮：换底色（字色通常是对比白，不换）
    if (recolorAccentBackground(node, accent)) continue;
    if (node.hasAttribute(MARK)) {
      // 已经是我们染过的：保证还是当前主题色。
      // 之前是「先全摘再全染」，中间那一帧页面是原色——那就是闪烁的来源。
      if (style.color !== accent) node.style.setProperty('color', accent, 'important');
      continue;
    }
    // 只染「本来就是强调色」的文字：正文、说明、限制表格这些默认字色一个都不碰
    if (!isAccentColor(style.color)) continue;
    // 有实底色的元素（色块上的白字）不换字色，否则会变成看不见的字
    if (hasOpaqueBackground(node)) continue;
    node.style.setProperty('color', accent, 'important');
    node.setAttribute(MARK, '');
  }

  // 题面：把原来的字色显式写回去，避免继承到上游容器被染上的主题色
  statementRoots.forEach((root) => {
    if (!(root instanceof HTMLElement) || root === document.body) return;
    const original = root.dataset.ptaStatementColor;
    if (!original) return;
    if (root.style.color !== original) root.style.setProperty('color', original, 'important');
  });
}

/** 关掉主题：把我们写过的颜色全摘掉 */
export function clearSiteTheme(): void {
  resetTouched();
  document.getElementById(LEGACY_STYLE_ID)?.remove();
  currentTheme = 'off';
}

/**
 * 起停：读一次设置就开始工作。
 *
 * PTA 是单页应用，换题不刷新页面，DOM 会整块重渲染（我们写的 inline color 跟着元素一起没了）。
 * 所以：地址变了就重染；DOM 变化后如果发现染过的元素已经掉出文档，也重染一次（防抖）。
 */
export function startSiteTheme(): void {
  let timer = 0;
  let lastUrl = location.href;

  const reload = async () => {
    if (!onPtaSite()) return;
    try {
      const view = (await ext.runtime.sendMessage({ type: 'settings/get' })) as SettingsView | undefined;
      applySiteTheme(view?.theme ?? 'off');
    } catch {
      /* 后台还没醒：等设置变化或下次地址变化再试 */
    }
  };

  void reload();

  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!('pta-assistant-settings' in changes)) return;
    void reload();
  });

  // 换题 / 切页：两秒看一次地址，代价可以忽略
  window.setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (currentTheme !== 'off') void reload();
  }, 2000);

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(() => {
    if (currentTheme === 'off' || timer) return;
    // 下一帧就重染：页面重绘后如果隔几百毫秒才补上颜色，中间那段就是肉眼可见的闪。
    // 我们只改 style/属性、不动结构，所以不会「自己叫醒自己」。
    timer = window.setTimeout(() => {
      timer = 0;
      if (currentTheme !== 'off') applySiteTheme(currentTheme);
    }, 60);
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* 观察不了就算了：地址变化那一路还在 */
  }
}
