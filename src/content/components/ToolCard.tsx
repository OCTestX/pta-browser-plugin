import { memo, useState } from 'react';
import { ext } from '../../shared/browser';
import type { ChatMessage } from '../../shared/types';
import { DiffView } from './DiffView';

const STATUS_LABEL: Record<NonNullable<ChatMessage['toolStatus']>, string> = {
  running: '执行中',
  ok: '完成',
  error: '失败',
};

/**
 * 讲解页的邀请卡片：write_explanation_page 的结果里带 pageId 就在卡片上给个入口。
 * 卡片默认是收起的，所以这张邀请卡也要默认展开，不然用户看不到。
 */
function parseExplanationInvite(message: ChatMessage): { pageId: string; title: string } | null {
  if (message.toolName !== 'write_explanation_page') return null;
  if (!message.content.trim()) return null;
  try {
    const parsed = JSON.parse(message.content) as { pageId?: string; title?: string };
    if (!parsed.pageId) return null;
    return { pageId: parsed.pageId, title: parsed.title || '讲解页' };
  } catch {
    return null;
  }
}

/** 点「打开讲解页」：让后台开新标签页（content script 没有 chrome.tabs） */
async function openExplanationPage(pageId: string): Promise<void> {
  try {
    await ext.runtime.sendMessage({ type: 'ui/open-explain', pageId });
  } catch (error) {
    console.error('[PTA 助手] 打开讲解页失败:', error);
  }
}

interface ToolCardProps {
  message: ChatMessage;
  onAnswer?: (callId: string, choice: string) => void;
  /** diff 卡片右上角「全屏查看」：开新标签页显示完整 diff */
  onFullscreenDiff?: (diff: { left: string; right: string; leftLabel: string; rightLabel: string }) => void;
}

export const ToolCard = memo(function ToolCard({ message, onAnswer, onFullscreenDiff }: ToolCardProps) {
  const status = message.toolStatus ?? 'running';
  const [copied, setCopied] = useState<string | null>(null);

  // ask 要能选、diff 要看得见，这两种卡片默认展开；其它工具默认收起，少占高度
  const [expanded, setExpanded] = useState(false);
  const mustOpen = Boolean(message.toolQuestion) || Boolean(message.toolDiff) || message.toolName === 'write_explanation_page';
  const open = mustOpen || expanded;

  const copy = (text: string, label: string) => {
    copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };

  const callId = message.toolCallId;

  // 讲解页的邀请卡片：工具结果里带 pageId，就显示「打开讲解页」
  const invite = parseExplanationInvite(message);

  return (
    <div className={`tool tool--${status}`}>
      <div className="tool__header">
        <button
          type="button"
          className="tool__toggle"
          title={open ? '折叠' : '展开'}
          onClick={() => setExpanded(!open)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="tool__name">{message.toolName}</span>
        {message.toolArgs && <span className="tool__args">{message.toolArgs}</span>}
        <span className="tool__status">{STATUS_LABEL[status]}</span>
      </div>

      {open && (
        <>
          {invite && (
            <div className="invite">
              <div className="invite__text">
                讲解页已经生成好了：<b>{invite.title}</b>
                <span className="invite__hint">点右边在新标签页打开，可以边看边想</span>
              </div>
              <button
                type="button"
                className="invite__btn"
                onClick={() => void openExplanationPage(invite.pageId)}
              >
                打开讲解页
              </button>
            </div>
          )}
          {message.toolQuestion && callId && (
            <div className="ask">
              <div className="ask__question">{message.toolQuestion}</div>
              {message.toolChoice ? (
                <div className="ask__chosen">已选择：{message.toolChoice}</div>
              ) : (
                <div className="ask__options">
                  {(message.toolOptions ?? []).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="ask__option"
                      onClick={() => onAnswer?.(callId, option)}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {message.toolDiff && (
            <div className="tool__block">
              <DiffView
                {...message.toolDiff}
                onCopy={() => copy(message.toolDiff?.right ?? '', 'diff')}
                copied={copied === 'diff'}
                onFullscreen={
                  onFullscreenDiff && message.toolDiff
                    ? () => onFullscreenDiff(message.toolDiff!)
                    : undefined
                }
              />
            </div>
          )}

          {message.toolCode && (
            <div className="tool__block">
              <button type="button" className="tool__copy" onClick={() => copy(message.toolCode ?? '', 'code')}>
                {copied === 'code' ? '已复制' : '复制代码'}
              </button>
              <pre className="tool__code">{message.toolCode}</pre>
            </div>
          )}

          {message.content && (
            <div className="tool__block">
              <button
                type="button"
                className="tool__copy"
                onClick={() => copy(message.content, 'result')}
              >
                {copied === 'result' ? '已复制' : '复制结果'}
              </button>
              <pre className="tool__result">{message.content}</pre>
            </div>
          )}
        </>
      )}
    </div>
  );
});

/** 面板里没有 clipboard 权限，用 execCommand 复制（用户点击触发，够用） */
function copyText(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.documentElement.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // 复制失败就算了，用户可以自己选
  }
  area.remove();
}
