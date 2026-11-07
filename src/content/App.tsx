import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ext } from '../shared/browser';
import { contextWindowFor } from '../shared/settings';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { SettingsPanel } from './components/SettingsPanel';
import { useChat } from './hooks/useChat';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useSettings } from './hooks/useSettings';
import {
  composerFocusRequest,
  getDraft,
  isPanelOpen,
  layoutResetCount,
  setDraft,
  setPanelOpen,
  subscribeComposerFocus,
  subscribeDraft,
  subscribeLayoutReset,
  subscribePanel,
} from './panelStore';

type View = 'chat' | 'settings';

// 标题栏徽标：跟清单版本同源（2.0.0 → v2.0），发版时改 manifest 就够，不用再改这里
const VERSION_LABEL = `v${ext.runtime.getManifest().version.split('.').slice(0, 2).join('.')}`;

export function App() {
  const open = useSyncExternalStore(subscribePanel, isPanelOpen, isPanelOpen);
  const layoutReset = useSyncExternalStore(subscribeLayoutReset, layoutResetCount, layoutResetCount);
  const draft = useSyncExternalStore(subscribeDraft, getDraft, getDraft);
  // Alt+G 的聚焦请求：面板打开后由 Composer 消费
  const focusSignal = useSyncExternalStore(subscribeComposerFocus, composerFocusRequest, composerFocusRequest);
  const [view, setView] = useState<View>('chat');
  const settings = useSettings();
  const chat = useChat(settings.hasApiKey);
  const panelRef = useRef<HTMLDivElement>(null);
  const panel = usePanelLayout(panelRef);

  // 双击插件图标 = 把位置与大小恢复默认（面板关着的时候也要生效，所以放在 store 上）
  useEffect(() => {
    if (layoutReset > 0) panel.reset();
  }, [layoutReset, panel.reset]);

  // diff 卡片的「全屏查看」：content script 没有 chrome.tabs，让后台存一份并开标签页
  const openDiffFullscreen = useCallback(
    async (diff: { left: string; right: string; leftLabel: string; rightLabel: string }) => {
      try {
        await ext.runtime.sendMessage({ type: 'ui/open-diff', diff });
      } catch (error) {
        console.error('[PTA 助手] 打开全屏 diff 失败:', error);
      }
    },
    [],
  );

  if (!open) return null;

  const send = () => {
    void chat.send(draft);
    setDraft('');
  };

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
            <span className="panel__badge">{VERSION_LABEL}</span>
            <ContextRing usage={chat.usage} liveTokens={chat.liveOutputTokens} model={settings.view?.model ?? ''} />
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
          {chat.busy && (
            <div className="panel__progress" role="progressbar" aria-label="正在工作" />
          )}
          <MessageList
            messages={chat.messages}
            onAnswer={chat.answerAsk}
            onFullscreenDiff={openDiffFullscreen}
          />
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
            focusSignal={focusSignal}
            onReset={chat.reset}
            onSendText={(text) => {
              setDraft('');
              void chat.send(text);
            }}
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

/** token 数化简成 K（保留两位小数）：12710 → 12.71K */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(2)}K`;
}

/**
 * 顶栏的小圆环：上下文填充进度。
 *
 * 输入的 token 数就是这一轮请求带进去的上下文大小，除以模型的上下文窗口就是填充比例。
 * token 明细不直接摊在顶栏，鼠标停在圆环上才看得到（title）。
 */
function ContextRing({
  usage,
  liveTokens,
  model,
}: {
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  liveTokens: number;
  model: string;
}) {
  const contextWindow = contextWindowFor(model);
  const used = usage ? usage.promptTokens : 0;
  const ratio = Math.min(1, used / contextWindow);
  const percent = Math.round(ratio * 100);
  const total = usage ? usage.promptTokens + usage.completionTokens : liveTokens;
  const title = usage
    ? `上下文已用 ${percent}%（按 ${formatTokens(contextWindow)} 窗口估算）\n本轮累计 ${formatTokens(total)} token（输入 ${formatTokens(usage.promptTokens)} / 输出 ${formatTokens(usage.completionTokens)}）`
    : '还没有接口回传的用量数据';

  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="panel__ctx" title={title}>
      <svg
        className="panel__ring"
        viewBox="0 0 20 20"
        width="18"
        height="18"
        role="img"
        aria-label={`上下文已用 ${percent}%`}
      >
        <circle className="panel__ring-bg" cx="10" cy="10" r={radius} />
        <circle
          className="panel__ring-fg"
          cx="10"
          cy="10"
          r={radius}
          strokeDasharray={`${(circumference * ratio).toFixed(2)} ${circumference.toFixed(2)}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </span>
  );
}
