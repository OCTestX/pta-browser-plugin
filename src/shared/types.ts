/** 会话里的一条记录：既用来渲染，也用来重建下一次请求的上下文 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
  /** 正在流式输出 */
  streaming?: boolean;
  /** 这一轮回答用了多久（毫秒，只在助手气泡上、收尾时写一次） */
  elapsedMs?: number;
  /** 报错提示，红色展示 */
  error?: boolean;
  /** 这一轮回答里的工具调用 */
  toolCalls?: ToolCall[];
  /** role === 'tool' 时：工具名、参数、执行状态 */
  toolName?: string;
  toolArgs?: string;
  toolCallId?: string;
  toolStatus?: 'running' | 'ok' | 'error';
  /** role === 'tool' 且是 js_inject 时，代码原文（渲染用） */
  toolCode?: string;
  /** role === 'tool' 且是 ask 时：问题、选项、用户选中的答案 */
  toolQuestion?: string;
  toolOptions?: string[];
  toolChoice?: string;
  /** role === 'tool' 且是 diff 时：左右两栏原文 */
  toolDiff?: { left: string; right: string; leftLabel: string; rightLabel: string };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 发给 OpenAI 兼容接口的消息 */
export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * 思考模式（thinking）下模型吐出来的思维链。
   *
   * 开了思考的模型（DeepSeek、MiniMax 等）要求：后续请求里必须把上一轮
   * assistant 消息的 reasoning_content 原样带回去，否则接口直接 400
   * （「The `reasoning_content` in the thinking mode must be passed back to the API.」）。
   * 所以这一段要跟着一轮对话一起存、一起回传，不能在重建上下文时丢掉。
   */
  reasoning_content?: string;
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把一段接口消息整理成「接口一定能收」的形状。
 *
 * 工具调用与工具结果必须成对：每个 assistant.tool_calls 都要有一条对应的
 * tool 消息，反过来每条 tool 消息都要有发起它的 assistant。少一条接口就 400。
 * 这一轮被中途打断时最容易出现落单的情况（assistant 记下了调用，结果还没回灌），
 * 所以每次把上下文交出去之前都要过一遍这里。
 *
 * 纯函数，Node 能直接单测。
 */
export function sanitizeApiMessages(messages: ApiMessage[]): ApiMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.tool_call_id) answered.add(message.tool_call_id);
  }

  // 第一步：assistant 里没有结果的那些 tool_calls 摘掉（整条摘光就退化成普通回复）
  const kept: ApiMessage[] = [];
  for (const message of messages) {
    const calls = message.tool_calls ?? [];
    if (message.role === 'assistant' && calls.length > 0) {
      const answeredCalls = calls.filter((call) => answered.has(call.id));
      kept.push(
        answeredCalls.length === calls.length
          ? message
          : { ...message, tool_calls: answeredCalls.length > 0 ? answeredCalls : undefined },
      );
      continue;
    }
    kept.push(message);
  }

  // 第二步：tool 消息的发起者被摘掉了，这条 tool 也就成了孤儿，一起丢
  const called = new Set<string>();
  for (const message of kept) {
    for (const call of message.tool_calls ?? []) called.add(call.id);
  }
  return kept.filter((message) => {
    if (message.role !== 'tool') return true;
    const id = message.tool_call_id ?? '';
    return id !== '' && called.has(id);
  });
}

/**
 * 把后台这一轮的对话整理成「面板能存、下一轮能原样再发」的样子。
 *
 * · 去掉系统消息：下一轮由后台重新拼在最前面（还要带上当轮的斜杠指令说明），
 *   面板存一份系统消息进去，下一轮就会多出一条不在最前面的 system，接口会拒
 * · 去掉图片内容块的消息：图片只在这一轮里发给模型看，下一轮再发一遍只是白费 token
 * · 工具调用与工具结果必须成对（sanitizeApiMessages）
 * · 既没有正文也没有工具调用的 assistant 是空壳，接口可能不收
 *
 * 纯函数，Node 能直接单测。
 */
export function toApiContext(messages: ApiMessage[]): ApiMessage[] {
  const body = messages.filter((message) => {
    if (message.role === 'system') return false;
    // 图片消息的 content 运行时是内容块数组，ApiMessage 这里只声明了字符串
    const content: unknown = message.content;
    return typeof content === 'string' || content === null;
  });
  const paired = sanitizeApiMessages(body);
  return paired.filter((message) => {
    if (message.role !== 'assistant') return true;
    const hasContent = typeof message.content === 'string' && message.content !== '';
    return hasContent || (message.tool_calls?.length ?? 0) > 0;
  });
}
