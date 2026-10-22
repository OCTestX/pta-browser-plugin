import type { ApiMessage } from './types';
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
  /** 用户在 ask 工具的卡片上点了一个选项 */
  | { type: 'chat/ask-answer'; requestId: string; callId: string; choice: string }
  | { type: 'settings/get' }
  | { type: 'settings/save'; patch: Partial<Settings> }
  /** 设置页的「模拟输入测试」：按指定方法往作答区写一次文本 */
  | { type: 'tool/test-input'; text: string; method?: string }
  /** 输入框的「输入」按钮：把面板输入框里的文本写进作答区（PTA 禁粘贴时的快捷通道）；
   *  requestId 用来让同一个「停止」按钮也能打断这次写入 */
  | { type: 'code/input'; requestId: string; code: string }
  /** 问接口「你有哪些模型」：模型下拉框用。Key 只在 background 那边用，content 传过来的是草稿值 */
  | { type: 'models/list'; baseURL: string; apiKey?: string }
  /** 设置页的「一键跳转硅基流动」：让后台开一个新标签页 */
  | { type: 'ui/open-url'; url: string };

export function isContentRequest(message: unknown): message is ContentRequest {
  return (
    isRecord(message) &&
    (message.type === 'chat/start' ||
      message.type === 'chat/stop' ||
      message.type === 'chat/ask-answer' ||
      message.type === 'settings/get' ||
      message.type === 'settings/save' ||
      message.type === 'tool/test-input' ||
      message.type === 'code/input' ||
      message.type === 'models/list' ||
      message.type === 'ui/open-url')
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

/** 模型下拉框的结果：模型 id 列表或一句人话（为什么没列出来） */
export interface ModelsListResponse {
  ok: boolean;
  models: string[];
  message?: string;
}

export type SettingsResponse = SettingsView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
