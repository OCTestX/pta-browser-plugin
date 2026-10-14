import type { Settings, SettingsView } from './settings';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/* ---------- background -> content ---------- */

export interface TogglePanelMessage {
  type: 'toggle-panel';
}

export type BackgroundEvent =
  | TogglePanelMessage
  | { type: 'chat/delta'; requestId: string; text: string }
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
    (message.type === 'chat/delta' || message.type === 'chat/done' || message.type === 'chat/error')
  );
}

/* ---------- content -> background ---------- */

export type ContentRequest =
  | { type: 'chat/start'; requestId: string; turns: ChatTurn[] }
  | { type: 'chat/stop'; requestId: string }
  | { type: 'settings/get' }
  | { type: 'settings/save'; patch: Partial<Settings> };

export function isContentRequest(message: unknown): message is ContentRequest {
  return (
    isRecord(message) &&
    (message.type === 'chat/start' ||
      message.type === 'chat/stop' ||
      message.type === 'settings/get' ||
      message.type === 'settings/save')
  );
}

/* ---------- responses ---------- */

export interface StartChatResponse {
  ok: boolean;
  message?: string;
}

export type SettingsResponse = SettingsView;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
