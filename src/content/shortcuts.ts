// 悬浮窗的全局快捷键。
//
// Alt+G：打开悬浮窗，并把光标直接放进输入框——用户按完就能立刻打字，不用再点一下输入框。
//        面板已经开着的时候按 Alt+G 不重复打开，只把光标送回输入框。
// Esc  ：关闭悬浮窗。面板没开着的时候不拦，页面自己的 Esc 行为（关弹窗等）保持原样。
//
// 快捷键挂在 window 的捕获阶段，这样能抢在页面自己的监听器之前拿到事件。
import { isPanelOpen, requestComposerFocus, setPanelOpen } from './panelStore';

let installed = false;

export function installPanelShortcuts(): void {
  if (installed) return;
  installed = true;

  window.addEventListener(
    'keydown',
    (event) => {
      // Alt+G：打开面板 + 聚焦输入框
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        event.stopPropagation();
        // 先记下「要聚焦」，再打开面板：面板挂载后 Composer 才会拿到这个信号
        requestComposerFocus();
        setPanelOpen(true);
        return;
      }

      // Esc：关闭面板（只在我们自己的面板开着时才管）
      if (event.key === 'Escape' && isPanelOpen()) {
        setPanelOpen(false);
      }
    },
    true,
  );
}
