import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../shared/types';

interface MessageListProps {
  messages: ChatMessage[];
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '我',
  assistant: '助手',
  system: '提示',
};

export function MessageList({ messages }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="messages" ref={scrollRef}>
      {messages.map((message) => (
        <div
          key={message.id}
          className={`bubble bubble--${message.role}${message.error ? ' bubble--error' : ''}`}
        >
          <div className="bubble__role">{ROLE_LABEL[message.role]}</div>
          <div className="bubble__content">
            {message.content}
            {message.streaming && <span className="bubble__cursor" />}
          </div>
        </div>
      ))}
    </div>
  );
}
