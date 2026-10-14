export interface TogglePanelMessage {
  type: 'toggle-panel';
}

export type ExtMessage = TogglePanelMessage;

export function isTogglePanelMessage(message: unknown): message is TogglePanelMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'toggle-panel'
  );
}
