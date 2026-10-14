import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';
import { isChatEvent, type StartChatResponse } from '../../shared/messages';
import { createId, toApiMessages, type ChatMessage, type ToolCall } from '../../shared/types';

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
  const requestRef = useRef<string | null>(null);
  // 当前正在写的 assistant 气泡；为 null 表示下一段文字要新起一个气泡
  const assistantRef = useRef<string | null>(null);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isChatEvent(message)) return;
      if (message.requestId !== requestRef.current) return;

      switch (message.type) {
        case 'chat/delta':
          appendDelta(message.text);
          return;
        case 'chat/tool-start':
          startTool(message.callId, message.name, message.args);
          return;
        case 'chat/tool-end':
          endTool(message.callId, message.result, message.isError);
          return;
        case 'chat/notice':
          appendSystem(message.text);
          return;
        case 'chat/error':
          if (assistantRef.current) {
            patchMessage(assistantRef.current, { error: true, content: message.message, streaming: false });
          } else {
            appendSystem(message.message, true);
          }
          finish();
          return;
        case 'chat/done':
          finish();
          return;
      }
    };

    ext.runtime.onMessage.addListener(listener);
    return () => ext.runtime.onMessage.removeListener(listener);
  }, []);

  const patchMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === id ? { ...message, ...patch } : message)),
    );
  }, []);

  const appendDelta = useCallback((text: string) => {
    setMessages((prev) => {
      const currentId = assistantRef.current;
      if (currentId) {
        return prev.map((message) =>
          message.id === currentId
            ? { ...message, content: message.content + text, streaming: true }
            : message,
        );
      }
      // 上一轮工具调用之后模型又开始说话，新起一个气泡，
      // 这样「assistant(tool_calls) + tool 结果 + assistant(最终回答)」的结构才是对的
      const created: ChatMessage = {
        id: createId(),
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        streaming: true,
      };
      assistantRef.current = created.id;
      return [...prev, created];
    });
  }, []);

  const startTool = useCallback((callId: string, name: string, rawArgs: string) => {
    setMessages((prev) => {
      const call: ToolCall = {
        id: callId,
        type: 'function',
        function: { name, arguments: rawArgs },
      };
      const next = [...prev];
      const currentIndex = assistantRef.current
        ? next.findIndex((message) => message.id === assistantRef.current)
        : -1;

      if (currentIndex >= 0) {
        const current = next[currentIndex];
        next[currentIndex] = {
          ...current,
          streaming: false,
          toolCalls: [...(current.toolCalls ?? []), call],
        };
      } else {
        // 模型直接调工具、什么都没说：也要留一条 assistant 记录承载 tool_calls
        next.push({
          id: createId(),
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          toolCalls: [call],
        });
      }

      const { code, summary } = summarizeArgs(name, rawArgs);
      next.push({
        id: createId(),
        role: 'tool',
        content: '',
        createdAt: Date.now(),
        toolName: name,
        toolArgs: summary,
        toolCode: code,
        toolCallId: callId,
        toolStatus: 'running',
      });

      // 之后的文字另起气泡
      assistantRef.current = null;
      return next;
    });
  }, []);

  const endTool = useCallback((callId: string, result: string, isError: boolean) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.role === 'tool' && message.toolCallId === callId
          ? { ...message, content: result, toolStatus: isError ? 'error' : 'ok' }
          : message,
      ),
    );
  }, []);

  const appendSystem = useCallback((text: string, error = false) => {
    setMessages((prev) => [
      ...prev,
      { id: createId(), role: 'system', content: text, createdAt: Date.now(), error },
    ]);
  }, []);

  const finish = useCallback(() => {
    const currentId = assistantRef.current;
    if (currentId) {
      setMessages((prev) =>
        prev.map((message) =>
          message.id === currentId ? { ...message, streaming: false } : message,
        ),
      );
    }
    assistantRef.current = null;
    requestRef.current = null;
    setStreaming(false);
  }, []);

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
      // 用面板里的会话重建上下文，工具卡片会变成 tool 消息，工具调用记录挂在 assistant 上
      const apiMessages = toApiMessages(messages, content);

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setNotice(null);
      setStreaming(true);
      const requestId = createId();
      requestRef.current = requestId;
      assistantRef.current = assistantMessage.id;

      let response: StartChatResponse | undefined;
      try {
        response = (await ext.runtime.sendMessage({
          type: 'chat/start',
          requestId,
          messages: apiMessages,
        })) as StartChatResponse;
      } catch {
        response = { ok: false, message: '插件后台没有响应，请在扩展管理页重新加载插件' };
      }

      if (!response?.ok) {
        requestRef.current = null;
        assistantRef.current = null;
        setStreaming(false);
        setMessages((prev) => prev.filter((message) => message.id !== assistantMessage.id));
        setNotice({ text: response?.message ?? '请求失败', needsApiKey: !hasApiKey });
      }
    },
    [hasApiKey, messages, streaming],
  );

  const stop = useCallback(() => {
    const requestId = requestRef.current;
    if (!requestId) return;
    void ext.runtime.sendMessage({ type: 'chat/stop', requestId });
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

/** 工具卡片上要显示什么：js_inject 把代码完整放出来，write_document 只给个摘要 */
function summarizeArgs(name: string, rawArgs: string): { code?: string; summary?: string } {
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(rawArgs);
    if (typeof value === 'object' && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    return { summary: rawArgs };
  }

  if (name === 'js_inject' && typeof parsed.code === 'string') return { code: parsed.code };
  if (name === 'write_document') {
    const filename = typeof parsed.filename === 'string' ? parsed.filename : '未命名';
    const length = typeof parsed.content === 'string' ? parsed.content.length : 0;
    return { summary: `${filename}（${length} 字符）` };
  }
  const summary = rawArgs.trim();
  return { summary: summary === '{}' || summary === '' ? undefined : summary };
}
