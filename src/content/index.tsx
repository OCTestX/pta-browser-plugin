import { createRoot } from 'react-dom/client';
import { App } from './App';
import { togglePanel } from './panelStore';
import { ext } from '../shared/browser';
import { isTogglePanelMessage } from '../shared/messages';
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
  style.textContent = styles;
  shadow.appendChild(style);

  const container = document.createElement('div');
  shadow.appendChild(container);

  createRoot(container).render(<App />);
}

function start(): void {
  if (isInjected()) return;

  // 在模块顶层注册，保证后台发来的 toggle 一定有人接
  ext.runtime.onMessage.addListener((message: unknown) => {
    if (isTogglePanelMessage(message)) togglePanel();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
}

start();
