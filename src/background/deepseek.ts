import type { TokenUsage } from '../shared/messages';
import type { ToolSchema } from '../shared/tools';
import type { ApiMessage, ToolCall } from '../shared/types';

export interface StreamChatResult {
  content: string;
  toolCalls: ToolCall[];
  /** 接口在最后一帧回传的 token 用量（有些兼容接口不回传，这时是 undefined） */
  usage?: TokenUsage;
}

interface StreamChatOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  messages: ApiMessage[];
  tools?: ToolSchema[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/** 调用 OpenAI 兼容的 /chat/completions，按 SSE 增量回调，并把流式 tool_calls 拼接完整 */
export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const { apiKey, baseURL, model, messages, tools, signal, onDelta } = options;
  const state: StreamState = { content: '', calls: new Map() };

  let response: Response;
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        // 让兼容接口在最后一帧回传 token 用量（DeepSeek / 硅基流动都认这个字段）
        stream_options: { include_usage: true },
        ...(tools && tools.length > 0 ? { tools } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(`无法连接 ${baseURL}，请检查网络或接口地址`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(describeHttpError(response.status, detail));
  }
  if (!response.body) throw new Error('接口没有返回流式内容');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // 最后一段可能是半行，留到下次读取再处理
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const payload = readPayload(line);
      if (payload === null) return toResult(state); // 收到 [DONE]
      if (payload === '') continue;
      consume(payload, state, model, onDelta);
    }
  }

  return toResult(state);
}

interface StreamState {
  content: string;
  calls: Map<number, { id: string; name: string; args: string }>;
  usage?: TokenUsage;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface ChunkPayload {
  choices?: {
    delta?: {
      content?: unknown;
      tool_calls?: {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
  }[];
  error?: { message?: unknown };
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
}

function consume(
  payload: string,
  state: StreamState,
  model: string,
  onDelta: (text: string) => void,
): void {
  let parsed: ChunkPayload;
  try {
    parsed = JSON.parse(payload) as ChunkPayload;
  } catch {
    return; // 解析不了的行直接跳过
  }

  if (typeof parsed.error?.message === 'string') {
    throw new Error(`${model} 返回错误：${parsed.error.message}`);
  }

  // token 用量通常在最后一帧单独发一帧（choices 为空）
  if (parsed.usage) {
    const promptTokens = numberOrZero(parsed.usage.prompt_tokens);
    const completionTokens = numberOrZero(parsed.usage.completion_tokens);
    const totalTokens = numberOrZero(parsed.usage.total_tokens);
    state.usage = {
      promptTokens,
      completionTokens,
      totalTokens: totalTokens || promptTokens + completionTokens,
    };
  }

  const delta = parsed.choices?.[0]?.delta;
  if (!delta) return;

  if (typeof delta.content === 'string' && delta.content) {
    state.content += delta.content;
    onDelta(delta.content);
  }

  // tool_calls 会被切成多个分片下发，按 index 累积，id / name 通常只在第一片里
  for (const call of delta.tool_calls ?? []) {
    const index = typeof call.index === 'number' ? call.index : 0;
    const current = state.calls.get(index) ?? { id: '', name: '', args: '' };
    if (typeof call.id === 'string' && call.id) current.id = call.id;
    if (typeof call.function?.name === 'string' && call.function.name) current.name = call.function.name;
    if (typeof call.function?.arguments === 'string') current.args += call.function.arguments;
    state.calls.set(index, current);
  }
}

function toResult(state: StreamState): StreamChatResult {
  const toolCalls: ToolCall[] = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call], position): ToolCall => ({
      id: call.id || `call_${position + 1}_${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.args },
    }))
    .filter((call) => call.function.name);

  return { content: state.content, toolCalls, usage: state.usage };
}

/** 返回该行的 data 内容；空串表示这行没有内容，null 表示流结束 */
function readPayload(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload) return '';
  return payload === '[DONE]' ? null : payload;
}

function describeHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在设置里检查';
  if (status === 402) return '账户余额不足';
  if (status === 404) return '接口地址或模型名不正确（404）';
  if (status === 429) return '请求过于频繁或额度已用完（429），稍后再试';
  const brief = detail.slice(0, 200).replace(/\s+/g, ' ');
  return `请求失败（HTTP ${status}）${brief ? `：${brief}` : ''}`;
}
