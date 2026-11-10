import type { ToolRunResponse } from '../shared/messages';

/** 需要页面上下文才能执行的工具：url / write_document / simulate_keyboard_input 都在这里 */
export function runPageTool(name: string, args: Record<string, unknown>): ToolRunResponse {
  if (name === 'url') return { ok: true, result: window.location.href };
  if (name === 'write_document') return writeDocument(args);
  if (name === 'write_zip') return writeZip(args);
  if (name === 'simulate_keyboard_input') return simulateKeyboardInput(args);
  return { ok: false, result: `未知工具：${name}` };
}

function writeDocument(args: Record<string, unknown>): ToolRunResponse {
  const content = typeof args.content === 'string' ? args.content : '';
  const hasFiles = args.files && typeof args.files === 'object' && !Array.isArray(args.files);
  if (!content.trim() && !hasFiles) return { ok: false, result: '缺少 content 或 files 参数' };

  const filename = sanitizeFilename(
    typeof args.filename === 'string' && args.filename.trim() ? args.filename : 'PTA-助手文档.txt',
  );

  // 多文件题（type/9）要上传 zip：content 是一段 JSON，形如
  // { "src/a.py": "...", "src/b.py": "..." }，这里打成 zip 下载给用户。
  const files = args.files;
  if (files && typeof files === 'object' && !Array.isArray(files)) {
    return writeZipBundle(filename, files as Record<string, unknown>);
  }

  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  download(url, filename);
  return { ok: true, result: `已触发下载：${filename}（${content.length} 字符）` };
}

/** 独立的 write_zip 工具：只接受 files，不接受 content。 */
function writeZip(args: Record<string, unknown>): ToolRunResponse {
  const files = args.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return { ok: false, result: '缺少 files 参数（{ "src/a.py": "内容", ... }）' };
  }
  const filename = sanitizeFilename(
    typeof args.filename === 'string' && args.filename.trim() ? args.filename : 'pta-answer.zip',
  );
  return writeZipBundle(filename.endsWith('.zip') ? filename : `${filename}.zip`, files as Record<string, unknown>);
}

function download(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  // 必须挂进文档里，Firefox 才会真的触发下载
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 用浏览器原生 Blob 生成最小可用的 zip（store 模式，无需外部库）。 */
function writeZipBundle(filename: string, files: Record<string, unknown>): ToolRunResponse {
  const entries = Object.entries(files)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([path, text]) => ({ path: sanitizeZipPath(path), bytes: new TextEncoder().encode(text) }))
    .filter((entry) => entry.path.length > 0 && !entry.path.split('/').includes('..'));
  if (entries.length === 0) return { ok: false, result: 'files 里没有可用的文本内容' };

  const chunks: Uint8Array[] = [];
  const central: { name: Uint8Array; offset: number; size: number; crc: number }[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => { chunks.push(bytes); offset += bytes.length; };
  const u16 = (value: number) => new Uint8Array([value & 255, (value >> 8) & 255]);
  const u32 = (value: number) => new Uint8Array([
    value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255,
  ]);

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.path);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc32(entry.bytes)), u32(entry.bytes.length), u32(entry.bytes.length),
      u16(name.length), u16(0), name, entry.bytes,
    ]);
    central.push({ name, offset, size: entry.bytes.length, crc: crc32(entry.bytes) });
    push(local);
  }
  const centralStart = offset;
  for (const item of central) {
    push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(item.crc), u32(item.size), u32(item.size),
      u16(item.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(item.offset), item.name,
    ]));
  }
  const centralSize = offset - centralStart;
  push(concatBytes([
    u32(0x06054b50), u16(0), u16(0),
    u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0),
  ]));

  const blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  download(url, filename.endsWith('.zip') ? filename : `${filename}.zip`);
  return {
    ok: true,
    result: `已触发下载：${filename.endsWith('.zip') ? filename : `${filename}.zip`}（${entries.length} 个文件，可用「Upload Answer Zip」上传）`,
  };
}

function sanitizeZipPath(path: string): string {
  const value = String(path);
  if (value.includes('..')) return '';
  const parts = value.split(/[\\\\/]+/).filter((part) => part && part !== '.');
  return parts.join('/').slice(0, 200);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 文件名里的路径分隔符和控制字符会让浏览器拒绝下载 */
function sanitizeFilename(filename: string): string {
  return filename.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

/* ---------- 模拟键盘输入 ---------- */

function simulateKeyboardInput(args: Record<string, unknown>): ToolRunResponse {
  const text = typeof args.text === 'string' ? args.text : '';
  const press = typeof args.press === 'string' ? args.press.trim() : '';
  // 开了真实按键时，background 只让我们负责聚焦（输入交给 CDP）
  const focusOnly = args.focusOnly === true;
  // CDP 输入完之后回读编辑器内容，用来确认真的敲进去了
  const readOnly = args.readOnly === true;
  if (!text && !press && !focusOnly && !readOnly) {
    return { ok: false, result: '至少要给 text（要输入的文字）或 press（要按的键）' };
  }

  const selector = typeof args.selector === 'string' ? args.selector.trim() : '';
  let target: Element | null = null;
  if (selector) {
    target = document.querySelector(selector);
    if (!target) return { ok: false, result: `页面上找不到匹配 ${selector} 的元素` };
  }

  if (readOnly) {
    const element = (target ?? findEditor()) as HTMLElement | null;
    if (!element) return { ok: false, result: '页面上没找到可读的编辑区域' };
    return { ok: true, result: readEditorText(element) };
  }

  const steps: string[] = [];
  if (target) {
    focusElement(target);
    steps.push(`已把焦点放到 ${describeElement(target)}`);
  } else {
    // 没给 selector：先按「页面里最大的可编辑区域」猜（PTA 的作答区就是这么找的），再退回当前焦点
    const editor = findEditor();
    if (editor) {
      focusElement(editor);
      steps.push(`没给 selector，已自动把焦点放到最大的可编辑区域 ${describeElement(editor)}`);
    } else if (!document.activeElement || document.activeElement === document.body) {
      return { ok: false, result: '页面上找不到可编辑区域，也没有聚焦的元素，请用 selector 指定' };
    }
  }

  if (focusOnly) {
    const element = (target ?? document.activeElement) as HTMLElement;
    // 选中已有内容：后面 CDP 的输入会直接替换掉它
    if (args.clear === true) {
      selectAll(element);
      steps.push('已选中原有内容（会被输入替换）');
    }
    return { ok: true, result: steps.join('；') };
  }

  if (text) {
    const element = (target ?? document.activeElement) as HTMLElement;
    const outcome = insertText(element, text, args.clear === true);
    steps.push(outcome);
  }

  if (press) {
    const element = (target ?? document.activeElement) as HTMLElement | null;
    if (!element) return { ok: false, result: '没有可以接收按键的元素' };
    pressKey(element, press);
    steps.push(`已按下 ${press}`);
  }

  return { ok: true, result: steps.join('；') };
}

function focusElement(element: Element): void {
  const html = element as HTMLElement;
  // 很多编辑器和页面逻辑要点一下才真的聚焦
  html.click();
  html.focus?.();
}

function insertText(element: HTMLElement, text: string, clear: boolean): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    // React 受控组件会忽略直接赋值，要走原型上的 setter 再派发 input
    const prototype =
      element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    const next = clear ? text : element.value + text;
    if (setter) setter.call(element, next);
    else element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return `已向 ${describeElement(element)} 写入「${preview(text)}」${clear ? '（先清空了原内容）' : ''}`;
  }

  if (isEditable(element)) {
    if (clear) selectAll(element);
    // contenteditable（含 CodeMirror 6 / Monaco 这类编辑器）走 execCommand，
    // 它能产生正常的 beforeinput / input 事件链
    if (insertTextWithExecCommand(text)) {
      return `已向 ${describeElement(element)} 写入「${preview(text)}」${clear ? '（先清空了原内容）' : ''}`;
    }
    appendTextNode(element, text);
    return `execCommand 不可用，已直接把文本插入 ${describeElement(element)}：${preview(text)}`;
  }

  return `${describeElement(element)} 不是可输入元素（不是输入框也不是可编辑区域）`;
}

/**
 * 找「作答区」：PTA 的编辑器是 CodeMirror 6（.cm-content），题面里的样例框也是它但只读，
 * 所以要过滤 isContentEditable，再取文本最长的那个（页面上可能还残留上一题的编辑器）。
 */
function findEditor(): HTMLElement | null {
  const nodes = [...document.querySelectorAll('.cm-content, [contenteditable="true"]')];
  let best: HTMLElement | null = null;
  let bestLength = 0;
  for (const node of nodes) {
    const element = node as HTMLElement;
    if (!isEditable(element)) continue;
    // 浏览器里优先 innerText（渲染后的文本），环境没实现这个属性时退回 textContent
    const length = (element.innerText ?? element.textContent ?? '').length;
    if (!best || length > bestLength) {
      best = element;
      bestLength = length;
    }
  }
  return best;
}

/**
 * 回读编辑器内容。CodeMirror 只渲染视口附近的行，所以按 .cm-line 拼；
 * 不能读 innerText —— 它会多吐一个尾部换行，导致比对时整体错位一行。
 */
function readEditorText(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  const lines = [...element.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '');
  return lines.length > 0 ? lines.join('\n') : (element.textContent ?? '');
}

/** isContentEditable 是正路，个别环境没实现这个属性，就退回看 contenteditable 属性 */
function isEditable(element: HTMLElement): boolean {
  if (element.isContentEditable) return true;
  const attribute = element.getAttribute('contenteditable');
  return attribute === '' || attribute === 'true' || attribute === 'plaintext-only';
}

function insertTextWithExecCommand(text: string): boolean {
  try {
    return document.execCommand('insertText', false, text);
  } catch {
    return false;
  }
}

function appendTextNode(element: HTMLElement, text: string): void {
  element.appendChild(document.createTextNode(text));
  element.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
  );
}

function selectAll(element: HTMLElement): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.select();
    return;
  }
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

function pressKey(element: HTMLElement, key: string): void {
  const keyCode = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    const event = new KeyboardEvent(type, {
      key,
      code: key,
      bubbles: true,
      cancelable: true,
    });
    // 老代码会读 keyCode，未信任事件的取值由我们自己补上
    Object.defineProperty(event, 'keyCode', { value: keyCode });
    Object.defineProperty(event, 'which', { value: keyCode });
    element.dispatchEvent(event);
  }
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const className =
    typeof element.className === 'string' && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

function preview(text: string): string {
  const single = text.replace(/\s+/g, ' ');
  return single.length > 30 ? `${single.slice(0, 30)}…` : single;
}
