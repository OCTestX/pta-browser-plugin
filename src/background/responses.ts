// 「OpenAI Responses」协议的流式客户端（/responses）。
//
// 与 deepseek.ts 的 streamChat 一一对应，只是协议不同：请求体是 input 数组 +
// 扁平的 function 工具定义，流事件名是 response.output_text.delta 这一套。
// 消息/工具的转换与事件解析都在 shared/responses-api.ts（纯函数，有单测），
// 这里只负责发请求、读 SSE、把结果拼成面板要的形状。

import { throwIfAborted } from '../shared/abort.ts';
import type { TokenUsage } from '../shared/messages';
import type { ToolSchema } from '../shared/tools';
import type { ApiMessage, ToolCall } from '../shared/types';
import {
  consumeResponsesEvent,
  createResponsesState,
  responsesToolCalls,
  toResponsesInput,
  toResponsesTools,
  type ResponsesState,
} from '../shared/responses-api';

export interface ResponsesResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
}

interface ResponsesOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  messages: ApiMessage[];
  tools?: ToolSchema[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/** 调 OpenAI 的 /responses；按 SSE 增量回调，工具调用分片在解析器里拼好 */
export async function streamResponses(options: ResponsesOptions): Promise<ResponsesResult> {
  const { apiKey, baseURL, model, messages, tools, signal, onDelta } = options;
  const state: ResponsesState = createResponsesState();

  let response: Response;
  try {
    response = await fetch(`${baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: toResponsesInput(messages),
        stream: true,
        ...(tools && tools.length > 0 ? { tools: toResponsesTools(tools), tool_choice: 'auto' } : {}),
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

  // 中止时主动 cancel：接口半路不吐数据时，光等 fetch 自己报错不一定及时
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancelOnAbort();
  else signal.addEventListener('abort', cancelOnAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const payload = readPayload(line);
        if (payload === null) {
          return finish(state);
        }
        if (payload === '') continue;
        consumeResponsesEvent(payload, state, onDelta, model);
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
  }

  return finish(state);
}

function finish(state: ResponsesState): ResponsesResult {
  return { content: state.content, toolCalls: responsesToolCalls(state), usage: state.usage };
}

/** 返回该行的 data 内容；空串表示这行没有内容，null 表示流结束 */
function readPayload(line: string): string | null {
  const trimmed = line.trim();
  // Responses 会同时发 `event: xxx` 和 `data: {...}` 两行，只关心 data
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload) return '';
  return payload === '[DONE]' ? null : payload;
}

function describeHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在设置里检查';
  if (status === 402) return '账户余额不足';
  if (status === 404) return '接口地址或模型名不正确（404）：这个地址可能不支持 /responses 协议';
  if (status === 429) return '请求过于频繁或额度已用完（429），稍后再试';
  const brief = detail.slice(0, 200).replace(/\s+/g, ' ');
  return `请求失败（HTTP ${status}）${brief ? `：${brief}` : ''}`;
}
