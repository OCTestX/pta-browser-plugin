import { useEffect, useState, useSyncExternalStore } from 'react';
import { ext } from '../shared/browser';
import { Composer } from '../content/components/Composer';
import { MessageList } from '../content/components/MessageList';
import { SettingsPanel } from '../content/components/SettingsPanel';
import { useChat } from '../content/hooks/useChat';
import { useSettings } from '../content/hooks/useSettings';
import {
  getDraft,
  isPanelOpen,
  setDraft,
  setPanelOpen,
  subscribeDraft,
  subscribePanel,
} from '../content/panelStore';

type View = 'chat' | 'settings';

const VERSION_LABEL = `v${ext.runtime.getManifest().version.split('.').slice(0, 2).join('.')}`;

export function FullPageApp() {
  const settings = useSettings();
  const chat = useChat(settings.hasApiKey);
  const open = useSyncExternalStore(subscribePanel, isPanelOpen, isPanelOpen);
  const draft = useSyncExternalStore(subscribeDraft, getDraft, getDraft);
  const [view, setView] = useState<View>('chat');

  // 全页面模式下，确保面板处于打开状态
  useEffect(() => {
    void setPanelOpen(true);
  }, []);

  if (!open) return null;

  const send = () => {
    void chat.send(draft);
    setDraft('');
  };

  const inputToEditor = async () => {
    if (await chat.inputCode(draft)) setDraft('');
  };

  const tokenText = formatTokenUsage(chat.usage, chat.liveOutputTokens);

  return (
    <div className="pta-fullpage">
      <header className="pta-header">
        {view === 'settings' ? (
          <>
            <button type="button" className="pta-back-btn" onClick={() => setView('chat')}>
              ‹
            </button>
            <span className="pta-title">设置</span>
          </>
        ) : (
          <>
            <span className="pta-title">PTA 助手</span>
            <span className="pta-badge">{VERSION_LABEL}</span>
            <span className="pta-usage" title="本轮对话累计消耗的 token（接口回传精确值，流式过程中按字数实时估算）">
              {tokenText}
            </span>
          </>
        )}
        <div className="pta-actions">
          {view === 'chat' && (
            <>
              <button
                type="button"
                className="pta-new-chat-btn"
                title="新会话：清空当前对话上下文"
                onClick={chat.reset}
              >
                新会话
              </button>
              <button
                type="button"
                className="pta-close-btn"
                title="设置"
                onClick={() => setView('settings')}
              >
                ⚙
              </button>
            </>
          )}
          <button
            type="button"
            className="pta-close-btn"
            title="关闭（最小化到悬浮窗）"
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
          {(chat.busy || chat.writing) && (
            <div className="pta-progress" role="progressbar" aria-label="正在工作" />
          )}
          <MessageList messages={chat.messages} onAnswer={chat.answerAsk} />
          {chat.notice && (
            <div className="pta-notice">
              <span className="pta-notice__text">{chat.notice.text}</span>
              {chat.notice.needsApiKey && (
                <button
                  type="button"
                  className="pta-notice__action"
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
            onInput={() => void inputToEditor()}
            streaming={chat.streaming}
            writing={chat.writing}
          />
        </>
      )}
    </div>
  );
}

function formatTokenUsage(
  usage: { promptTokens: number; completionTokens: number } | null,
  liveOutput: number,
): string {
  if (usage) return `Token ${usage.promptTokens + usage.completionTokens}（输入 ${usage.promptTokens} / 输出 ${usage.completionTokens}）`;
  return liveOutput > 0 ? `Token ≈ ${liveOutput}` : '';
}
