// 运行时间折线图：画在**判题结果弹窗**里，不是题目列表上。
//
// 为什么不扫列表：列表里混着所有题目的提交，按顺序连成折线毫无意义
// （A 题 2ms、B 题 300ms 交替，看起来像抖动）。真正有用的是「这道题我自己最近几次
// 提交的耗时」，所以数据按题目地址存，弹窗一开就把历史画出来。
//
// 数据来源只有一处：判题结果弹窗里的 Time Usage（形如 `12 / 400 ms`，
// 前面是本次耗时、后面是限制）。读不到就静默不画，不抛错、不影响别的功能。

import { ext } from '../shared/browser';

const STORAGE_KEY = 'pta-assistant-submission-runtimes';
/** 每个题目地址最多留多少条历史 */
const KEEP_PER_URL = 50;
const CHART_ID = 'pta-assistant-runtime-chart';
const FONT = 'font:11px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';

/** 一次提交的记录：时间戳用来去重和排序，ms 是这次跑了多久 */
interface RuntimePoint {
  at: string;
  ms: number;
}

/** 判题结果弹窗里读出来的东西 */
interface ResultDialog {
  dialog: HTMLElement;
  /** 挂图表的位置（统计格子下面） */
  anchor: HTMLElement;
  ms: number;
  /** 提交时间（弹窗里那行 Submit At），没有就用空串 */
  at: string;
}

/**
 * 找一个「像判题结果弹窗」的元素。
 *
 * 认法：里面有 `Time Usage` 字样，并且能读到一个 `X / Y ms` 或 `X ms`。
 * 从最小的节点往上找，找到第一个同时满足的父容器。
 */
function findResultDialog(): ResultDialog | null {
  const all = document.querySelectorAll<HTMLElement>('div, section, article, table, tr, td');
  for (let index = 0; index < all.length; index += 1) {
    const node = all[index];
    if (node.closest('#pta-assistant-host')) continue;
    const text = node.textContent ?? '';
    if (text.length > 4000) continue;
    if (!/Time Usage|运行时间/.test(text)) continue;
    const ms = readRuntimeMs(text);
    if (ms === null) continue;
    // 弹窗根：往上找带 modal 类名的容器，找不到就用当前节点
    let dialog: HTMLElement = node;
    let cursor: HTMLElement | null = node;
    for (let depth = 0; cursor && depth < 8; depth += 1) {
      if (/pc-modal|modal|dialog/i.test(String(cursor.className || ''))) { dialog = cursor; break; }
      cursor = cursor.parentElement;
    }
    return { dialog: dialog, anchor: node, ms: ms, at: readSubmitAt(text) };
  }
  return null;
}

/** `12 / 400 ms` → 12；`0.012 s` → 12；认不出返回 null */
function readRuntimeMs(text: string): number | null {
  const slash = /(\d+(?:\.\d+)?)\s*\/\s*\d+(?:\.\d+)?\s*(ms|毫秒|s|秒)\b/i.exec(text);
  if (slash) {
    const value = Number(slash[1]);
    const unit = slash[2].toLowerCase();
    const ms = unit === 's' || unit === '秒' ? value * 1000 : value;
    return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
  }
  const plain = /(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)\b/i.exec(text);
  if (!plain) return null;
  const value = Number(plain[1]);
  const unit = plain[2].toLowerCase();
  const ms = unit === 's' || unit === '秒' ? value * 1000 : value;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

/** 弹窗里的提交时间，用来给同一次提交去重 */
function readSubmitAt(text: string): string {
  const match = /\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}(?::\d{2})?/.exec(text);
  return match ? match[0] : '';
}

/** 读缓存：这道题之前几次的耗时 */
async function readHistory(url: string): Promise<RuntimePoint[]> {
  try {
    const stored = await ext.storage.local.get(STORAGE_KEY);
    const map = stored[STORAGE_KEY];
    if (!map || typeof map !== 'object') return [];
    const list = (map as Record<string, unknown>)[url];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is RuntimePoint =>
        !!item && typeof item === 'object'
        && typeof (item as RuntimePoint).ms === 'number'
        && Number.isFinite((item as RuntimePoint).ms),
    );
  } catch {
    return [];
  }
}

/** 把这一次也记进去（同一个提交时间不重复记） */
async function remember(url: string, point: RuntimePoint): Promise<RuntimePoint[]> {
  const history = await readHistory(url);
  const key = point.at || String(point.ms);
  const existed = history.some((item) => (item.at || String(item.ms)) === key);
  const next = existed ? history : [...history, point].slice(-KEEP_PER_URL);
  try {
    const stored = await ext.storage.local.get(STORAGE_KEY);
    const map = stored[STORAGE_KEY];
    const all: Record<string, RuntimePoint[]> = map && typeof map === 'object' ? { ...(map as Record<string, RuntimePoint[]>) } : {};
    all[url] = next;
    await ext.storage.local.set({ [STORAGE_KEY]: all });
  } catch {
    /* 存不进去不影响这一次的显示 */
  }
  return next;
}

/** 画一张内联 SVG 折线图（不画背景，颜色跟着主题走） */
function buildChart(values: number[]): SVGSVGElement {
  const width = 320;
  const height = 72;
  const padTop = 10;
  const padBottom = 12;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);
  const plotWidth = width - 8;
  const plotHeight = height - padTop - padBottom;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `这道题最近 ${values.length} 次提交的运行时间（毫秒）`);
  svg.style.display = 'block';

  const axis = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  axis.setAttribute('x1', '4');
  axis.setAttribute('x2', String(width - 4));
  axis.setAttribute('y1', String(height - padBottom));
  axis.setAttribute('y2', String(height - padBottom));
  axis.setAttribute('stroke', 'var(--border, #cfd6e6)');
  axis.setAttribute('stroke-width', '1');
  svg.appendChild(axis);

  const points = values
    .map((value, index) => {
      const x = 4 + (values.length === 1 ? plotWidth / 2 : (index / (values.length - 1)) * plotWidth);
      const y = padTop + plotHeight - ((value - min) / span) * plotHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(line);

  // 每次提交一个小点：只有一两次时也能看出位置
  for (const pair of points.split(' ')) {
    const [cx, cy] = pair.split(',');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', cy);
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', 'currentColor');
    svg.appendChild(dot);
  }

  return svg;
}

/**
 * 把图插进弹窗。
 *
 * 闪烁的来源是「每次都把 SVG 重画一遍」：DOM 被换掉的那一帧图就空了。
 * 所以：盒子留着不动，只有数据真的变了才重画；位置变了才搬。
 */
function renderChart(host: HTMLElement, anchor: HTMLElement, values: number[], current: number): void {
  const signature = values.join(',') + '|' + current;
  const existing = document.getElementById(CHART_ID);
  if (existing && existing.getAttribute('data-sig') === signature) {
    // 数据没变：什么都不做（连位置都不动）
    if (existing.isConnected) return;
  }
  const box = existing ?? document.createElement('div');
  box.id = CHART_ID;
  box.setAttribute('data-sig', signature);
  box.textContent = '';
  box.style.cssText = [
    'margin:10px 0',
    'padding:6px 8px',
    'border:1px solid var(--border, #cfd6e6)',
    'border-radius:6px',
    'color:var(--fg, #1f2430)',
    FONT,
  ].join(';');

  const title = document.createElement('div');
  const max = Math.max(...values);
  const min = Math.min(...values);
  title.textContent = values.length > 1
    ? `运行时间（ms）：这次 ${current}，最近 ${values.length} 次里最快 ${min}、最慢 ${max}`
    : `运行时间（ms）：这次 ${current}（再交一次就能看到趋势）`;
  title.style.cssText = 'margin-bottom:4px;opacity:.75;';
  box.appendChild(title);
  box.appendChild(buildChart(values));

  const parent = anchor.parentElement ?? host;
  if (box.parentElement !== parent) parent.insertBefore(box, anchor.nextSibling);
}

/**
 * 起停入口。
 *
 * PTA 是单页应用：判题结果弹窗是点提交之后才渲染的，所以盯着 DOM，
 * 弹窗出现（并且能读到 Time Usage）就画一次。
 */
export function startSubmissionChart(): void {
  if (!/(^|\.)pintia\.cn$/.test(location.hostname)) return;

  let timer = 0;
  let lastKey = '';

  const run = async () => {
    const found = findResultDialog();
    if (!found) {
      // 弹窗可能只是内容重绘（那一瞬间读不到 Time Usage），别急着把图删了——
      // 删了再画就是闪烁。只有确认弹窗真的没了才撤。
      const box = document.getElementById(CHART_ID);
      if (box && !document.querySelector('.pc-modal')) {
        box.remove();
        lastKey = '';
      }
      return;
    }
    const key = `${location.href}|${found.at}|${found.ms}`;
    if (key === lastKey) return;
    lastKey = key;
    const history = await remember(location.href, { at: found.at, ms: found.ms });
    const values = history.map((item) => item.ms);
    renderChart(found.dialog, found.anchor, values, found.ms);
  };

  if (typeof MutationObserver !== 'function') return;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      void run();
    }, 400);
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* 观察不了就算了：至少点开弹窗那一次会画 */
  }
}
