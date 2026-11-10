// 本标签页的输入草稿 + 悬浮窗开关
//
// 隔离单位是标签页，不是地址：同一个题目的两个标签页应该各写各的草稿。
// 所以草稿写在 sessionStorage 里（天然按标签页隔离、刷新不丢），键再按标签页 id
// 命名，含义写明白。不再往 chrome.storage.local 写，也就没有跨标签页同步。
// 悬浮窗开关（panelOpen）只活在内存里：刷新后默认关闭，点图标才打开。

type Listener = () => void;

// 标签页 id 存在 sessionStorage 里：刷新页面不会丢，所以刷新后还是同一个 id、
// 同一份草稿；新开的标签页是另一份 sessionStorage，会拿到新的 id。
// chatStore 用的是同一个键，两个模块在同一个标签页里读到的是同一个 id。
const TAB_ID_KEY = 'pta-assistant-tab-id';
const DRAFT_KEY_PREFIX = 'pta-assistant-draft';

// content script 启动时取一次 sessionStorage。
// 取不到（非浏览器环境、隐私模式抛异常）就退化成纯内存状态，功能不炸。
const tabStorage = ((): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
})();

let cachedTabId = '';

function tabId(): string {
  if (cachedTabId) return cachedTabId;
  if (!tabStorage) {
    cachedTabId = 'unknown';
    return cachedTabId;
  }
  try {
    const existing = tabStorage.getItem(TAB_ID_KEY);
    if (existing) {
      cachedTabId = existing;
      return cachedTabId;
    }
  } catch {
    cachedTabId = 'unknown';
    return cachedTabId;
  }
  const created = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    tabStorage.setItem(TAB_ID_KEY, created);
  } catch {
    // 写不进去也不影响这次会话，内存里照样能存
  }
  cachedTabId = created;
  return cachedTabId;
}

function draftKey(): string {
  return `${DRAFT_KEY_PREFIX}:${tabId()}`;
}

function readDraft(): string {
  if (!tabStorage) return '';
  try {
    return tabStorage.getItem(draftKey()) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(draft: string): void {
  if (!tabStorage) return;
  try {
    // 空草稿不占地方，也免得刷新后恢复出一个空字符串
    if (draft) tabStorage.setItem(draftKey(), draft);
    else tabStorage.removeItem(draftKey());
  } catch {
    // 配额满 / 隐私模式：存不下就只留内存，至少这次输入不丢
  }
}

const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

// 草稿在模块加载时同步恢复：React 首帧就能读到上次的内容，不需要异步回放。
// 也就不存在「storage 还没返回、用户已经打字导致互相覆盖」的竞态。
let draft = readDraft();

/**
 * 兼容入口：状态现在在模块加载时就从 sessionStorage 恢复了，没有异步回放要等。
 * 保留这个函数是为了不改 index.tsx 的启动顺序。
 */
export async function initState(): Promise<void> {
  // 草稿已经在模块加载时读出来了
}

// 本标签页悬浮窗开关：只在当前 tab 内有效。
// 不写 storage，这样在 A 标签页打开悬浮窗不会让 B 标签页的面板也弹出来。
let panelOpen = false;

export function isPanelOpen(): boolean {
  return panelOpen;
}

export function setPanelOpen(next: boolean): void {
  if (panelOpen === next) return;
  panelOpen = next;
  emit();
}

export function togglePanel(): void {
  setPanelOpen(!panelOpen);
}

export function subscribePanel(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 布局重置：双击插件图标 = 把位置与大小恢复默认。
// 这是一个一次性的命令计数，只放内存——刷新后没有「待重置」这回事，
// 也免得刷新时把刚调好的布局又重置一遍。
let resetCount = 0;

export function requestLayoutReset(): void {
  resetCount += 1;
  emit();
}

export function layoutResetCount(): number {
  return resetCount;
}

export function subscribeLayoutReset(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 本标签页的输入草稿
export function getDraft(): string {
  return draft;
}

export function setDraft(next: string): void {
  if (draft === next) return;
  draft = next;
  writeDraft(next);
  emit();
}

export function subscribeDraft(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 聚焦输入框的请求计数。
// Alt+G 要「打开面板并让光标停在输入框」，但面板关闭时 React 根本不渲染输入框，
// 所以这里用一个自增计数把这个意图记下来：Composer 挂载后看到计数变了就主动 focus。
// 只放内存里、不进 storage——刷新页面后没有「待聚焦」这回事。
let composerFocusCount = 0;

export function requestComposerFocus(): void {
  composerFocusCount += 1;
  emit();
}

export function composerFocusRequest(): number {
  return composerFocusCount;
}

export function subscribeComposerFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
