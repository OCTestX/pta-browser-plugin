import { ext } from '../shared/browser';
import type { CursorProbe, TypistIo } from './typist';

/**
 * 用 chrome.debugger（CDP）发按键与文本：这样产生的事件是 trusted 的，
 * 编辑器、浏览器默认行为（换行、提交表单）都会正常响应。
 * 代价是被附加的标签页顶部会出现「正在调试此浏览器」横幅，所以做成开关、默认关闭，
 * 而且每次工具调用结束就断开。
 */
const PROTOCOL_VERSION = '1.3';
const attached = new Set<number>();

let listening = false;

function ensureDetachListener(): void {
  if (listening) return;
  listening = true;
  // 用户点了横幅上的「取消」，或者 DevTools 抢占了，都会被通知到
  ext.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId);
  });
}

async function attach(tabId: number): Promise<void> {
  ensureDetachListener();
  if (attached.has(tabId)) return;
  await ext.debugger.attach({ tabId }, PROTOCOL_VERSION);
  attached.add(tabId);
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.delete(tabId)) return;
  try {
    await ext.debugger.detach({ tabId });
  } catch {
    // 已经断开就算了
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 在页面主世界里求值（探针用），返回值必须能 JSON 化 */
async function evaluate<T>(tabId: number, expression: string): Promise<T | null> {
  const response = (await ext.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: unknown };

  if (response.exceptionDetails) return null;
  return response.result?.value ?? null;
}

/** 光标到本行末尾的文本：必须读到 .cm-line 末尾，语法高亮会把一行切成多个 span */
const PROBE_RIGHT = `(() => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let line = range.startContainer;
  while (line && !(line.classList && line.classList.contains('cm-line'))) line = line.parentElement;
  if (!line) return null;
  const tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(line, line.childNodes.length);
  return tail.toString();
})()`;

/** 光标列号与前导空白：列号用 Range 量，抗语法高亮把文本节点切碎；列号越界说明探针读到旧 DOM */
const PROBE_CURSOR = `(() => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  let line = range.startContainer;
  while (line && !(line.classList && line.classList.contains('cm-line'))) line = line.parentElement;
  if (!line) return null;
  const lineText = line.textContent || "";
  const before = document.createRange();
  before.selectNodeContents(line);
  before.setEnd(range.startContainer, range.startOffset);
  const col = before.toString().length;
  return { indent: (/^[ \\t]*/.exec(lineText) || [""])[0].length, col, stale: col > lineText.length };
})()`;

/**
 * 打字的 io：真实按键 + 页面内探针。
 * 逐字发真实按键（不粘贴、不直接改 DOM）：PTA 的 onpaste 是平台的反抄袭控制，
 * 剪贴板通道走不通，编辑器也只认正常的按键事件。
 */
export function createDebuggerIo(tabId: number): TypistIo {
  return {
    typeChar: async (char) => {
      await attach(tabId);
      await pressChar(tabId, char);
    },
    press: async (key) => {
      await attach(tabId);
      await pressKey(tabId, key);
    },
    probeRight: () => evaluate<string>(tabId, PROBE_RIGHT),
    probeCursor: () => evaluate<CursorProbe>(tabId, PROBE_CURSOR),
    delay: async (ms) => {
      await sleep(ms);
    },
  };
}

export async function ensureAttached(tabId: number): Promise<void> {
  await attach(tabId);
}

/** 一次性插入整段文本（CDP 的输入法式插入，单条命令） */
export async function insertTextOnce(tabId: number, text: string): Promise<void> {
  await attach(tabId);
  await ext.debugger.sendCommand({ tabId }, 'Input.insertText', { text });
}

/** 带 Ctrl 的组合键（用于对照实验里的真粘贴） */
export async function pressWithCtrl(tabId: number, key: string): Promise<void> {
  await attach(tabId);
  const code = `Key${key.toUpperCase()}`;
  const keyCode = key.toUpperCase().charCodeAt(0);
  await ext.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    modifiers: 2,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    code,
    key,
  });
  await ext.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers: 2,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    code,
    key,
  });
}

/**
 * 原子写入之后戳一下页面：敲一个空格再退格，净效果为零，
 * 但会产生真实的输入事件，触发页面「内容被改过」的标记（否则提交按钮可能是灰的）。
 */
export async function pokeEditor(tabId: number): Promise<void> {
  await attach(tabId);
  await pressChar(tabId, ' ');
  await pressKey(tabId, 'Backspace');
}

/** 单字符按键：type=char 只负责把字符插到光标处 */
async function pressChar(tabId: number, char: string): Promise<void> {
  await ext.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'char',
    text: char,
    unmodifiedText: char,
    key: char,
  });
}

interface KeyDescriptor {
  keyCode: number;
  code: string;
  text?: string;
}

const KEYS: Record<string, KeyDescriptor> = {
  Enter: { keyCode: 13, code: 'Enter', text: '\r' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  Delete: { keyCode: 46, code: 'Delete' },
  ' ': { keyCode: 32, code: 'Space', text: ' ' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  Home: { keyCode: 36, code: 'Home' },
  End: { keyCode: 35, code: 'End' },
};

function describeKey(key: string): KeyDescriptor {
  const known = KEYS[key];
  if (known) return known;
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      keyCode: upper.charCodeAt(0),
      code: /[a-z]/i.test(key) ? `Key${upper}` : `Digit${key}`,
      text: key,
    };
  }
  return { keyCode: 0, code: key };
}

/** 按下一个键（keyDown + keyUp），走浏览器输入管线，所以默认行为会发生 */
export async function pressKey(tabId: number, key: string): Promise<void> {
  await attach(tabId);
  const { keyCode, code, text } = describeKey(key);
  const base = { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, key };

  await ext.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    ...base,
    type: text ? 'keyDown' : 'rawKeyDown',
    ...(text ? { text } : {}),
  });
  await ext.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    ...base,
    type: 'keyUp',
  });
}
