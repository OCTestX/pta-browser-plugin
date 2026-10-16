import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { SettingsPanel } from './components/SettingsPanel';
import { useChat } from './hooks/useChat';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useSettings } from './hooks/useSettings';
import {
  isPanelOpen,
  layoutResetCount,
  setPanelOpen,
  subscribeLayoutReset,
  subscribePanel,
} from './panelStore';

type View = 'chat' | 'settings';

export function App() {
  const open = useSyncExternalStore(subscribePanel, isPanelOpen, isPanelOpen);
  const layoutReset = useSyncExternalStore(subscribeLayoutReset, layoutResetCount, layoutResetCount);
  const [view, setView] = useState<View>('chat');
  const [draft, setDraft] = useState('');
  const settings = useSettings();
  const chat = useChat(settings.hasApiKey);
  const panelRef = useRef<HTMLDivElement>(null);
  const panel = usePanelLayout(panelRef);

  // 双击插件图标 = 把位置与大小恢复默认（面板关着的时候也要生效，所以放在 store 上）
  useEffect(() => {
    if (layoutReset > 0) panel.reset();
  }, [layoutReset, panel.reset]);

  if (!open) return null;

  const send = () => {
    void chat.send(draft);
    setDraft('');
  };

  // 「输入」按钮：整段写进作答区，写成功才清空输入框，失败时文本留着好重试
  const inputToEditor = async () => {
    if (await chat.inputCode(draft)) setDraft('');
  };

  // 顶栏 token：接口回传的精确值 + 正在流式输出的实时估算
  const tokenText = formatTokenUsage(chat.usage, chat.liveOutputTokens);

  return (
    <div
      className="panel"
      ref={panelRef}
      style={
        panel.layout
          ? {
              left: panel.layout.x,
              top: panel.layout.y,
              right: 'auto',
              bottom: 'auto',
              width: panel.layout.width,
              height: panel.layout.height,
            }
          : undefined
      }
    >
      <header
        className="panel__header"
        onPointerDown={panel.startDrag}
        onDoubleClick={panel.reset}
        title="拖动可以移动面板，拉右下角可以改大小，双击这里（或双击插件图标）恢复默认"
      >
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
            <span className="panel__badge">v1.0</span>
            <span className="panel__usage" title="本轮对话累计消耗的 token（接口回传精确值，流式过程中按字数实时估算）">
              {tokenText}
            </span>
          </>
        )}
        <div className="panel__actions">
          {view === 'chat' && (
            <>
              <button
                type="button"
                className="panel__new-chat"
                title="新会话：清空当前对话上下文，做下一题不用刷新页面"
                onClick={chat.reset}
              >
                新会话
              </button>
              <button
                type="button"
                className="panel__close"
                title="设置"
                onClick={() => setView('settings')}
              >
                ⚙
              </button>
            </>
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
          {/* 干活时（生成 / 等用户回答 / 写作答区）顶上有一条来回跑的进度条 */}
          {(chat.busy || chat.writing) && (
            <div className="panel__progress" role="progressbar" aria-label="正在工作" />
          )}
          <MessageList messages={chat.messages} onAnswer={chat.answerAsk} />
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
            onInput={() => void inputToEditor()}
            streaming={chat.streaming}
            writing={chat.writing}
          />
        </>
      )}

      <div
        className="panel__resize"
        title="拖动可以改面板大小"
        onPointerDown={panel.startResize}
      />
    </div>
  );
}

/**
 * 顶栏的 token 文案。
 * 接口回传 usage 时显示精确值（每轮请求结束更新一次）；
 * 有些兼容接口不回传，就退化成按字数实时估算当前这一轮的输出。
 */
function formatTokenUsage(
  usage: { promptTokens: number; completionTokens: number } | null,
  liveOutput: number,
): string {
  if (usage) return `Token ${usage.promptTokens + usage.completionTokens}（输入 ${usage.promptTokens} / 输出 ${usage.completionTokens}）`;
  return liveOutput > 0 ? `Token ≈ ${liveOutput}` : '';
}
