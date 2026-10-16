import { useState } from 'react';
import type { ChatMessage } from '../../shared/types';
import { DiffView } from './DiffView';

const STATUS_LABEL: Record<NonNullable<ChatMessage['toolStatus']>, string> = {
  running: '执行中',
  ok: '完成',
  error: '失败',
};

interface ToolCardProps {
  message: ChatMessage;
  onAnswer?: (callId: string, choice: string) => void;
}

export function ToolCard({ message, onAnswer }: ToolCardProps) {
  const status = message.toolStatus ?? 'running';
  const [copied, setCopied] = useState<string | null>(null);

  // ask 要能选、diff 要看得见，这两种卡片默认展开；其它工具默认收起，少占高度
  const [expanded, setExpanded] = useState(false);
  const mustOpen = Boolean(message.toolQuestion) || Boolean(message.toolDiff);
  const open = mustOpen || expanded;

  const copy = (text: string, label: string) => {
    copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };

  const callId = message.toolCallId;

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
}

/** 内容脚本里没有 clipboard 权限，用 execCommand 复制（用户点击触发，够用） */
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
