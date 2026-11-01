// PTA 页面禁止粘贴（onpaste 是平台的反抄袭控制）。这里在页面自己的监听器之前
// 把 Ctrl+V / ⌘V 拦下来，读系统剪贴板，再走插件自己的写入链路塞进 CodeMirror——
// 效果上就是「PTA 允许粘贴了」，但落进去的是编辑器事务，不是平台要拦的 paste 事件。
//
// Ctrl+V 万一被页面用 capture + stopImmediatePropagation 抢在前头（收不到 paste 事件），
// 还有 Ctrl+M 这条备用快捷键（PTA 没有占用）。
import { ext } from '../shared/browser';
import type { ClipboardReadResponse, ToolRunResponse } from '../shared/messages';

const TOAST_HOST_ID = 'pta-assistant-toast';
const HOST_ID = 'pta-assistant-host';
const EDITOR_SELECTOR = '.cm-content, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

interface ClipboardText {
  ok: boolean;
  text: string;
  message?: string;
}

let installed = false;
let pasting = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** 事件是不是发生在插件的悬浮窗/提示条里（那里的粘贴照常走浏览器） */
function isInsidePlugin(path: EventTarget[]): boolean {
  return path.some((node) => node instanceof Element && (node.id === HOST_ID || node.id === TOAST_HOST_ID));
}

/**
 * 焦点在可写作答区里才接管粘贴。
 * 只认 CodeMirror（PTA 的作答区就是它）；contenteditable 只限 PTA 域名，
 * 否则会把别的网站（在线文档之类）的 Ctrl+V 也顶掉。
 */
function editableTarget(event: Event): Element | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (isInsidePlugin(path)) return null;

  const target = event.target instanceof Element ? event.target : null;
  if (!target) return null;
  const codeMirror = target.closest('.cm-content');
  const element = codeMirror ?? (location.hostname.endsWith('pintia.cn') ? target.closest(EDITOR_SELECTOR) : null);
  if (!element) return null;
  // 题面的样例框也是 .cm-content，但只读；只读就交给浏览器默认行为
  if (element.getAttribute('aria-readonly') === 'true') return null;
  if (element.getAttribute('contenteditable') === 'false') return null;
  return element;
}

function showToast(text: string, kind: 'info' | 'error' = 'info'): void {
  let host = document.getElementById(TOAST_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = TOAST_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .toast {
        position: fixed;
        left: 50%;
        bottom: 28px;
        transform: translateX(-50%);
        max-width: min(80vw, 560px);
        padding: 8px 14px;
        border-radius: 999px;
        background: #1f2430;
        color: #fff;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
        pointer-events: none;
        z-index: 2147483647;
      }
      .toast--error { background: #b3261e; }
    `;
    const bubble = document.createElement('div');
    bubble.className = 'toast';
    shadow.append(style, bubble);
    document.documentElement.appendChild(host);
  }
  const bubble = host.shadowRoot?.querySelector<HTMLElement>('.toast');
  if (!bubble) return;
  bubble.textContent = text;
  bubble.className = kind === 'error' ? 'toast toast--error' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host?.remove(), 2600);
}

/** 先自己读；页面不让读（没给用户手势/焦点被抢）时让后台用 offscreen 兜底 */
async function readClipboard(): Promise<ClipboardText> {
  let lastError = '';
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      const text = await navigator.clipboard.readText();
      return { ok: true, text };
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  try {
    const response = (await ext.runtime.sendMessage({ type: 'clipboard/read' })) as
      | ClipboardReadResponse
      | undefined;
    if (response) return { ok: response.ok, text: response.text, message: response.message };
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  return { ok: false, text: '', message: lastError || '读不到剪贴板' };
}

/** 把一段文本交给后台的「内置粘贴」写进作答区 */
async function sendPaste(text: string): Promise<void> {
  pasting = true;
  try {
    showToast(`正在写入作答区（${text.length} 个字符）…`);
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = (await ext.runtime.sendMessage({
      type: 'code/paste',
      requestId,
      text,
    })) as ToolRunResponse | undefined;
    if (response?.ok) showToast(`已粘贴 ${text.length} 个字符（内置粘贴）`);
    else showToast(`粘贴失败：${response?.result ?? '插件后台没有响应'}`, 'error');
  } catch (error) {
    showToast(`粘贴失败：${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    pasting = false;
  }
}

/** 快捷键路径：先读剪贴板，再交给内置粘贴 */
async function pasteClipboardText(): Promise<void> {
  if (pasting) {
    showToast('上一次粘贴还在写入，稍等一下');
    return;
  }
  pasting = true;
  showToast('正在读取剪贴板…');
  try {
    const clip = await readClipboard();
    if (!clip.ok || !clip.text) {
      showToast(
        `读不到剪贴板：${clip.message ?? '浏览器没有授权'}。可以再按一次 Ctrl+M 试试`,
        'error',
      );
      return;
    }
    await sendPaste(clip.text);
  } finally {
    pasting = false;
  }
}

/** 快捷键拦下来之后立即同步阻止默认行为与页面监听器 */
function swallow(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export function installPasteBridge(): void {
  if (installed) return;
  installed = true;

  // 一、快捷键：Ctrl+V / ⌘V 直接接管；抢不过页面时用 Ctrl+M
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.repeat) return;
      const chord = event.ctrlKey || event.metaKey;
      if (!chord || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'v' && key !== 'm') return;
      if (!editableTarget(event)) return;
      swallow(event);
      void pasteClipboardText();
    },
    true,
  );

  // 二、右键菜单/中键粘贴走的是 paste 事件：同样接过手来，避免触发页面的「禁止粘贴」
  window.addEventListener(
    'paste',
    (event) => {
      if (!editableTarget(event)) return;
      const text = event.clipboardData?.getData('text') ?? '';
      if (!text) return;
      swallow(event);
      void pasteTextDirect(text);
    },
    true,
  );
}

/** paste 事件里已经拿到文本，不用再读一次剪贴板 */
async function pasteTextDirect(text: string): Promise<void> {
  if (pasting) return;
  await sendPaste(text);
}
