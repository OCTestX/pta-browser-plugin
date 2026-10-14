import { useState } from 'react';
import type { ChatMessage } from '../../shared/types';

const STATUS_LABEL: Record<NonNullable<ChatMessage['toolStatus']>, string> = {
  running: '执行中',
  ok: '完成',
  error: '失败',
};

export function ToolCard({ message }: { message: ChatMessage }) {
  const status = message.toolStatus ?? 'running';
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, label: string) => {
    copyText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };

  return (
    <div className={`tool tool--${status}`}>
      <div className="tool__header">
        <button
          type="button"
          className="tool__toggle"
          title={collapsed ? '展开' : '折叠'}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="tool__name">{message.toolName}</span>
        {message.toolArgs && <span className="tool__args">{message.toolArgs}</span>}
        <span className="tool__status">{STATUS_LABEL[status]}</span>
      </div>

      {!collapsed && (
        <>
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
