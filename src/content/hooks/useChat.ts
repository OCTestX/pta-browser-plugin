import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';
import {
  isChatEvent,
  type DiffPayload,
  type StartChatResponse,
  type TokenUsage,
  type ToolRunResponse,
} from '../../shared/messages';
import { createId, toApiMessages, type ChatMessage, type ToolCall } from '../../shared/types';
import { diffLines, diffStats } from '../../shared/diff';


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
  const [writing, setWriting] = useState(false);
  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const requestRef = useRef<string | null>(null);
  // 收尾时要知道「这一轮到底吐没吐字」，state 更新是异步的，所以留一份同镜像
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  const [usage, setUsage] = useState<TokenUsage | null>(null);
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
          endTool(message.callId, message.result, message.isError, message.diff);
          return;
        case 'chat/ask':
          showAsk(message.callId, message.question, message.options);
          return;
        case 'chat/usage':
          setUsage({
            promptTokens: message.promptTokens,
            completionTokens: message.completionTokens,
            totalTokens: message.totalTokens,
          });
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

  const endTool = useCallback(
    (callId: string, result: string, isError: boolean, diff?: DiffPayload) => {
      setMessages((prev) =>
        prev.map((message) =>
          message.role === 'tool' && message.toolCallId === callId
            ? { ...message, content: result, toolStatus: isError ? 'error' : 'ok', toolDiff: diff }
            : message,
        ),
      );
    },
    [],
  );

  /** ask 工具：把问题挂到对应的卡片上，等用户点选 */
  const showAsk = useCallback((callId: string, question: string, options: string[]) => {
    setMessages((prev) =>
      prev.map((message) =>
        message.role === 'tool' && message.toolCallId === callId
          ? { ...message, toolQuestion: question, toolOptions: options }
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
      // 模型这一轮一个字都没吐：空气泡不渲染，用户会以为卡死了，所以留个提示
      const produced = messagesRef.current
        .find((message) => message.id === currentId)?.content.trim();
      setMessages((prev) =>
        prev.map((message) =>
          message.id === currentId ? { ...message, streaming: false } : message,
        ),
      );
      if (!produced) {
        setNotice({
          text: '模型这一轮没有输出内容（可以再问一次，或点「新会话」重新开始）',
          needsApiKey: false,
        });
      }
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

  /**
   * 「输入」按钮：把输入框里的文本整段写进作答区（PTA 禁粘贴时的快捷通道）。
   * 走后台写入工具同一条链路，成功返回 true，调用方据此清空输入框。
   */
  const inputCode = useCallback(
    async (code: string): Promise<boolean> => {
      if (!code.trim() || writing || streaming) return false;

      setWriting(true);
      try {
        const response = (await ext.runtime.sendMessage({
          type: 'code/input',
          code,
        })) as ToolRunResponse | undefined;
        setNotice({
          text: response?.result ?? '插件后台没有响应，请在扩展管理页重新加载插件',
          needsApiKey: false,
        });
        return response?.ok === true;
      } catch {
        setNotice({ text: '插件后台没有响应，请在扩展管理页重新加载插件', needsApiKey: false });
        return false;
      } finally {
        setWriting(false);
      }
    },
    [streaming, writing],
  );

  /**
   * 用户在 ask 卡片上点了某个选项：把答案回给后台，卡片显示「已选择」。
   * 后台确认收到才算数——如果那一轮已经结束（超时、点了「新会话」），
   * 要把卡片恢复成可点并提示用户，否则用户会以为选上了却看不到模型继续输出。
   */
  const answerAsk = useCallback(async (callId: string, choice: string) => {
    const requestId = requestRef.current;
    if (!requestId) {
      setNotice({ text: '这一轮已经结束，这个选择没有送出去', needsApiKey: false });
      return;
    }
    const mark = (picked?: string) =>
      setMessages((prev) =>
        prev.map((message) =>
          message.role === 'tool' && message.toolCallId === callId
            ? { ...message, toolChoice: picked }
            : message,
        ),
      );

    mark(choice);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'chat/ask-answer',
        requestId,
        callId,
        choice,
      })) as StartChatResponse | undefined;
      if (response?.ok === false) {
        mark(undefined);
        setNotice({ text: response.message ?? '这次提问已经结束，模型没有收到你的选择', needsApiKey: false });
      }
    } catch {
      mark(undefined);
      setNotice({ text: '插件后台没有响应，这次提问的答案没送出去', needsApiKey: false });
    }
  }, []);

  /** 「新会话」：掐掉还在生成的一轮，回到只剩欢迎语的干净上下文 */
  const reset = useCallback(() => {
    const requestId = requestRef.current;
    if (requestId) void ext.runtime.sendMessage({ type: 'chat/stop', requestId });
    requestRef.current = null;
    assistantRef.current = null;
    setStreaming(false);
    setNotice(null);
    setUsage(null);
    setMessages([{ id: 'welcome', role: 'system', content: WELCOME, createdAt: 0 }]);
  }, []);

  return {
    messages,
    streaming,
    /** 后台还有活没干完（生成中——含等用户回答 ask 的那段时间、或正在写作答区） */
    busy: streaming || writing,
    writing,
    usage,
    /** 接口没回传 usage 时也要让数字动起来：按中英文字符粗估**当前这一轮**的输出 */
    liveOutputTokens: streaming
      ? estimateTokens(
          messagesRef.current.find((message) => message.id === assistantRef.current)?.content ?? '',
        )
      : 0,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    send,
    stop,
    inputCode,
    answerAsk,
    reset,
  };
}

/** 粗估 token 数：中日韩字符约 1 个 token，其余约 4 个字符 1 个 token（接口没回 usage 时兜底） */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x3000 && code <= 0x9fff) cjk += 1;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
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
  if (name === 'simulate_keyboard_input') {
    const parts: string[] = [];
    if (typeof parsed.selector === 'string' && parsed.selector) parts.push(parsed.selector);
    if (typeof parsed.text === 'string' && parsed.text) parts.push(`输入「${previewText(parsed.text)}」`);
    if (typeof parsed.press === 'string' && parsed.press) parts.push(`按下 ${parsed.press}`);
    if (parsed.clear === true) parts.push('先清空');
    return { summary: parts.join(' · ') };
  }
  if (name === 'ask' && typeof parsed.question === 'string') {
    const options = Array.isArray(parsed.options) ? parsed.options.filter((o) => typeof o === 'string') : [];
    return { summary: options.length > 0 ? `选项：${options.join(' / ')}` : undefined };
  }
  if (name === 'diff') {
    const left = typeof parsed.left === 'string' ? parsed.left : '';
    const right = typeof parsed.right === 'string' ? parsed.right : '';
    const stats = diffStats(diffLines(left, right));
    return { summary: `新增 ${stats.added} · 修改 ${stats.changed} · 删除 ${stats.removed}` };
  }
  const summary = rawArgs.trim();
  return { summary: summary === '{}' || summary === '' ? undefined : summary };
}

function previewText(text: string): string {
  const single = text.replace(/\s+/g, ' ');
  return single.length > 20 ? `${single.slice(0, 20)}…` : single;
}
