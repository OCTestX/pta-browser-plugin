import { useCallback, useEffect, useState } from 'react';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { ext } from '../shared/browser';
import { isTogglePanelMessage } from '../shared/messages';
import type { ChatMessage } from '../shared/types';

const PLACEHOLDER_REPLY = '收到。AI 能力将在 v0.2 接入，当前版本只做界面演示。';

let seq = 0;
function createId(): string {
  seq += 1;
  return `${Date.now()}-${seq}`;
}

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: createId(), role, content, createdAt: Date.now() };
}

export function App() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    createMessage('system', '点击浏览器工具栏的插件图标可以打开 / 关闭这个悬浮窗。'),
  ]);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (isTogglePanelMessage(message)) setOpen((prev) => !prev);
    };
    ext.runtime.onMessage.addListener(listener);
    return () => ext.runtime.onMessage.removeListener(listener);
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      createMessage('user', text),
      createMessage('assistant', PLACEHOLDER_REPLY),
    ]);
    setDraft('');
  }, [draft]);

  if (!open) return null;

  return (
    <div className="panel">
      <header className="panel__header">
        <span className="panel__title">PTA 助手</span>
        <span className="panel__badge">v0.1</span>
        <button type="button" className="panel__close" onClick={() => setOpen(false)} title="关闭">
          ×
        </button>
      </header>
      <MessageList messages={messages} />
      <Composer value={draft} onChange={setDraft} onSend={send} />
    </div>
  );
}
