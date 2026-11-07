// 全局共享的输入草稿 + 本标签页私有的悬浮窗开关
// 草稿通过 chrome.storage.local 跨标签页、跨页面同步：
// 刷新页面、关掉重开都能恢复草稿，拖动/缩放的位置也一起记住。
// 悬浮窗开关（panelOpen）只在当前标签页内存里，不进 storage、不跨标签页同步。

import { ext } from '../shared/browser';

type Listener = () => void;

const STATE_KEY = 'pta-assistant-state';

interface AssistantState {
  layoutResetCount: number;
  draft: string;
}

const DEFAULT_STATE: AssistantState = {
  layoutResetCount: 0,
  draft: '',
};

// 当前页面的内存缓存
let currentState: AssistantState = { ...DEFAULT_STATE };
// 标记：本页面是否已经有本地变更（toggle / 打字等），
// 如果有，就不要等 storage 异步返回后把这些变更给覆盖掉
let mutated = false;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

// 初始化：从 storage.local 恢复状态。
// 仅在「页面刚加载、用户还没动过」的时候回放，否则会把刚刚 toggle 打开的状态给冲掉。
// 注意：panelOpen 不回放——刷新后悬浮窗默认关闭，点图标才打开（保持 toggle 语义）；
// draft 回放，保证跨页面刷新后输入框内容不丢。
export async function initState(): Promise<void> {
  const result = await ext.storage.local.get([STATE_KEY]);
  const stored = result[STATE_KEY] as AssistantState | undefined;
  if (stored && !mutated) {
    currentState = { ...DEFAULT_STATE, ...stored };
    emit();
  }
}

// 保存到 storage.local
async function persist(): Promise<void> {
  await ext.storage.local.set({ [STATE_KEY]: currentState });
}

// 监听 storage 变化，实现跨标签页同步
const onChanged = ext.storage.onChanged;
if (onChanged && typeof onChanged.addListener === 'function') {
  onChanged.addListener((changes) => {
    if (changes[STATE_KEY]) {
      const next = changes[STATE_KEY].newValue as AssistantState | undefined;
      if (next) {
        currentState = { ...DEFAULT_STATE, ...next };
        emit();
      }
    }
  });
}

// 本标签页悬浮窗开关：只在当前 tab 内有效。
// 不写 storage、不参与 storage 变更同步，
// 这样在 A 标签页打开悬浮窗不会让 B 标签页的面板也弹出来。
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

// 布局重置
export function requestLayoutReset(): void {
  mutated = true;
  currentState = { ...currentState, layoutResetCount: currentState.layoutResetCount + 1 };
  emit();
  void persist();
}

export function layoutResetCount(): number {
  return currentState.layoutResetCount;
}

export function subscribeLayoutReset(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 全局共享的输入草稿
export function getDraft(): string {
  return currentState.draft;
}

export function setDraft(draft: string): void {
  if (currentState.draft === draft) return;
  mutated = true;
  currentState = { ...currentState, draft };
  emit();
  void persist();
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
