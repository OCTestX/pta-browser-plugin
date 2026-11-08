import { createRoot } from 'react-dom/client';
import { App } from './App';
import { renderExplainPage } from './explain-mode';
import { katexStyles } from './katexStyles';
import { runPageTool } from './pageTools';
import { installPasteBridge } from './paste';
import { installPanelShortcuts } from './shortcuts';
import { initState, requestLayoutReset, togglePanel } from './panelStore';
import { ext } from '../shared/browser';
import { isResetPanelLayoutMessage, isRunToolRequest, isTogglePanelMessage } from '../shared/messages';
import diffStyles from '../shared/diff.css?inline';
import styles from './styles.css?inline';

const HOST_ID = 'pta-assistant-host';
// 同一个页面可能被注入两次（声明式注入一次、点图标时兜底注入一次），只初始化一次
const INJECTED_FLAG = '__ptaAssistantInjected';

function isInjected(): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[INJECTED_FLAG]) return true;
  scope[INJECTED_FLAG] = true;
  return false;
}

function mount(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // 挂在 documentElement 上，尽量少受页面自身 body 结构影响
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // KaTeX 的样式放前面，我们的样式放后面；diff 的样式两边（卡片 / 全屏页）共用
  style.textContent = `${katexStyles()}\n${diffStyles}\n${styles}`;
  shadow.appendChild(style);

  const container = document.createElement('div');
  shadow.appendChild(container);

  createRoot(container).render(<App />);
}

function start(): void {
  if (isInjected()) return;

  // 消息监听必须**同步**注册：React 还没挂上的时候后台就发来 toggle，
  // 也得有人接（否则那一下开关就丢了，悬浮窗再也开不出来）。
  ext.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (isTogglePanelMessage(message)) {
      togglePanel();
      return undefined;
    }
    if (isResetPanelLayoutMessage(message)) {
      requestLayoutReset();
      return undefined;
    }
    if (isRunToolRequest(message)) {
      sendResponse(runPageTool(message.name, message.args));
      return undefined;
    }
    return undefined;
  });

  // 讲解页（/what 生成的那份 HTML）由这个页面自己渲染，别再挂悬浮窗上去
  void renderExplainPage().then((handled) => {
    if (handled) return;
    bootPanel();
  });
}

function bootPanel(): void {
  // 初始化共享状态（从 storage.local 恢复面板开关 + 草稿等）
  void initState();
  // 接管 Ctrl+V / Ctrl+M：PTA 禁粘贴时用插件自己的写入链路把剪贴板内容塞进作答区
  installPasteBridge();
  // Alt+G 打开悬浮窗并聚焦输入框，Esc 关闭悬浮窗
  installPanelShortcuts();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

start();
