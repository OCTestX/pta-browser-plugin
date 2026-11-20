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
  type EditorAssistFeatures,
} from '../shared/editor-assist-protocol';
import type { EditorAssistInstallResponse, EditorCheckResponse } from '../shared/messages';
import type { SettingsView } from '../shared/settings';

/** 装过一次就不再装：换题是前端路由，agent 会自己重新绑定编辑器 */
let started = false;
/** 没找到作答区之前每 2 秒试一次 */
let retry: number | undefined;
/** 当前安装用的 token：设置变化时要往页面里重发 configure */
let installedToken = '';

/** 补全项的历史使用次数（这个名字用过几次），键是补全的名字 */
const HINT_FREQ_KEY = 'pta-assistant-hint-frequency';

/** 同一份设置键：设置页保存的就是它，变化时把新开关推给页面 */
const SETTINGS_STORAGE_KEY = 'pta-assistant-settings';

/** 视图里的开关 → 页面脚本的功能位（format/rainbow/check/hover 恒开） */
function featuresFromView(view: Partial<SettingsView> | null | undefined): Partial<EditorAssistFeatures> {
  return {
    format: true,
    rainbow: true,
    check: true,
    hover: true,
    hyphenate: view?.hyphenate === true,
    indentGuides: view?.indentGuides === true,
    codeHints: view?.codeHints === true,
  };
}

async function readHintFrequency(): Promise<Record<string, number>> {
  try {
    const stored = await ext.storage.local.get(HINT_FREQ_KEY);
    const value = stored[HINT_FREQ_KEY];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, number> = {};
      for (const [label, count] of Object.entries(value as Record<string, unknown>)) {
        if (typeof count === 'number' && Number.isFinite(count)) out[label] = count;
      }
      return out;
    }
  } catch {
    /* 读不到就当没历史 */
  }
  return {};
}

/** 把运行中的开关与频率推给页面脚本：设置页一改就生效，不用刷新页面 */
async function pushConfigure(token: string): Promise<void> {
  try {
    const view = (await ext.runtime.sendMessage({ type: 'settings/get' })) as SettingsView | undefined;
    const freq = await readHintFrequency();
    post(token, { kind: 'configure', features: featuresFromView(view), freq });
  } catch {
    /* 后台没醒：下一次 hello 还会再推一遍 */
  }
}

/** 用户用了一次补全：给这个名字记一次，下次它排前面 */
async function recordHintUse(label: string): Promise<void> {
  if (!label) return;
  try {
    const freq = await readHintFrequency();
    freq[label] = (freq[label] ?? 0) + 1;
    await ext.storage.local.set({ [HINT_FREQ_KEY]: freq });
  } catch {
    /* 记不上不影响补全本身 */
  }
}

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
  installedToken = token;
  console.info('[PTA 助手] 编辑器增强已挂载（%s）', response.world ?? 'MAIN');

  window.addEventListener('message', (event: MessageEvent) => {
    // 只认本窗口发的：跨 iframe 的消息不归我们管
    if (event.source !== window) return;
    if (!isAssistMessage(event.data, token)) return;
    const message = event.data as AgentEvent;
    void handle(token, message);
  });

  // 设置页可能在面板打开前就改过：先推一份当前开关，页面上立刻按新设置工作
  await pushConfigure(token);

  // 之后每次在设置页改动（开关 / 主题 / 提供商……）都重推一次
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(SETTINGS_STORAGE_KEY in changes)) return;
    if (installedToken) void pushConfigure(installedToken);
  });

  // 兜底：storage 事件可能在「页面还挂着旧 agent」或「后台刚醒」时丢掉，
  // 那种情况下用户打开了开关却一点反应都没有。每 10 秒重推一次当前开关，
  // 消息很小，代价可以忽略，但能把「设置不生效」这类问题直接消掉。
  window.setInterval(() => {
    if (installedToken) void pushConfigure(installedToken);
  }, 10_000);
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
      // 页面脚本（重新）绑上编辑器了：把当前开关推给它，别按安装时的旧设置跑
      void pushConfigure(token);
      return;
    case 'editor-lost':
      return;
    case 'hint-used':
      void recordHintUse(message.label);
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
