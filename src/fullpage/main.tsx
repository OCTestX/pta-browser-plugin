import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FullPageApp } from './App';
import { katexStyles } from '../content/katexStyles';
import { initState } from '../content/panelStore';
import styles from '../content/styles.css?inline';

const HOST_ID = 'pta-assistant-fullpage-host';

async function mount(): Promise<void> {
  // 初始化共享状态（从 storage.local 恢复面板开关 + 草稿等）
  await initState();

  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);

  const style = document.createElement('style');
  // 复用悬浮窗样式 + KaTeX 样式
  style.textContent = `${katexStyles()}\n${styles}`;
  document.head.appendChild(style);

  const root = createRoot(host);
  root.render(createElement(FullPageApp));
}

// 初始化页面
window.addEventListener('DOMContentLoaded', () => {
  void mount();
});
