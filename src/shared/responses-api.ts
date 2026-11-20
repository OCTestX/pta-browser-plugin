// OpenAI「Responses」接口的纯逻辑：消息转换、工具转换、SSE 事件解析。
//
// 为什么不塞进 deepseek.ts：那边是 /chat/completions 那一套；两种协议的消息形状、
// 流事件名、工具调用分片方式都不一样。抽成纯函数放 shared 里，Node 能直接单测
// （scripts/test-responses-api.mjs），网络那半边在 background/responses.ts。
//
// 带上 .ts 后缀：Node 不做省略后缀解析。

import type { TokenUsage } from './messages.ts';
import type { ToolSchema } from './tools.ts';
import type { ApiMessage, ToolCall } from './types.ts';

/** Responses 的输入项：普通消息，或者一次工具调用/工具结果 */
export type ResponsesInputItem =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** Responses 的工具定义：比 Chat Completions 少一层 function 包装 */
export interface ResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: unknown;
}

export function toResponsesTools(tools: ToolSchema[]): ResponsesTool[] {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

/**
 * 把面板里的消息序列转成 Responses 的 input。
 *
 * 注意工具调用：Chat Completions 里是 assistant.tool_calls + role:'tool'，
 * Responses 里是平铺的两个 item（function_call / function_call_output），
 * 靠 call_id 对上。我们自己生成 tool call 时就把 call_id 当 id 用，所以这里直接互转。
 */
export function toResponsesInput(messages: ApiMessage[]): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!message.tool_call_id) continue;
      items.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content ?? '',
      });
      continue;
    }
    if (message.role === 'assistant') {
      if (message.content && message.content.trim()) {
        items.push({ role: 'assistant', content: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        items.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }
    // system / user
    const text = message.content ?? '';
    if (!text.trim()) continue;
    items.push({ role: message.role, content: text });
  }
  return items;
}

/** 流式解析的中间状态：一次请求对应一份 */
export interface ResponsesState {
  content: string;
  /** item_id（或 call_id）→ 这次工具调用的分片 */
  calls: Map<string, { id: string; name: string; args: string }>;
  usage?: TokenUsage;
  done: boolean;
}

export function createResponsesState(): ResponsesState {
  return { content: '', calls: new Map(), done: false };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface ResponsesPayload {
  type?: unknown;
  delta?: unknown;
  item_id?: unknown;
  arguments?: unknown;
  message?: unknown;
  error?: { message?: unknown };
  item?: {
    type?: unknown;
    id?: unknown;
    call_id?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  response?: {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      total_tokens?: unknown;
    };
    error?: { message?: unknown };
  };
}

/**
 * 消费一帧 SSE 数据（`data: {...}` 里的 JSON 字符串）。
 *
 * 抛错表示这一轮结束了：接口自己报了错，或者被判定失败。
 * 认不出的事件直接忽略——Responses 的事件名很多，我们只关心文本增量、
 * 工具调用的增量和最终的用量。
 */
export function consumeResponsesEvent(
  payload: string,
  state: ResponsesState,
  onDelta: (text: string) => void,
  model = '',
): void {
  let parsed: ResponsesPayload;
  try {
    parsed = JSON.parse(payload) as ResponsesPayload;
  } catch {
    return;
  }

  const failure = parsed.response?.error?.message ?? parsed.error?.message;
  if (typeof failure === 'string' && failure) {
    throw new Error(`${model} 返回错误：${failure}`);
  }

  const type = typeof parsed.type === 'string' ? parsed.type : '';

  if (type === 'response.output_text.delta' && typeof parsed.delta === 'string' && parsed.delta) {
    state.content += parsed.delta;
    onDelta(parsed.delta);
    return;
  }

  if (type === 'response.output_item.added' && parsed.item && parsed.item.type === 'function_call') {
    const key = String(parsed.item.id ?? parsed.item.call_id ?? '');
    if (!key) return;
    const current = state.calls.get(key) ?? { id: '', name: '', args: '' };
    // call_id 才是发给接口时对得上的那个 id
    const callId = typeof parsed.item.call_id === 'string' ? parsed.item.call_id : '';
    if (callId) current.id = callId;
    if (typeof parsed.item.name === 'string' && parsed.item.name) current.name = parsed.item.name;
    if (typeof parsed.item.arguments === 'string') current.args = parsed.item.arguments;
    state.calls.set(key, current);
    return;
  }

  if (type === 'response.function_call_arguments.delta') {
    const key = String(parsed.item_id ?? '');
    if (!key) return;
    const current = state.calls.get(key) ?? { id: '', name: '', args: '' };
    if (typeof parsed.delta === 'string') current.args += parsed.delta;
    state.calls.set(key, current);
    return;
  }

  if (type === 'response.output_item.done' && parsed.item && parsed.item.type === 'function_call') {
    const key = String(parsed.item.id ?? parsed.item.call_id ?? '');
    if (!key) return;
    const current = state.calls.get(key) ?? { id: '', name: '', args: '' };
    const callId = typeof parsed.item.call_id === 'string' ? parsed.item.call_id : '';
    if (callId) current.id = callId;
    if (typeof parsed.item.name === 'string' && parsed.item.name) current.name = parsed.item.name;
    // done 里带的是完整参数：以它为准，避免分片拼接时漏掉尾部
    if (typeof parsed.item.arguments === 'string' && parsed.item.arguments) {
      current.args = parsed.item.arguments;
    }
    state.calls.set(key, current);
    return;
  }

  if (type === 'response.completed') {
    state.done = true;
    const usage = parsed.response?.usage;
    if (usage) {
      const promptTokens = numberOrZero(usage.input_tokens);
      const completionTokens = numberOrZero(usage.output_tokens);
      const totalTokens = numberOrZero(usage.total_tokens);
      state.usage = {
        promptTokens,
        completionTokens,
        totalTokens: totalTokens || promptTokens + completionTokens,
      };
    }
  }
}

/** 收尾：把分片拼成面板用的 ToolCall 列表 */
export function responsesToolCalls(state: ResponsesState): ToolCall[] {
  return [...state.calls.entries()]
    .map(([key, call]): ToolCall => ({
      id: call.id || key,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }))
    .filter((call) => call.function.name);
}
