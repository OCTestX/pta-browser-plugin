import {
  MAX_TOOL_ROUNDS,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  isToolName,
  parseToolArguments,
  truncate,
} from '../shared/tools';
import type { ApiMessage } from '../shared/types';
import { compileAndRun } from './compile';
import { createDebuggerIo, detach, pressKey } from './debugger-input';
import {
  READ_EDITOR_SCRIPT,
  READ_PROBLEM_SCRIPT,
  WRITE_EDITOR_SCRIPT,
} from './pta-scripts';
import { describeTypist, runTypist } from './typist';

const DEFAULT_PER_CHAR_DELAY_MS = 8;
import { streamChat } from './deepseek';
import { injectScript } from './js-inject';
import { loadSettings } from './settings';
import type { Settings } from '../shared/settings';

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
      const outcome = await runTool(
        call.function.name,
        call.function.arguments,
        tabId,
        events,
        settings,
      );
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
  settings: Settings,
): Promise<ToolOutcome> {
  if (!isToolName(name)) {
    return { output: `没有名为 ${name} 的工具，可用工具：${TOOL_NAMES.join('、')}`, isError: true };
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

  if (name === 'compile_and_run_c') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const stdin = typeof args.stdin === 'string' ? args.stdin : '';
    try {
      const report = await compileAndRun({
        code,
        stdin,
        serviceURL: settings.compileServiceURL,
        languageId: settings.compileLanguageId,
      });
      return { output: report, isError: false };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  // PTA 三件套：都在页面主世界跑（编辑器实例挂在页面自己的 JS 对象上）
  if (name === 'read_problem' || name === 'read_editor_code' || name === 'write_editor_code') {
    const scripts = {
      read_problem: READ_PROBLEM_SCRIPT,
      read_editor_code: READ_EDITOR_SCRIPT,
      write_editor_code: WRITE_EDITOR_SCRIPT,
    };
    const result = await injectScript(tabId, scripts[name], args);
    return { output: result.output, isError: !result.ok };
  }

  if (name === 'simulate_keyboard_input' && settings.useDebuggerInput) {
    return typeWithDebugger(args, tabId, events);
  }

  // 其余工具需要页面上下文
  return events.runPageTool(name, args);
}

/**
 * 开了「真实按键」开关时：先让页面把焦点放到目标元素上（顺带按需选中全部内容以便替换），
 * 再用 CDP 输入文本 / 按键，事件是 trusted 的。
 * CDP 用不了（DevTools 占着、浏览器不支持）就退回 DOM 事件，并说明原因。
 */
async function typeWithDebugger(
  args: Record<string, unknown>,
  tabId: number,
  events: AgentEvents,
): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text : '';
  const press = typeof args.press === 'string' ? args.press.trim() : '';

  const focused = await events.runPageTool('simulate_keyboard_input', { ...args, focusOnly: true });
  if (focused.isError) return focused;

  const steps = [focused.output];
  try {
    if (text) {
      // 逐字敲，边敲边和编辑器的自动闭合 / 自动缩进对抗
      const stats = await runTypist(createDebuggerIo(tabId), text, perCharDelay(args));
      steps.push(describeTypist(stats));
    }
    if (press) {
      await pressKey(tabId, press);
      steps.push(`已用真实按键按下 ${press}`);
    }

    // 按键是异步生效的，不回读确认就是假成功
    if (text) {
      const readBack = await events.runPageTool('simulate_keyboard_input', {
        selector: args.selector,
        readOnly: true,
      });
      if (!readBack.isError) steps.push(compareTyped(text, readBack.output));
    }

    return { output: steps.join('；'), isError: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await events.runPageTool('simulate_keyboard_input', args);
    return {
      output: `调试器输入失败（${reason}），已退回模拟事件：${fallback.output}`,
      isError: fallback.isError,
    };
  } finally {
    // 横幅只在真正输入的这一小会儿出现
    await detach(tabId);
  }
}

function perCharDelay(args: Record<string, unknown>): number {
  const value = args.perCharDelayMs;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PER_CHAR_DELAY_MS;
  return Math.min(Math.max(Math.round(value), 0), 200);
}

/** 尾部空白与末尾空行不算差异（编辑器可能补/去一个换行），其余逐行比对 */
function compareTyped(expected: string, actual: string): string {
  const normalize = (value: string): string[] => {
    const lines = value
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''));
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines;
  };

  const want = normalize(expected);
  const got = normalize(actual);
  const mismatch = want.findIndex((line, index) => line !== (got[index] ?? '\u0000'));

  if (mismatch === -1 && want.length === got.length) {
    return `回读比对：${want.length} 行与目标一致`;
  }
  const at = mismatch === -1 ? Math.min(want.length, got.length) : mismatch;
  const brief = (line: string | undefined) =>
    line === undefined ? '（没有这一行）' : line.length > 40 ? `${line.slice(0, 40)}…` : line;
  return `回读比对：与目标不一致（第 ${at + 1} 行起），期望「${brief(want[at])}」，实际「${brief(got[at])}」`;
}

function describeNow(): string {
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${date} ${time}（${weekdays[now.getDay()]}）`;
}
