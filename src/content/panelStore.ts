// 悬浮窗开关状态放在 React 之外：content script 一执行就能收到 toggle 消息，
// 不会因为 React 还没 commit 而把消息丢掉（点图标没反应就是这么来的）。
type Listener = () => void;

let open = false;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function isPanelOpen(): boolean {
  return open;
}

export function setPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function togglePanel(): void {
  setPanelOpen(!open);
}

export function subscribePanel(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 「双击插件图标 → 恢复默认位置与大小」同样在 React 之外触发：
// content script 一收到消息就能记下来，React 还没挂载也不会丢。
let layoutResets = 0;
const layoutListeners = new Set<Listener>();

export function requestLayoutReset(): void {
  layoutResets += 1;
  layoutListeners.forEach((listener) => listener());
}

export function layoutResetCount(): number {
  return layoutResets;
}

export function subscribeLayoutReset(listener: Listener): () => void {
  layoutListeners.add(listener);
  return () => {
    layoutListeners.delete(listener);
  };
}
