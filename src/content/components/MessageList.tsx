import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import type { ChatMessage } from '../../shared/types';

interface MessageListProps {
  messages: ChatMessage[];
  /** ask 工具的卡片上用户点了某个选项 */
  onAnswer?: (callId: string, choice: string) => void;
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '我',
  assistant: '助手',
  system: '提示',
  tool: '工具',
};

/** 离底部这么近就算「还在底部」，继续自动跟随 */
const STICK_THRESHOLD = 40;

export function MessageList({ messages, onAnswer }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    // 用户往上翻着看的时候不要把他拽回底部
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  return (
    <div className="messages-wrap">
      <div className="messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.map((message) => {
          if (message.role === 'tool') {
            return <ToolCard key={message.id} message={message} onAnswer={onAnswer} />;
          }

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

      {!atBottom && (
        <button type="button" className="messages__jump" onClick={jumpToBottom}>
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}
