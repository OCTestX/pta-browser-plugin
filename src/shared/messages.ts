import type { ApiMessage } from './types';
import type { Settings, SettingsView } from './settings';

/* ---------- background -> content ---------- */

export interface TogglePanelMessage {
  type: 'toggle-panel';
}

export type BackgroundEvent =
  | TogglePanelMessage
  | { type: 'chat/delta'; requestId: string; text: string }
  | { type: 'chat/tool-start'; requestId: string; callId: string; name: string; args: string }
  | { type: 'chat/tool-end'; requestId: string; callId: string; result: string; isError: boolean }
  | { type: 'chat/notice'; requestId: string; text: string }
  | { type: 'chat/done'; requestId: string; aborted: boolean }
  | { type: 'chat/error'; requestId: string; message: string };

export function isTogglePanelMessage(message: unknown): message is TogglePanelMessage {
  return isRecord(message) && message.type === 'toggle-panel';
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
  | { type: 'settings/get' }
  | { type: 'settings/save'; patch: Partial<Settings> }
  /** 设置页的「模拟输入测试」：用和工具完全相同的链路跑一次 simulate_keyboard_input */
  | { type: 'tool/test-input'; text: string };

export function isContentRequest(message: unknown): message is ContentRequest {
  return (
    isRecord(message) &&
    (message.type === 'chat/start' ||
      message.type === 'chat/stop' ||
      message.type === 'settings/get' ||
      message.type === 'settings/save' ||
      message.type === 'tool/test-input')
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
}

export interface ToolRunResponse {
  ok: boolean;
  result: string;
}

export type SettingsResponse = SettingsView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
