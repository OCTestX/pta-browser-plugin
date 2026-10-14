import { useEffect, useRef } from 'react';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import type { ChatMessage } from '../../shared/types';

interface MessageListProps {
  messages: ChatMessage[];
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '我',
  assistant: '助手',
  system: '提示',
  tool: '工具',
};

export function MessageList({ messages }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="messages" ref={scrollRef}>
      {messages.map((message) => {
        if (message.role === 'tool') return <ToolCard key={message.id} message={message} />;

        // 只承载 tool_calls、没有文字的气泡不用画出来
        if (message.role === 'assistant' && !message.content.trim() && !message.streaming) {
          return null;
        }

        // 只有助手的回答渲染 markdown：用户输入和报错提示保持原样，避免踩到语法
        const asMarkdown = message.role === 'assistant' && !message.error;
        return (
          <div
            key={message.id}
            className={`bubble bubble--${message.role}${message.error ? ' bubble--error' : ''}`}
          >
            <div className="bubble__role">{ROLE_LABEL[message.role]}</div>
            <div className={`bubble__content${asMarkdown ? ' bubble__content--md' : ''}`}>
              {asMarkdown ? (
                <Markdown content={message.content} streaming={message.streaming} />
              ) : (
                message.content
              )}
              {message.streaming && <span className="bubble__cursor" />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
