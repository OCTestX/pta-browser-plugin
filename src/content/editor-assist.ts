// 编辑器增强的页面侧（隔离世界）。
//
// 分工：MAIN world 的 agent 负责一切 DOM/编辑器几何（只有它拿得到 CodeMirror 实例），
// 这里负责三件它做不到的事：
//   1. 让后台把 agent 注入进页面（隔离世界没有 scripting 权限）；
//   2. 用共享层算彩虹括号的层数、整理代码 —— 纯逻辑留在 TS 里，Node 能单测；
//   3. 把代码送进后台的内置编译器做实时检查（v5.0）。
//
// 两侧的通信用 window.postMessage：标记字段是我们自己的随机 token，
// 页面自己的消息会被 isAssistMessage 筛掉。

import { ext } from '../shared/browser';
import { bracketDepths } from '../shared/code-brackets';
import { formatCode, formatSummary } from '../shared/code-format';
import {
  assistMessage,
  isAssistMessage,
  type AgentCommand,
  type AgentEvent,
} from '../shared/editor-assist-protocol';
import type { EditorAssistInstallResponse, EditorCheckResponse } from '../shared/messages';

/** 装过一次就不再装：换题是前端路由，agent 会自己重新绑定编辑器 */
let started = false;
/** 没找到作答区之前每 2 秒试一次 */
let retry: number | null = null;

const isProblemPage = (): boolean =>
  /(^|\.)pintia\.cn$/.test(location.hostname) && /\/problems\//.test(location.pathname);

/** PTA 地址是 SPA 路由，所以能不能装要看当前路径，而不是页面加载时的那一次 */
export function startEditorAssist(): void {
  if (started) return;
  if (!/(^|\.)pintia\.cn$/.test(location.hostname)) return;
  if (isProblemPage()) {
    void install();
    return;
  }
  retry = setInterval(() => {
    if (!isProblemPage()) return;
    if (retry) clearInterval(retry);
    retry = null;
    void install();
  }, 2000);
}

async function install(): Promise<void> {
  if (started) return;
  let response: EditorAssistInstallResponse;
  try {
    response = (await ext.runtime.sendMessage({ type: 'editor/assist/install' })) as EditorAssistInstallResponse;
  } catch {
    return; // 后台还没醒（或旧版本插件）：下次进题页再试
  }
  if (!response?.ok || !response.token) return;
  started = true;

  const token = response.token;
  console.info('[PTA 助手] 编辑器增强已挂载（%s）', response.world ?? 'MAIN');

  window.addEventListener('message', (event: MessageEvent) => {
    // 只认本窗口发的：跨 iframe 的消息不归我们管
    if (event.source !== window) return;
    if (!isAssistMessage(event.data, token)) return;
    const message = event.data as AgentEvent;
    void handle(token, message);
  });
}

async function handle(token: string, message: AgentEvent): Promise<void> {
  switch (message.kind) {
    case 'doc': {
      // 括号层数是纯文本问题，在这里算完再交给页面去上色
      const marks = bracketDepths(message.text);
      post(token, { kind: 'rainbow', text: message.text, marks });
      if (message.check) await runCheck(token, message.text, message.language, message.fragment === true);
      return;
    }
    case 'format-request': {
      const formatted = formatCode(message.text, message.language);
      post(token, {
        kind: 'format-apply',
        source: message.text,
        text: formatted,
        summary: formatSummary(message.text, formatted),
      });
      return;
    }
    case 'hello':
    case 'editor-lost':
      return;
    default:
      return;
  }
}

/**
 * 实时检查：只编译不运行（内置引擎的 -fsyntax-only，几十毫秒）。
 *
 * 结果带原文一起回给页面脚本：页面脚本只认「文本还对得上」的那一份，
 * 用户又改了字就直接丢掉，波浪线永远比正文慢一拍也不会画错位置。
 */
async function runCheck(token: string, text: string, language: string, fragment = false): Promise<void> {
  let response: EditorCheckResponse | undefined;
  try {
    response = (await ext.runtime.sendMessage({
      type: 'editor/check',
      code: text,
      language,
      fragment,
    })) as EditorCheckResponse;
  } catch {
    return; // 后台没醒 / 重载中：这一轮不画，下一次改动会再来
  }
  if (!response) return;
  post(token, {
    kind: 'diagnostics',
    text,
    boxes: Array.isArray(response.diagnostics) ? response.diagnostics : [],
    note: response.note || response.message || '',
  });
}

function post(token: string, payload: AgentCommand): void {
  window.postMessage(assistMessage(token, payload as unknown as Record<string, unknown>), '*');
}
