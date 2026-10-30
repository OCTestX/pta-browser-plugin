// 悬浮窗开关状态 + 全局共享的输入草稿
// 通过 chrome.storage.local 实现跨标签页、跨页面同步
// 这样悬浮窗与最大化后的全页面标签可以共享同一个「草稿」，
// 甚至刷新页面、关闭页面后重新打开也能恢复

import { ext } from '../shared/browser';

type Listener = () => void;

const STATE_KEY = 'pta-assistant-state';

interface AssistantState {
  panelOpen: boolean;
  layoutResetCount: number;
  draft: string;
}

const DEFAULT_STATE: AssistantState = {
  panelOpen: false,
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
    currentState = {
      ...DEFAULT_STATE,
      ...stored,
      panelOpen: false, // 刷新后默认关闭，点击图标再打开
    };
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

export function isPanelOpen(): boolean {
  return currentState.panelOpen;
}

export function setPanelOpen(next: boolean): void {
  if (currentState.panelOpen === next) return;
  mutated = true;
  currentState = { ...currentState, panelOpen: next };
  emit();
  void persist();
}

export function togglePanel(): void {
  setPanelOpen(!currentState.panelOpen);
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

export function resetLayoutTrigger(): void {
  mutated = true;
  currentState = { ...currentState, layoutResetCount: 0 };
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
