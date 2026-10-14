import type { ChatTurn } from '../shared/messages';

interface StreamChatOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  turns: ChatTurn[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/** 调用 OpenAI 兼容的 /chat/completions，按 SSE 增量回调 */
export async function streamChat(options: StreamChatOptions): Promise<void> {
  const { apiKey, baseURL, model, turns, signal, onDelta } = options;

  let response: Response;
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages: turns, stream: true }),
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
      const delta = readDelta(line, model);
      if (delta === null) return; // 收到 [DONE]
      if (delta) onDelta(delta);
    }
  }
}

/** 返回该行的增量文本；空串表示这行没有内容，null 表示流结束 */
function readDelta(line: string, model: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload) return '';
  if (payload === '[DONE]') return null;

  let parsed: {
    choices?: { delta?: { content?: unknown } }[];
    error?: { message?: unknown };
  };
  try {
    parsed = JSON.parse(payload);
  } catch {
    return ''; // 解析不了的行直接跳过
  }

  if (typeof parsed.error?.message === 'string') {
    throw new Error(`${model} 返回错误：${parsed.error.message}`);
  }
  const delta: unknown = parsed.choices?.[0]?.delta?.content;
  return typeof delta === 'string' ? delta : '';
}

function describeHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限，请在设置里检查';
  if (status === 402) return '账户余额不足';
  if (status === 404) return '接口地址或模型名不正确（404）';
  if (status === 429) return '请求过于频繁或额度已用完（429），稍后再试';
  const brief = detail.slice(0, 200).replace(/\s+/g, ' ');
  return `请求失败（HTTP ${status}）${brief ? `：${brief}` : ''}`;
}
