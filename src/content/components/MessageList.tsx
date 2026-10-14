import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../shared/types';

interface MessageListProps {
  messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="messages" ref={scrollRef}>
      {messages.map((message) => (
        <div key={message.id} className={`bubble bubble--${message.role}`}>
          <div className="bubble__role">
            {message.role === 'user' ? '我' : message.role === 'assistant' ? '助手' : '提示'}
          </div>
          <div className="bubble__content">{message.content}</div>
        </div>
      ))}
    </div>
  );
}
