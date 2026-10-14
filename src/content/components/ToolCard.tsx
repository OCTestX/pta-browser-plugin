import type { ChatMessage } from '../../shared/types';

const STATUS_LABEL: Record<NonNullable<ChatMessage['toolStatus']>, string> = {
  running: '执行中',
  ok: '完成',
  error: '失败',
};

export function ToolCard({ message }: { message: ChatMessage }) {
  const status = message.toolStatus ?? 'running';

  return (
    <div className={`tool tool--${status}`}>
      <div className="tool__header">
        <span className="tool__name">{message.toolName}</span>
        {message.toolArgs && <span className="tool__args">{message.toolArgs}</span>}
        <span className="tool__status">{STATUS_LABEL[status]}</span>
      </div>
      {message.toolCode && <pre className="tool__code">{message.toolCode}</pre>}
      {message.content && <pre className="tool__result">{message.content}</pre>}
    </div>
  );
}
