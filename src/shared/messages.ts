import type { ApiMessage } from './types';
import type { DiagnosticBox } from './editor-assist-protocol';
import type { Settings, SettingsView } from './settings';

/* ---------- background -> content ---------- */

export interface TogglePanelMessage {
  type: 'toggle-panel';
}

/** 双击插件图标：把悬浮窗的位置与大小恢复默认 */
export interface ResetPanelLayoutMessage {
  type: 'panel/reset-layout';
}

/** 改动前后两段文本，工具卡片左右对照展示 */
export interface DiffPayload {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
}

/** token 用量：接口在流式最后一帧回传，面板顶栏实时显示 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type BackgroundEvent =
  | TogglePanelMessage
  | ResetPanelLayoutMessage
  | { type: 'chat/delta'; requestId: string; text: string }
  | {
      type: 'chat/tool-start';
      requestId: string;
      callId: string;
      name: string;
      args: string;
    }
  | {
      type: 'chat/tool-end';
      requestId: string;
      callId: string;
      result: string;
      isError: boolean;
      /** diff 工具带这个字段，卡片才会左右对照显示 */
      diff?: DiffPayload;
    }
  /** ask 工具：把选择题发给面板，等用户点选后用 chat/ask-answer 回来 */
  | {
      type: 'chat/ask';
      requestId: string;
      callId: string;
      question: string;
      options: string[];
    }
  | { type: 'chat/notice'; requestId: string; text: string }
  /** 每轮请求结束后上报的累计 token 用量，面板顶栏实时显示 */
  | {
      type: 'chat/usage';
      requestId: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    }
  | { type: 'chat/done'; requestId: string; aborted: boolean }
  | { type: 'chat/error'; requestId: string; message: string };

export function isTogglePanelMessage(message: unknown): message is TogglePanelMessage {
  return isRecord(message) && message.type === 'toggle-panel';
}

export function isResetPanelLayoutMessage(message: unknown): message is ResetPanelLayoutMessage {
  return isRecord(message) && message.type === 'panel/reset-layout';
}

export function isChatEvent(
  message: unknown,
): message is Extract<BackgroundEvent, { requestId: string }> {
  return (
    isRecord(message) &&
    typeof message.requestId === 'string' &&
    typeof message.type === 'string' &&
    message.type.startsWith('chat/')
  );
}

/* ---------- content -> background ---------- */

/** 页面侧要执行的工具（需要访问 location / 触发下载），由 background 转给 content script */
export interface RunToolRequest {
  type: 'tool/run';
  name: string;
  args: Record<string, unknown>;
}

export type ContentRequest =
  | { type: 'chat/start'; requestId: string; messages: ApiMessage[] }
  | { type: 'chat/stop'; requestId: string }
  /**
   * 页面刚加载时问一句「这个标签页上有正在跑的对话吗」。
   *
   * PTA 自己刷新页面（PTA 的判题流程、或换题时的整页刷新）会让插件的悬浮窗
   * 重新挂载，之前那一轮的 requestId 就丢了：面板不再接收那一轮的事件，
   * 「停止」按钮也按不到后台。问一句就能重新挂上去。
   */
  | { type: 'chat/attach' }
  /** 用户在 ask 工具的卡片上点了一个选项 */
  | { type: 'chat/ask-answer'; requestId: string; callId: string; choice: string }
  /** 编辑器增强：让后台把 MAIN world 的 agent 装进页面（PTA 作答区只有主世界能拿到编辑器实例） */
  | { type: 'editor/assist/install' }
  /** 编辑器增强：把作答区当前代码送进内置编译器做一次「只编译不运行」的检查 */
  | { type: 'editor/check'; code: string; language: string }
  | { type: 'settings/get' }
  | { type: 'settings/save'; patch: Partial<Settings> }
  /** 设置页的「模拟输入测试」：按指定方法往作答区写一次文本 */
  | { type: 'tool/test-input'; text: string; method?: string }
  /** 问接口「你有哪些模型」：模型下拉框用。Key 只在 background 那边用，content 传过来的是草稿值 */
  | { type: 'models/list'; baseURL: string; apiKey?: string }
  /** 设置页的「一键跳转硅基流动」：让后台开一个新标签页 */
  | { type: 'ui/open-url'; url: string }
  /** diff 卡片右上角的「全屏」：content script 没有 chrome.tabs，让后台存下这份 diff 并开新标签页 */
  | { type: 'ui/open-diff'; diff: DiffPayload }
  /** 讲解页的邀请卡片：点「打开讲解页」让后台开新标签页 */
  | { type: 'ui/open-explain'; pageId: string }
  /** Ctrl+V / Ctrl+M 走不通时，读系统剪贴板的兜底 */
  | { type: 'clipboard/read' }
  /** 页面里拦下 Ctrl+V / Ctrl+M 之后，用插件自己的写入链路把剪贴板内容塞进作答区 */
  | { type: 'code/paste'; requestId: string; text: string };

export function isContentRequest(message: unknown): message is ContentRequest {
  return (
    isRecord(message) &&
    (message.type === 'chat/start' ||
      message.type === 'chat/stop' ||
      message.type === 'chat/attach' ||
      message.type === 'chat/ask-answer' ||
      message.type === 'editor/assist/install' ||
      message.type === 'editor/check' ||
      message.type === 'settings/get' ||
      message.type === 'settings/save' ||
      message.type === 'tool/test-input' ||
      message.type === 'models/list' ||
      message.type === 'ui/open-url' ||
      message.type === 'ui/open-diff' ||
      message.type === 'ui/open-explain' ||
      message.type === 'clipboard/read' ||
      message.type === 'code/paste')
  );
}

export function isRunToolRequest(message: unknown): message is RunToolRequest {
  return isRecord(message) && message.type === 'tool/run';
}

/* ---------- responses ---------- */

export interface StartChatResponse {
  ok: boolean;
  message?: string;
}

/** chat/attach 的回答：这个标签页上正在跑的那一轮 */
export interface AttachChatResponse {
  ok: boolean;
  /** 正在跑的 requestId；没有在跑的就是空串 */
  requestId?: string;
}

export interface TestInputResponse {
  ok: boolean;
  result: string;
  /** 这次用的是哪种方法（便于设置页显示进度） */
  method?: string;
}

export interface ToolRunResponse {
  ok: boolean;
  result: string;
}

/** 后台读系统剪贴板的结果（content script 自己读不到时的兜底） */
export interface ClipboardReadResponse {
  ok: boolean;
  text: string;
  message?: string;
}

/** 模型下拉框的结果：模型 id 列表或一句人话（为什么没列出来） */
export interface ModelsListResponse {
  ok: boolean;
  models: string[];
  message?: string;
}

export type SettingsResponse = SettingsView;

/** 编辑器增强的安装结果：token 是页面脚本与隔离世界之间的暗号，空串表示没装上 */
export interface EditorAssistInstallResponse {
  ok: boolean;
  token: string;
  message: string;
  world?: 'MAIN' | 'ISOLATED';
}

/** 作答区实时检查的结果：diagnostics 的 from/to 是字符下标，页面直接拿来画波浪线 */
export interface EditorCheckResponse {
  ok: boolean;
  note: string;
  diagnostics: DiagnosticBox[];
  errorCount: number;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
