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
import { diffLines, diffStats } from '../shared/diff';
import type { DiffPayload, TokenUsage } from '../shared/messages';

export interface ToolOutcome {
  output: string;
  isError: boolean;
  /** diff 工具带这个，卡片左右对照显示 */
  diff?: DiffPayload;
}

export interface AgentEvents {
  onDelta: (text: string) => void;
  onToolStart: (call: { callId: string; name: string; args: string }) => void;
  onToolEnd: (callId: string, result: string, isError: boolean, diff?: DiffPayload) => void;
  onNotice: (text: string) => void;
  /** 每轮结束把累计 token 用量报给面板（接口没回传 usage 时不报） */
  onUsage: (usage: TokenUsage) => void;
  /** 需要页面上下文才能执行的工具（url / write_document），交给 content script 做 */
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  /** ask 工具：把选择题发给面板，等用户点选 */
  askUser: (callId: string, question: string, options: string[]) => Promise<string>;
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
  // 一轮对话往往要多次请求模型，用量累加起来才是这一轮真实花掉的 token
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const { content, toolCalls, usage: roundUsage } = await streamChat({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL,
      model: settings.model,
      messages: conversation,
      tools: TOOL_SCHEMAS,
      signal,
      onDelta: events.onDelta,
    });

    if (roundUsage) {
      usage.promptTokens += roundUsage.promptTokens;
      usage.completionTokens += roundUsage.completionTokens;
      usage.totalTokens += roundUsage.totalTokens;
      events.onUsage({ ...usage });
    }

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
        callId: call.id,
        signal,
        runPageTool: events.runPageTool,
        askUser: events.askUser,
      });
      events.onToolEnd(call.id, outcome.output, outcome.isError, outcome.diff);
      // 工具执行期间用户点了「停止」：不再喂下一轮，直接按中止收尾
      if (signal.aborted) throw new DOMException('用户停止了生成', 'AbortError');
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
  /** 当前这次工具调用的 id：ask 要用它把问题和面板上的卡片对上 */
  callId: string;
  signal: AbortSignal;
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  askUser: (callId: string, question: string, options: string[]) => Promise<string>;
}

/** 单次执行一个工具（agent loop 用它，设置页的模拟输入测试也用它，保证两条路完全一致） */
export async function runTool(
  name: string,
  rawArguments: string,
  context: ToolContext,
): Promise<ToolOutcome> {
  const { tabId, signal, runPageTool } = context;
  if (!isToolName(name)) {
    return { output: `没有名为 ${name} 的工具，可用工具：${TOOL_NAMES.join('、')}`, isError: true };
  }

  const parsed = parseToolArguments(rawArguments);
  if (!parsed.ok) return { output: parsed.error, isError: true };
  const args = parsed.args;

  if (name === 'date') return { output: describeNow(), isError: false };

  if (name === 'ask') {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const options = Array.isArray(args.options)
      ? args.options
          .filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
          .map((option) => option.trim())
          .slice(0, 6)
      : [];
    if (!question || options.length < 2) {
      return { output: 'ask 需要一个 question 和至少两个 options', isError: true };
    }
    const choice = await context.askUser(context.callId, question, options);
    return { output: `用户选择了「${choice}」`, isError: false };
  }

  if (name === 'diff') {
    const left = typeof args.left === 'string' ? args.left : '';
    const right = typeof args.right === 'string' ? args.right : '';
    const leftLabel = typeof args.leftLabel === 'string' && args.leftLabel ? args.leftLabel : '改动前';
    const rightLabel = typeof args.rightLabel === 'string' && args.rightLabel ? args.rightLabel : '改动后';
    const stats = diffStats(diffLines(left, right));
    return {
      output: `差异：新增 ${stats.added} 行，修改 ${stats.changed} 行，删除 ${stats.removed} 行（左右对照已展示给用户）`,
      isError: false,
      diff: { left, right, leftLabel, rightLabel },
    };
  }

  if (name === 'js_inject') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const result = await injectScript(tabId, code, undefined, undefined, signal);
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
    // 这两条会轮询到出结论为止，页面里的等待时间必须比页面超时留得久
    const defaults: Record<string, number> = { submit_answer: 20, read_judge_result: 60 };
    const fallback = defaults[name];
    const asked = Number(args.waitSeconds);
    const waitSeconds = fallback === undefined
      ? undefined
      : Math.min(Math.max(Number.isFinite(asked) && asked > 0 ? asked : fallback, name === 'submit_answer' ? 5 : 0), 120);
    const timeout = waitSeconds === undefined ? undefined : (waitSeconds + 20) * 1000;
    const result = await injectScript(tabId, PTA_SCRIPTS[name], args, timeout, signal);
    if (!result.ok) return { output: result.output, isError: true };
    return { output: result.output, isError: false };
  }

  if (name === 'simulate_keyboard_input') {
    // 不再受任何开关管制：要真按键就直接用调试器，attach 失败由 typeWithDebugger 自己兜底
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
