import { useState, useSyncExternalStore } from 'react';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { SettingsPanel } from './components/SettingsPanel';
import { useChat } from './hooks/useChat';
import { useSettings } from './hooks/useSettings';
import { isPanelOpen, setPanelOpen, subscribePanel } from './panelStore';

type View = 'chat' | 'settings';

export function App() {
  const open = useSyncExternalStore(subscribePanel, isPanelOpen, isPanelOpen);
  const [view, setView] = useState<View>('chat');
  const [draft, setDraft] = useState('');
  const settings = useSettings();
  const chat = useChat(settings.hasApiKey);

  if (!open) return null;

  const send = () => {
    void chat.send(draft);
    setDraft('');
  };

  return (
    <div className="panel">
      <header className="panel__header">
        {view === 'settings' ? (
          <>
            <button type="button" className="panel__back" onClick={() => setView('chat')}>
              ‹
            </button>
            <span className="panel__title">设置</span>
          </>
        ) : (
          <>
            <span className="panel__title">PTA 助手</span>
            <span className="panel__badge">v0.5</span>
          </>
        )}
        <div className="panel__actions">
          {view === 'chat' && (
            <button
              type="button"
              className="panel__close"
              title="设置"
              onClick={() => setView('settings')}
            >
              ⚙
            </button>
          )}
          <button
            type="button"
            className="panel__close"
            title="关闭"
            onClick={() => setPanelOpen(false)}
          >
            ×
          </button>
        </div>
      </header>

      {view === 'settings' ? (
        <SettingsPanel view={settings.view} onSave={settings.save} onBack={() => setView('chat')} />
      ) : (
        <>
          <MessageList messages={chat.messages} />
          {chat.notice && (
            <div className="notice">
              <span className="notice__text">{chat.notice.text}</span>
              {chat.notice.needsApiKey && (
                <button
                  type="button"
                  className="notice__action"
                  onClick={() => {
                    chat.dismissNotice();
                    setView('settings');
                  }}
                >
                  去设置
                </button>
              )}
            </div>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={chat.stop}
            streaming={chat.streaming}
          />
        </>
      )}
    </div>
  );
}
