import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';
import type { ChatMessage } from '../../shared/types';

interface MessageListProps {
  messages: ChatMessage[];
  /** ask 工具的卡片上用户点了某个选项 */
  onAnswer?: (callId: string, choice: string) => void;
  /** diff 卡片「全屏查看」：让 background 开新标签页显示完整 diff */
  onFullscreenDiff?: (diff: { left: string; right: string; leftLabel: string; rightLabel: string }) => void;
  /** 发一条指定内容（空状态里的快捷按钮用它直接发指令） */
  onSendText?: (text: string) => void;
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  user: '我',
  assistant: '助手',
  system: '提示',
  tool: '工具',
};

/** 离底部这么近就算「还在底部」，继续自动跟随 */
const STICK_THRESHOLD = 40;

export function MessageList({ messages, onAnswer, onFullscreenDiff, onSendText }: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // 滚动事件一秒能来几十次：状态只在「离开底部 / 回到底部」那一下变，
  // 不能每个事件都 setState，否则内容一多整个面板都在重渲染
  const atBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    // 用户往上翻着看的时候不要把他拽回底部
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [messages, atBottom]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    if (next === atBottomRef.current) return;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    if (!atBottomRef.current) {
      atBottomRef.current = true;
      setAtBottom(true);
    }
  }, []);

  return (
    <div className="messages-wrap">
      <div className="messages" ref={scrollRef} onScroll={handleScroll}>
        {messages.map((message) => {
          if (message.role === 'tool') {
            return (
              <ToolCard
                key={message.id}
                message={message}
                onAnswer={onAnswer}
                onFullscreenDiff={onFullscreenDiff}
              />
            );
          }
          return <Bubble key={message.id} message={message} />;
        })}
        {/* 空状态：把常用的几个入口摆出来，用户点一下就能开始，不用记指令 */}
        {messages.length === 1 && messages[0].id === 'welcome' && (
          <WelcomeCard onSendText={onSendText} />
        )}
      </div>

      {!atBottom && (
        <button type="button" className="messages__jump" onClick={jumpToBottom}>
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}

/** 空状态里的快捷入口：点一下直接发对应的斜杠指令 */
const QUICK_ACTIONS: { command: string; label: string; hint: string }[] = [
  { command: '/resolve', label: '解决当前题目', hint: '读题、写代码、跑样例、提交' },
  { command: '/fuck', label: '赶完整个题单', hint: '不问不解释，直接提交刷题' },
  { command: '/why', label: '讲解当前代码', hint: '只讲错在哪，不改代码' },
  { command: '/what', label: '生成讲解页', hint: '苏格拉底式问答，可交互网页' },
];

function WelcomeCard({ onSendText }: { onSendText?: (text: string) => void }) {
  if (!onSendText) return null;
  return (
    <div className="welcome">
      <p className="welcome__text">
        点下面的按钮直接开始，或者在输入框里用 <code>/</code> 列出全部指令。
      </p>
      <div className="welcome__actions">
        {QUICK_ACTIONS.map((action) => (
          <button
            type="button"
            className="welcome__action"
            key={action.command}
            onClick={() => onSendText(action.command)}
            title={action.hint}
          >
            <span className="welcome__action-label">{action.label}</span>
            <span className="welcome__action-hint">{action.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 单条气泡。memo 很重要：流式输出时只有最后那条消息的引用会变，
 * 前面几百条历史消息不应该跟着重渲染（Markdown / KaTeX 重排是卡顿的大头）。
 */
const Bubble = memo(function Bubble({ message }: { message: ChatMessage }) {
  // 只承载 tool_calls、没有文字的气泡不用画出来
  if (message.role === 'assistant' && !message.content.trim() && !message.streaming) return null;

  // 只有助手的回答渲染 markdown：用户输入和报错提示保持原样，避免踩到语法
  const asMarkdown = message.role === 'assistant' && !message.error;
  return (
    <div className={`bubble bubble--${message.role}${message.error ? ' bubble--error' : ''}`}>
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
});
