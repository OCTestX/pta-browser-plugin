// 读系统剪贴板的兜底通道。
//
// content script 先自己试 navigator.clipboard.readText()；失败（页面抢了焦点、没给权限）
// 再来这里：
// - Chrome：service worker 没有 DOM，交给引擎用的 offscreen 文档（execCommand('paste')）
// - Firefox：background 是带 DOM 的 event page，直接自己读
import { ext } from '../shared/browser';
import { ensureOffscreenDocument } from './compiler-host';

export interface ClipboardRead {
  ok: boolean;
  text: string;
  message?: string;
}

interface OffscreenReply {
  ok?: boolean;
  text?: unknown;
  message?: unknown;
}

/** id -> 等 offscreen 回复的 resolve */
const pending = new Map<string, (reply: OffscreenReply) => void>();
let replyListenerInstalled = false;

function installReplyListener(): void {
  if (replyListenerInstalled || typeof ext?.runtime?.onMessage?.addListener !== 'function') return;
  replyListenerInstalled = true;
  ext.runtime.onMessage.addListener((message: unknown) => {
    const reply = message as { type?: string; id?: string } | null;
    if (reply?.type !== 'clipboard-read-response' || typeof reply.id !== 'string') return undefined;
    const done = pending.get(reply.id);
    if (done) {
      pending.delete(reply.id);
      done(reply as OffscreenReply);
    }
    return undefined;
  });
}

const OFFSCREEN_TIMEOUT_MS = 2500;

async function readViaOffscreen(): Promise<ClipboardRead> {
  installReplyListener();
  try {
    await ensureOffscreenDocument();
  } catch (error) {
    return {
      ok: false,
      text: '',
      message: `剪贴板读取页打不开：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const id = `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 不用 Promise.withResolvers：清单最低支持 Firefox 115，那边还没有这个 API
  const reply = await new Promise<OffscreenReply>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, message: '读取剪贴板超时' });
    }, OFFSCREEN_TIMEOUT_MS);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    void ext.runtime.sendMessage({ type: 'clipboard-read-request', id }).catch((error: unknown) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, message: `剪贴板读取页没有响应：${error instanceof Error ? error.message : String(error)}` });
    });
  });

  const text = typeof reply.text === 'string' ? reply.text : '';
  if (reply.ok === true) return { ok: true, text };
  return {
    ok: false,
    text,
    message: typeof reply.message === 'string' ? reply.message : '浏览器没有返回剪贴板内容',
  };
}

/** Firefox 的 background 页有 DOM：直接建个 textarea 走 execCommand */
function readViaBackgroundDom(): ClipboardRead {
  if (typeof document === 'undefined' || !document.createElement) {
    return { ok: false, text: '', message: '当前环境读不到剪贴板' };
  }
  const area = document.createElement('textarea');
  area.value = '';
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('paste');
  } catch {
    ok = false;
  }
  const text = area.value;
  area.remove();
  if (ok) return { ok: true, text };
  return { ok: false, text, message: '浏览器拒绝读取剪贴板（execCommand paste 被拦）' };
}

export async function readClipboardText(): Promise<ClipboardRead> {
  if (typeof ext?.offscreen?.createDocument === 'function') return readViaOffscreen();
  return readViaBackgroundDom();
}
