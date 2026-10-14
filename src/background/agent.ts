import {
  MAX_TOOL_ROUNDS,
  SYSTEM_PROMPT,
  TOOL_SCHEMAS,
  isToolName,
  parseToolArguments,
  truncate,
} from '../shared/tools';
import type { ApiMessage } from '../shared/types';
import { streamChat } from './deepseek';
import { injectScript } from './js-inject';
import { loadSettings } from './settings';

export interface ToolOutcome {
  output: string;
  isError: boolean;
}

export interface AgentEvents {
  onDelta: (text: string) => void;
  onToolStart: (call: { callId: string; name: string; args: string }) => void;
  onToolEnd: (callId: string, result: string, isError: boolean) => void;
  onNotice: (text: string) => void;
  /** 需要页面上下文才能执行的工具（url / write_document），交给 content script 做 */
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

interface RunAgentOptions {
  messages: ApiMessage[];
  tabId: number;
  signal: AbortSignal;
  events: AgentEvents;
}

/**
 * agent loop：请求模型 → 如果它要调工具就执行 → 把结果回灌 → 再来一轮，直到它给出最终回答。
 * 最多 MAX_TOOL_ROUNDS 轮，防止模型来回刷工具。
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { messages, tabId, signal, events } = options;
  const settings = await loadSettings();
  const conversation: ApiMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const { content, toolCalls } = await streamChat({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      model: settings.model,
      messages: conversation,
      tools: TOOL_SCHEMAS,
      signal,
      onDelta: events.onDelta,
    });

    if (toolCalls.length === 0) return;

    conversation.push({
      role: 'assistant',
      content: content.trim() ? content : null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      events.onToolStart({
        callId: call.id,
        name: call.function.name,
        args: call.function.arguments,
      });
      const outcome = await runTool(call.function.name, call.function.arguments, tabId, events);
      events.onToolEnd(call.id, outcome.output, outcome.isError);
      conversation.push({
        role: 'tool',
        tool_call_id: call.id,
        content: truncate(outcome.output),
      });
    }
  }

  events.onNotice(`已经连续调用 ${MAX_TOOL_ROUNDS} 轮工具了，先停在这里。可以让我继续。`);
}

async function runTool(
  name: string,
  rawArguments: string,
  tabId: number,
  events: AgentEvents,
): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return { output: `没有名为 ${name} 的工具，可用工具：js_inject、date、url、write_document`, isError: true };
  }

  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return { output: parsed.error, isError: true };
  const args = parsed.args;

  if (name === 'date') return { output: describeNow(), isError: false };

  if (name === 'js_inject') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const result = await injectScript(tabId, code);
    return { output: result.output, isError: !result.ok };
  }

  // url / write_document 需要页面上下文
  return events.runPageTool(name, args);
}

function describeNow(): string {
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${date} ${time}（${weekdays[now.getDay()]}）`;
}
