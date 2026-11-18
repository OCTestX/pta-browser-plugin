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
let retry: number | undefined;

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
  scheduleRetry();
}

/**
 * 每两秒看一眼，没装上就再试。
 *
 * 装不上的原因多是「后台还没醒」「扩展刚更新」「页面上还留着旧版本注入的脚本」，
 * 这些都是过一会儿就会好的情况。只试一次的话，这个标签页里增强就彻底废了
 * （PTA 换题不刷新页面，没有第二次注入的机会）。
 */
function scheduleRetry(): void {
  if (retry !== undefined || started) return;
  retry = window.setInterval(() => {
    if (!isProblemPage()) return;
    if (retry !== undefined) window.clearInterval(retry);
    retry = undefined;
    void install();
  }, 2000);
}

async function install(): Promise<void> {
  if (started) return;
  let response: EditorAssistInstallResponse;
  try {
    response = (await ext.runtime.sendMessage({ type: 'editor/assist/install' })) as EditorAssistInstallResponse;
  } catch {
    scheduleRetry(); // 后台还没醒（或旧版本插件）：过会儿再试
    return;
  }
  if (!response?.ok || !response.token) {
    scheduleRetry();
    return;
  }
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
 * 实时检查：C/C++ 用内置引擎的 -fsyntax-only，Python3 用 Pyodide 的 compile()，
 * 都只检查、不运行；Java 走规则检查。
 *
 * 结果带原文一起回给页面脚本：页面脚本只认「文本还对得上」的那一份，
 * 用户又改了字就直接丢掉，波浪线永远比正文慢一拍也不会画错位置。
 *
 * 同一时刻只留一个检查在跑：内置引擎一次只能处理一个请求，剩下的排队，
 * 排队超过十几秒就报「编译器忙」。用户连续敲字时排队的全是已经被丢弃的旧版本，
 * 最新那一份反而排不上，徽标就从「没有语法错误」变成「编译器忙」——等于没有实时检查。
 * 所以后来的检查只留最新的那一份文本，等前一次跑完再查。
 */
let checkInFlight = false;
let checkPending: { text: string; language: string; fragment: boolean } | null = null;

async function runCheck(token: string, text: string, language: string, fragment = false): Promise<void> {
  if (checkInFlight) {
    checkPending = { text, language, fragment };
    return;
  }
  checkInFlight = true;
  try {
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
  } finally {
    checkInFlight = false;
    const pending = checkPending;
    checkPending = null;
    // 文本没变就不用再查一遍（这次的结果就是最新的）
    if (pending && pending.text !== text) {
      void runCheck(token, pending.text, pending.language, pending.fragment);
    }
  }
}

function post(token: string, payload: AgentCommand): void {
  window.postMessage(assistMessage(token, payload as unknown as Record<string, unknown>), '*');
}
