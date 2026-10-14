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
import { compileAndRun, compareOutput, formatCompileResult } from './compile';
import { pokeEditor as poke, writeEditorCode } from './input-methods';
import { createDebuggerIo, detach, pressKey } from './debugger-input';
import {
  CHECK_READY_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
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
      const outcome = await runTool(call.function.name, call.function.arguments, {
        tabId,
        settings,
        runPageTool: events.runPageTool,
      });
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

const PTA_SCRIPTS: Record<string, string> = {
  check_ready: CHECK_READY_SCRIPT,
  read_problem: READ_PROBLEM_SCRIPT,
  read_editor_code: READ_EDITOR_SCRIPT,
  submit_answer: SUBMIT_ANSWER_SCRIPT,
  read_judge_result: READ_JUDGE_SCRIPT,
  close_dialogs: CLOSE_DIALOGS_SCRIPT,
};

export interface ToolContext {
  tabId: number;
  settings: Settings;
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** 单次执行一个工具（agent loop 用它，设置页的模拟输入测试也用它，保证两条路完全一致） */
export async function runTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolOutcome> {
  const { tabId, settings, runPageTool } = context;
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
      const result = await compileAndRun({ code, stdin });
      return { output: formatCompileResult(result), isError: false };
    } catch (error) {
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (name === 'write_editor_code') {
    // 写入走完整链路：默认实现 → 清空 → 备用实现依次重试
    const outcome = await writeEditorCode({
      tabId,
      code: typeof args.code === 'string' ? args.code : '',
    });
    const notes: string[] = [];

    // 整段写入走的是编辑器状态，PTA 可能没标成「改过」；无条件尝试用真实按键戳一下
    try {
      notes.push(await poke(tabId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push(`真实按键不可用（${reason}），如果提交按钮是灰的，让用户手动在作答区敲一个字符再删掉`);
    } finally {
      await detach(tabId);
    }

    // 自动检查：回读比对已在链路里做过，这里补样例编译比对与提交按钮状态
    if (args.verify !== false) {
      notes.push(await verifyWrittenCode(injectScript, tabId, args.code));
    }

    return { output: [outcome.output, ...notes].join('；'), isError: outcome.isError };
  }

  // PTA 相关动作都在页面主世界跑（编辑器实例、判题弹窗都是页面自己的东西）
  if (PTA_SCRIPTS[name]) {
    const waitSeconds = Math.min(Math.max(Number(args.waitSeconds) || 20, 5), 120);
    // 等判题的脚本要在页面里跑很久，给它留够时间
    const timeout = name === 'submit_answer' ? (waitSeconds + 20) * 1000 : undefined;
    const result = await injectScript(tabId, PTA_SCRIPTS[name], args, timeout);
    if (!result.ok) return { output: result.output, isError: true };
    return { output: result.output, isError: false };
  }

  if (name === 'simulate_keyboard_input' && settings.useDebuggerInput) {
    return typeWithDebugger(args, tabId, runPageTool);
  }

  // 其余工具需要页面上下文
  return runPageTool(name, args);
}

/**
 * 开了「真实按键」开关时：先让页面把焦点放到目标元素上（顺带按需选中全部内容以便替换），
 * 再用 CDP 输入文本 / 按键，事件是 trusted 的。
 * CDP 用不了（DevTools 占着、浏览器不支持）就退回 DOM 事件，并说明原因。
 */
async function typeWithDebugger(
  args: Record<string, unknown>,
  tabId: number,
  runPageTool: ToolContext['runPageTool'],
): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text : '';
  const press = typeof args.press === 'string' ? args.press.trim() : '';

  const focused = await runPageTool('simulate_keyboard_input', { ...args, focusOnly: true });
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
      const readBack = await runPageTool('simulate_keyboard_input', {
        selector: args.selector,
        readOnly: true,
      });
      if (!readBack.isError) steps.push(compareTyped(text, readBack.output));
    }

    return { output: steps.join('；'), isError: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await runPageTool('simulate_keyboard_input', args);
    return {
      output: `调试器输入失败（${reason}），已退回模拟事件：${fallback.output}`,
      isError: fallback.isError,
    };
  } finally {
    // 横幅只在真正输入的这一小会儿出现
    await detach(tabId);
  }
}

/**
 * 写入后的自动检查：拿页面上的样例把刚写的代码编译一遍并对输出，
 * 再看提交按钮现在可用不可用（确认页面认了这次修改）。
 */
async function verifyWrittenCode(
  inject: typeof injectScript,
  tabId: number,
  code: unknown,
): Promise<string> {
  const source = typeof code === 'string' ? code : '';
  const checks: string[] = [];

  // 1) 样例编译并比对输出（用第一组样例，避免每次都多跑一遍）
  try {
    const samplesRaw = await inject(tabId, READ_PROBLEM_SCRIPT, { samplesOnly: true });
    const parsed = JSON.parse(samplesRaw.output) as {
      samples?: { input: string; output: string }[];
    };
    const sample = parsed.samples?.[0];
    if (!sample) {
      checks.push('自动检查：题面里没识别出样例，跳过编译比对');
    } else {
      const compiled = await compileAndRun({ code: source, stdin: sample.input });
      if (compiled.compileOutput) {
        checks.push(`自动检查：编译失败——${compiled.compileOutput.split('\n')[0]}`);
      } else if (!compiled.ok) {
        checks.push(`自动检查：内置编译器返回 ${compiled.statusText}`);
      } else {
        const diff = compareOutput(sample.output, compiled.stdout);
        checks.push(
          diff.same
            ? `自动检查：样例 1（输入 ${JSON.stringify(sample.input.trim())}）输出一致`
            : `自动检查：样例 1 输出不一致——${diff.detail}`,
        );
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    checks.push(`自动检查：编译比对没做成（${reason}）`);
  }

  // 2) 提交按钮可用性
  try {
    const ready = await inject(tabId, CHECK_READY_SCRIPT);
    checks.push(`页面状态：${ready.output}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    checks.push(`页面状态没读到（${reason}）`);
  }

  return checks.join('；');
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
