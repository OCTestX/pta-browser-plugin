import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';
import {
  isChatEvent,
  type DiffPayload,
  type StartChatResponse,
  type TokenUsage,
} from '../../shared/messages';
import { createId, type ApiMessage, type ChatMessage, type ToolCall } from '../../shared/types';
import type { BatchSnapshot } from '../../shared/batch';
import { diffLines, diffStats } from '../../shared/diff';
import {
  clearApiContext,
  clearMessages,
  loadApiContext,
  loadMessages,
  runConversationKey,
  saveApiContext,
  saveMessages,
  takePendingCommand,
} from '../chatStore';
import { setPanelOpen } from '../panelStore';


const WELCOME = '你好，我是 PTA 助手。工具栏上的插件图标可以随时开关这个悬浮窗。';

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
  // 收尾时要知道「这一轮到底吐没吐字」，state 更新是异步的，所以留一份同镜像
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;
  /**
   * 真正发给接口的那串消息（带思维链）。
   *
   * 面板上的气泡是渲染用的：把气泡还原成消息序列会丢掉 reasoning_content，
   * 开了思考的接口要求上一轮 assistant 消息的思维链原样带回去，丢了直接 400。
   * 所以上下文由后台每轮结束时原样交过来，面板只负责存着、下一轮再发出去。
   */
  const apiContextRef = useRef<ApiMessage[]>([]);
  // 上下文还没从存储里接回来时不能发消息：否则第一句话就把前面的对话丢了
  const contextRestoredRef = useRef(false);
  // 「新会话」丢掉的那一轮：它收尾时交过来的上下文不要捡回来
  const discardedRequestRef = useRef<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  // 赶题模式（/fuck）的进度快照：面板据此画总览卡
  const [batch, setBatch] = useState<BatchSnapshot | null>(null);
  // 同一份状态的镜像：用来判断新来的快照是不是更新的那份
  const batchRef = useRef<BatchSnapshot | null>(null);
  // 当前正在写的 assistant 气泡；为 null 表示下一段文字要新起一个气泡
  const assistantRef = useRef<string | null>(null);
  // 最新的 send：页面刚挂载时要补发一条指令，那时的闭包还是第一次渲染的那份
  const sendRef = useRef<((text: string) => Promise<void>) | null>(null);

  // 流式增量按帧合并：模型一个字一个字往下推，每个 delta 都 setState 会让
  // 整棵消息树每字符重渲染一次，内容一多就卡。这里攒到下一帧再一次性上屏。
  const pendingDeltaRef = useRef('');
  const deltaFrameRef = useRef<number | null>(null);
  const appendDeltaRef = useRef<(text: string) => void>(() => undefined);
  /**
   * 这一轮模型吐出来的字，同步记一份。
   *
   * 收尾时要判断「模型这一轮有没有说话」——气泡里的内容是攒到下一帧才 setState 的，
   * 读 state 会读到还没更新的旧值（标签页在后台时 rAF 根本不跑，一整轮都攒着），
   * 于是明明答了一整段话，却报「模型这一轮没有输出内容」。
   * 这里同步累加，收尾时读它就是准的。
   */
  const producedRef = useRef('');

  /** 收下后台交过来的这一轮上下文：存到内存，也存到磁盘（刷新不丢） */
  const applyApiContext = useCallback((context: ApiMessage[]) => {
    apiContextRef.current = context;
    void saveApiContext(context);
  }, []);

  /** 页面重新挂载时把存好的上下文接回来 */
  const restoreApiContext = useCallback(async () => {
    const stored = await loadApiContext();
    // 取完再置位：取的过程中发消息会等它，不会拿着半截上下文去请求
    contextRestoredRef.current = true;
    if (stored.length > 0) applyApiContext(stored);
  }, [applyApiContext]);

  const flushDelta = useCallback(() => {
    if (deltaFrameRef.current !== null) {
      cancelAnimationFrame(deltaFrameRef.current);
      deltaFrameRef.current = null;
    }
    const pending = pendingDeltaRef.current;
    pendingDeltaRef.current = '';
    if (pending) appendDeltaRef.current(pending);
  }, []);

  const scheduleDelta = useCallback(
    (text: string) => {
      pendingDeltaRef.current += text;
      if (deltaFrameRef.current !== null) return;
      const run = () => {
        deltaFrameRef.current = null;
        const pending = pendingDeltaRef.current;
        pendingDeltaRef.current = '';
        if (pending) appendDeltaRef.current(pending);
      };
      if (typeof requestAnimationFrame === 'function') {
        deltaFrameRef.current = requestAnimationFrame(run);
      } else {
        deltaFrameRef.current = setTimeout(run, 0) as unknown as number;
      }
    },
    [],
  );

  // 页面被关掉/刷新时，把还没落盘的那次改动补上（防抖窗口里可能还差最后一截）
  useEffect(() => {
    const flush = () => {
      void saveMessages(messagesRef.current);
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // 刷新页面后把上次的对话恢复回来（按标签页分桶：同 URL 的另一个标签页不共享）
  //
  // 另外还要问后台一句「这个标签页上有正在跑的对话吗」：
  // PTA 自己刷新页面时（判题流程、整页跳转），面板会重新挂载，
  // 之前那轮的 requestId 就丢了 —— 不接回去的话，面板收不到那一轮的事件，
  // 「停止」按钮也按不到后台（赶题模式尤其要命）。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let attachId = '';
      let attachSnapshot: BatchSnapshot | undefined;
      try {
        const response = (await ext.runtime.sendMessage({ type: 'chat/attach' })) as
          | { ok?: boolean; requestId?: string; snapshot?: BatchSnapshot }
          | undefined;
        if (response?.requestId) attachId = response.requestId;
        attachSnapshot = response?.snapshot;
      } catch {
        // 后台没响应就当没有在跑的对话
      }
      if (cancelled) return;
      // 上下文：把存好的那份接回来（刷新、整页跳转都不丢）
      await restoreApiContext();
      if (cancelled) return;
      // 赶题总览卡里点了「跳到那道题」：那边留了一条待发指令，这里取出来。
      // 先取出来再走下面的分支：万一这一页还有一轮在跑（用户手快），
      // 这条指令也不能一直躺在存储里，等下次打开页面时莫名其妙冒出来。
      const pending = takePendingCommand();
      // 赶题模式跑到一半页面刷新了：总览卡跟着接回来
      if (attachSnapshot) applyBatch(attachSnapshot);
      if (attachId) {
        // 接回正在跑的那一轮：对话按 requestId 存盘，事件也要按它的 requestId 收。
        // 面板这时是关着的（刷新后默认关闭），自动打开它，
        // 用户才能看见这一轮在干什么、也才按得到「停止」。
        requestRef.current = attachId;
        setStreaming(true);
        setPanelOpen(true);
        const restored = await loadMessages(runConversationKey(attachId));
        if (!cancelled && restored.length > 0) setMessages(restored);
        return;
      }
      const restored = await loadMessages();
      if (cancelled) return;
      if (restored.length > 0) {
        // 先把引用也换掉：紧接着要补发的指令要用「恢复后的」那份消息当上下文，
        // 而 setMessages 的渲染要等到下一个任务，这里等不及。
        messagesRef.current = restored;
        setMessages(restored);
      }
      // 跳过去之后接着赶题：把待发的那条指令补发出去（用户只点一下就够了）。
      // 面板默认是关着的（刷新后要重新点图标），这里顺手打开：
      // 用户刚点了「重做」，得看得见 agent 在干活。
      if (pending) {
        setPanelOpen(true);
        await sendRef.current?.(pending);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 对话一变就存回去：刷新、关页面再打开都还在（sessionStorage 刷新不丢）。
  // 仍然防抖：流式输出时每个字都会触发一次 setMessages，一次回答能存几百次，
  // 每次都把整份会话序列化写进 sessionStorage 没必要。
  //
  // 正在跑的那一轮另外按 requestId 存一份：赶题模式会整页跳转，
  // 面板重新挂载时靠 chat/attach 拿回 requestId，再从这份里恢复对话。
  useEffect(() => {
    // 刚挂载时的那一帧还没恢复，别把欢迎语写回去把旧对话覆盖掉
    if (messages.length === 1 && messages[0].id === 'welcome') return;
    const requestId = requestRef.current;
    const timer = setTimeout(() => {
      void saveMessages(messages);
      if (requestId) void saveMessages(messages, runConversationKey(requestId));
    }, 800);
    return () => clearTimeout(timer);
  }, [messages]);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isChatEvent(message)) return;

      // 赶题进度是「这个标签页」的状态，不是「这一轮对话」的状态：
      // 用户按了停止之后 requestRef 已经清空，但后台还会补一条收工快照，
      // 卡片要照常定格在最终统计上。所以这里单独放行，只认更新的那份快照。
      if (message.type === 'chat/batch') {
        applyBatch(message.snapshot);
        return;
      }

      // 这一轮真正发给接口的对话：存下来，下一轮原样再发。
      // requestRef 对不上也照样收：面板重新挂载时那一轮已经收工了，
      // 但上下文还是要接回来，不然用户下一句话接不上茬。
      if (message.type === 'chat/api-context') {
        // 「新会话」刚丢掉的那一轮：它收尾时交过来的上下文不要捡回来
        if (message.requestId !== discardedRequestRef.current) {
          applyApiContext(message.messages);
        }
        return;
      }

      if (message.requestId !== requestRef.current) return;

      // 除增量以外的事件都要先把攒着的文字落到气泡里，保证顺序不乱
      if (message.type !== 'chat/delta') flushDelta();

      switch (message.type) {
        case 'chat/delta':
          scheduleDelta(message.text);
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
    // 同步记一份：收尾时判断「这轮有没有吐字」不能等 state 更新
    producedRef.current += text;
    setMessages((prev) => {
      const currentId = assistantRef.current;
      if (currentId) {
        return prev.map((message) =>
          message.id === currentId
            ? { ...message, content: message.content + text, streaming: true }
            : message,
        );
      }
      // 工具调用之后模型又开口说话：本来该另起一个气泡，
      // 但那样一句连贯的回答会被拆成两个框（模型先说半句、调工具、再说半句）。
      // 所以接着上一次那条带 tool_calls 的气泡往下写，文字就连起来了。
      const lastAssistant = [...prev]
        .reverse()
        .find((message) => message.role === 'assistant' && (message.toolCalls ?? []).length > 0);
      if (lastAssistant && lastAssistant.content.trim()) {
        // 续写的是那条带 tool_calls 的气泡：把「当前气泡」指回它。
        // 否则收尾时找不到当前气泡，streaming 永远停在 true，光标就一直闪。
        assistantRef.current = lastAssistant.id;
        return prev.map((message) =>
          message.id === lastAssistant.id
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

  // 监听器只注册一次，用 ref 拿最新的 appendDelta
  appendDeltaRef.current = appendDelta;

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

  /**
   * 收下后台推来的赶题进度快照。
   *
   * 只认更新的那份：晚到的旧快照（比如上一轮残留的）不能把新一轮的进度盖回去。
   */
  const applyBatch = useCallback((snapshot: BatchSnapshot) => {
    const current = batchRef.current;
    if (current && snapshot.updatedAt < current.updatedAt) return;
    batchRef.current = snapshot;
    setBatch(snapshot);
  }, []);

  const finish = useCallback(() => {
    flushDelta();
    const currentId = assistantRef.current;
    if (currentId) {
      // 模型这一轮一个字都没吐：空气泡不渲染，用户会以为卡死了，所以留个提示。
      // 读同步记的那份，而不是气泡里的内容——后者是攒到下一帧才写进去的，
      // 这会儿往往还是空的（标签页在后台时 rAF 压根不跑）。
      const produced = producedRef.current.trim();
      setMessages((prev) =>
        prev.map((message) => {
          if (message.id === currentId) {
            return {
              ...message,
              streaming: false,
              // 收尾时记一次耗时：气泡顶部显示，用户能看出这轮有多慢
              elapsedMs: message.createdAt ? Date.now() - message.createdAt : undefined,
            };
          }
          // 兜底：这一轮已经结束，任何还在 streaming 的气泡都不该再闪光标
          return message.streaming ? { ...message, streaming: false } : message;
        }),
      );
      if (!produced) {
        setNotice({
          text: '模型这一轮没有输出内容（可以再问一次，或点「新会话」重新开始）',
          needsApiKey: false,
        });
      }
    }
    else {
      // 没有「当前气泡」也不能留下闪个不停的收尾光标
      setMessages((prev) =>
        prev.some((message) => message.streaming)
          ? prev.map((message) => (message.streaming ? { ...message, streaming: false } : message))
          : prev,
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
      // 上下文用后台每轮结束时交回来的那份（真正发给接口的消息序列，带思维链）。
      // 面板上的气泡是渲染用的，从气泡重建出来的序列没有 reasoning_content，
      // 开了思考的接口会直接 400（「reasoning_content must be passed back」）。
      // 存着的上下文还没接回来时先接回来，别把前面的对话丢了。
      if (!contextRestoredRef.current) await restoreApiContext();
      const apiMessages: ApiMessage[] = [...apiContextRef.current, { role: 'user', content }];

      // 第一次对话开始后，欢迎语就没用了：把它撤掉，面板上不再占地方
      setMessages((prev) => [
        ...prev.filter((message) => message.id !== 'welcome'),
        userMessage,
        assistantMessage,
      ]);
      setNotice(null);
      setStreaming(true);
      const requestId = createId();
      requestRef.current = requestId;
      assistantRef.current = assistantMessage.id;
      // 新的一轮从头记：上一轮吐过的字不算这一轮的
      producedRef.current = '';

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
    [hasApiKey, streaming, restoreApiContext],
  );
  sendRef.current = send;

  const stop = useCallback(() => {
    flushDelta();
    const requestId = requestRef.current;
    if (requestId) void Promise.resolve(ext.runtime.sendMessage({ type: 'chat/stop', requestId })).catch(() => undefined);

    // 面板不等后台回话：先把「停下来了」做出来（进度条停、工具卡片收尾），
    // 否则某一阶段没接上停止信号时，界面会一直转、用户以为按钮按不动。
    // requestRef 也一并清掉，之后迟到的 chat/* 事件一律不再上屏。
    const assistantId = assistantRef.current;
    assistantRef.current = null;
    requestRef.current = null;
    setStreaming(false);
    setMessages((prev) =>
      prev.map((message) => {
        if (message.id === assistantId) return { ...message, streaming: false };
        if (message.role === 'tool' && (message.toolStatus ?? 'running') === 'running' && !message.content) {
          return { ...message, content: '已停止', toolStatus: 'error' as const };
        }
        return message;
      }),
    );
    appendSystem('已停止这一轮');
  }, [appendSystem]);

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
    flushDelta();
    const requestId = requestRef.current;
    if (requestId) void ext.runtime.sendMessage({ type: 'chat/stop', requestId });
    requestRef.current = null;
    assistantRef.current = null;
    setStreaming(false);
    setNotice(null);
    setUsage(null);
    setBatch(null);
    batchRef.current = null;
    setMessages([{ id: 'welcome', role: 'system', content: WELCOME, createdAt: 0 }]);
    // 上下文也要清：新会话就是从头开始，别把上一段对话再发给接口
    apiContextRef.current = [];
    // 这一轮收尾时后台还会把它的上下文交过来：那一轮已经被丢掉了，别捡回来
    discardedRequestRef.current = requestId;
    void clearApiContext();
    // 存盘的那份也要清掉，否则刷新一下旧对话又回来了
    void clearMessages();
    // 这一轮自己那份（按 requestId 存的）也要清
    if (requestId) void clearMessages(runConversationKey(requestId));
  }, []);

  return {
    messages,
    streaming,
    /** 后台还有活没干完（生成中——含等用户回答 ask 的那段时间） */
    busy: streaming,
    usage,
    /** 赶题模式（/fuck）的进度快照；null 表示没在赶题模式 */
    batch,
    /** 接口没回传 usage 时也要让数字动起来：按中英文字符粗估**当前这一轮**的输出 */
    liveOutputTokens: streaming
      ? estimateTokens(
          messagesRef.current.find((message) => message.id === assistantRef.current)?.content ?? '',
        )
      : 0,
    notice,
    dismissNotice: useCallback(() => setNotice(null), []),
    /** 面板自己冒出来的一句话提示（跳转失败之类的） */
    notify: useCallback((text: string) => setNotice({ text, needsApiKey: false }), []),
    send,
    stop,
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
