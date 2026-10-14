/** 会话里的一条记录：既用来渲染，也用来重建下一次请求的上下文 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: number;
  /** 正在流式输出 */
  streaming?: boolean;
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
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 把面板里的消息还原成接口要的消息序列。
 * 注意：带 tool_calls 的 assistant 消息后面必须紧跟对应的 tool 消息，所以工具卡片不能丢。
 */
export function toApiMessages(messages: ChatMessage[], fallbackInput?: string): ApiMessage[] {
  const result: ApiMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system' || message.error) continue;

    if (message.role === 'tool') {
      if (!message.toolCallId) continue;
      result.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    if (message.role === 'user') {
      if (message.content.trim()) result.push({ role: 'user', content: message.content });
      continue;
    }

    const toolCalls = message.toolCalls ?? [];
    if (!message.content.trim() && toolCalls.length === 0) continue;
    result.push({
      role: 'assistant',
      content: message.content.trim() ? message.content : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  if (fallbackInput?.trim()) result.push({ role: 'user', content: fallbackInput });
  return result;
}
