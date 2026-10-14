import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';
import { isChatEvent, type ChatTurn, type StartChatResponse } from '../../shared/messages';
import { createId, type ChatMessage } from '../../shared/types';

const WELCOME = '你好，我是 PTA 助手。点击浏览器工具栏的插件图标可以开关这个悬浮窗。';

export interface ChatNotice {
  text: string;
  needsApiKey: boolean;
}

export function useChat(hasApiKey: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    { id: 'welcome', role: 'system', content: WELCOME, createdAt: 0 },
  ]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  // 当前在生成中的请求与对应的助手气泡
  const active = useRef<{ requestId: string; messageId: string } | null>(null);

  const appendDelta = useCallback((messageId: string, text: string) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? { ...message, content: message.content + text } : message,
      ),
    );
  }, []);

  const finish = useCallback((messageId: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId ? { ...message, streaming: false, ...patch } : message,
      ),
    );
  }, []);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isChatEvent(message)) return;
      const current = active.current;
      if (!current || current.requestId !== message.requestId) return;

      if (message.type === 'chat/delta') {
        appendDelta(current.messageId, message.text);
        return;
      }

      active.current = null;
      setStreaming(false);

      if (message.type === 'chat/error') {
        finish(current.messageId, { error: true, content: message.message });
        return;
      }
      // chat/done：被停止且一个字都没生成时给个提示，否则保留已生成的内容
      finish(current.messageId, {});
      if (message.aborted) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === current.messageId && m.content === '' ? { ...m, content: '（已停止生成）' } : m,
          ),
        );
      }
    };

    ext.runtime.onMessage.addListener(listener);
    return () => ext.runtime.onMessage.removeListener(listener);
  }, [appendDelta, finish]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming) return;

      const userMessage: ChatMessage = {
        id: createId(),
        role: 'user',
        content,
        createdAt: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
        streaming: true,
      };
      const turns = buildTurns(messages, content);

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setNotice(null);
      setStreaming(true);
      const requestId = createId();
      active.current = { requestId, messageId: assistantMessage.id };

      let response: StartChatResponse | undefined;
      try {
        response = (await ext.runtime.sendMessage({
          type: 'chat/start',
          requestId,
          turns,
        })) as StartChatResponse;
      } catch {
        response = { ok: false, message: '插件后台没有响应，请在扩展管理页重新加载插件' };
      }

      if (!response?.ok) {
        active.current = null;
        setStreaming(false);
        setMessages((prev) => prev.filter((message) => message.id !== assistantMessage.id));
        setNotice({
          text: response?.message ?? '请求失败',
          needsApiKey: !hasApiKey,
        });
      }
    },
    [hasApiKey, messages, streaming],
  );

  const stop = useCallback(() => {
    const current = active.current;
    if (!current) return;
    void ext.runtime.sendMessage({ type: 'chat/stop', requestId: current.requestId });
  }, []);

  return {
    messages,
    streaming,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    send,
    stop,
  };
}

/** 面板里可见的对话就是模型看到的上下文（系统提示与报错气泡不发给模型） */
function buildTurns(messages: ChatMessage[], input: string): ChatTurn[] {
  const history = messages
    .filter((message) => message.role !== 'system' && !message.error && message.content.trim())
    .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
  return [...history, { role: 'user', content: input }];
}
