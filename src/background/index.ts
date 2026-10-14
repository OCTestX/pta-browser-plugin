import { ext } from '../shared/browser';
import type { ExtMessage } from '../shared/messages';

const TOGGLE_PANEL: ExtMessage = { type: 'toggle-panel' };

// 点击工具栏图标 -> 通知当前标签页里的 content script 开/关悬浮窗
ext.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // 页面没有注入 content script（如 chrome:// 内部页）时会 reject，忽略即可
  void ext.tabs.sendMessage(tab.id, TOGGLE_PANEL).catch(() => undefined);
});
