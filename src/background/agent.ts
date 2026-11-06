import {
  MAX_TOOL_ROUNDS,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  isToolName,
  parseToolArguments,
  truncate,
} from '../shared/tools';
import { abortable, isAbortError, throwIfAborted } from '../shared/abort';
import type { ApiMessage } from '../shared/types';
import { compileAndRun, compareOutput, formatCompileResult, type CompileResult } from './compile';
import { compileAndRunJs } from './compile';
import { compileAndRunPython } from './compile';
import { ext } from '../shared/browser';
import { pokeEditor as poke, readEditorCode, writeEditorCode } from './input-methods';
import { createDebuggerIo, detach, pressKey } from './debugger-input';
import {
  CHECK_READY_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  LANGUAGE_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
  READ_PTA_COMPILE_RESULT_SCRIPT,
  SIMULATE_PTA_RUN_SCRIPT,
} from './pta-scripts';
import { describeTypist, runTypist } from './typist';

const DEFAULT_PER_CHAR_DELAY_MS = 8;
import { streamChat } from './deepseek';
import { injectScript } from './js-inject';
import { loadSettings } from './settings';
import { modelSupportsVlm, statementHasImages } from '../shared/settings';
import { diffLines, diffStats } from '../shared/diff';
import {
  choiceDeniesSubmit,
  choiceDeniesWrite,
  parseOptionQuestion,
  submitGuardReason,
  writeGuardReason,
} from '../shared/guardrails';
import type { DiffPayload, TokenUsage } from '../shared/messages';

export interface ToolOutcome {
  output: string;
  isError: boolean;
  /** diff 工具带这个，卡片左右对照显示 */
  diff?: DiffPayload;
  /** 写入成功后的「自动 diff」：agent loop 用它额外合成一张 diff 卡片 */
  autoDiff?: DiffPayload;
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

  const lastUserText = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  // 护栏状态：每次 runAgent 对应用户的一条新消息；ask 的回答会更新 denied
  let askUsedThisTurn = false;
  let writeDenied = false;
  let submitDenied = false;
  // 本轮是否检测到图片、是否启用 VLM、是否已提示降级
  let problemHasImage = false;
  let vlmActiveForTurn = false;
  let remindedVlmDowngrade = false;
  let vlmHintPushed = false;
  let lastAutoDiffRight: string | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    // 用户随时可以按「停止」：上一轮工具刚收工还没发下一次请求时也要立刻退出
    throwIfAborted(signal);
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

    if (toolCalls.length === 0) {
      // 模型在正文里列了选项却没调 ask：把它解析成真的 ask 卡片，等用户点选后再继续
      const optionQuestion = askUsedThisTurn ? null : parseOptionQuestion(content);
      if (optionQuestion) {
        askUsedThisTurn = true;
        const autoAskId = `auto-ask-${round}`;
        events.onToolStart({ callId: autoAskId, name: 'ask', args: JSON.stringify(optionQuestion) });
        const choice = await events.askUser(autoAskId, optionQuestion.question, optionQuestion.options);
        if (choiceDeniesWrite(choice)) writeDenied = true;
        if (choiceDeniesSubmit(choice)) submitDenied = true;
        events.onToolEnd(autoAskId, `用户选择了「${choice}」`, false);
        conversation.push({
          role: 'assistant',
          content: content.trim() ? content : null,
          tool_calls: [
            {
              id: autoAskId,
              type: 'function',
              function: { name: 'ask', arguments: JSON.stringify(optionQuestion) },
            },
          ],
        });
        conversation.push({ role: 'tool', tool_call_id: autoAskId, content: `用户选择了「${choice}」` });
        throwIfAborted(signal);
        continue;
      }
      return;
    }

    conversation.push({
      role: 'assistant',
      content: content.trim() ? content : null,
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      throwIfAborted(signal);
      events.onToolStart({
        callId: call.id,
        name: call.function.name,
        args: call.function.arguments,
      });
      const toolName = call.function.name;
      // 硬门：没 ask 过（且用户本条没明确授权）时，直接拦下改代码/提交，逼模型先问
      const blockedReason =
        toolName === 'write_editor_code'
          ? writeGuardReason({ askUsed: askUsedThisTurn, denied: writeDenied, lastUserText })
          : toolName === 'submit_answer'
            ? submitGuardReason({ askUsed: askUsedThisTurn, denied: submitDenied, lastUserText })
            : null;

      let outcome: ToolOutcome;
      if (blockedReason) {
        outcome = { output: blockedReason, isError: true };
      } else {
        try {
          outcome = await runTool(call.function.name, call.function.arguments, {
            tabId,
            callId: call.id,
            signal,
            runPageTool: events.runPageTool,
            askUser: events.askUser,
          });
        } catch (error) {
          // 工具跑到一半被停：先给面板一个收尾（卡片不会一直转），再按中止退出这一轮
          if (!isAbortError(error, signal)) throw error;
          outcome = { output: '已停止', isError: true };
        }
      }

      if (toolName === 'ask' && !outcome.isError) {
        askUsedThisTurn = true;
        if (choiceDeniesWrite(outcome.output)) writeDenied = true;
        if (choiceDeniesSubmit(outcome.output)) submitDenied = true;
      }
      // VLM：读到题面后看是否包含图片占位，按设置决定是否按 VLM 模式工作。
      // 模型本身不看图时，先提醒一次降级，不阻断工具链。
      if (toolName === 'read_problem' && !outcome.isError) {
        problemHasImage = statementHasImages(outcome.output);
        if (problemHasImage) {
          const wantsVlm = settings.vlmMode === 'on' || settings.vlmMode === 'auto';
          if (wantsVlm && !modelSupportsVlm(settings.model)) {
            vlmActiveForTurn = false;
            if (!remindedVlmDowngrade) {
              events.onNotice(`题面包含图片，但当前模型（${settings.model}）不支持看图，已按纯文本模式处理。可在设置里把视觉模式改为 off，或换一台看图模型再试。`);
              remindedVlmDowngrade = true;
            }
          } else {
            vlmActiveForTurn = true;
          }
        }
      }
      if (vlmActiveForTurn && !vlmHintPushed) {
        conversation.push({ role: 'system', content: '【视觉模式】本题题面包含图片，当前模型支持看图，可结合图像内容理解题面。' });
        vlmHintPushed = true;
      }

      // 后台刚自动展示过同一份改动时，模型再调 diff 就不重复画一张
      let diffPayload = outcome.diff;
      if (toolName === 'diff' && diffPayload && lastAutoDiffRight !== null && diffPayload.right === lastAutoDiffRight) {
        diffPayload = undefined;
      }
      events.onToolEnd(call.id, outcome.output, outcome.isError, diffPayload);

      // 写入成功后自动合成一张 diff 卡片（用户一定看得到改动，不依赖模型自觉）
      if (outcome.autoDiff) {
        const auto = outcome.autoDiff;
        const autoDiffId = `auto-diff-${call.id}`;
        const stats = diffStats(diffLines(auto.left, auto.right));
        events.onToolStart({
          callId: autoDiffId,
          name: 'diff',
          args: JSON.stringify(auto),
        });
        events.onToolEnd(
          autoDiffId,
          `已自动展示本次改动：新增 ${stats.added} 行，修改 ${stats.changed} 行，删除 ${stats.removed} 行`,
          false,
          auto,
        );
        lastAutoDiffRight = auto.right;
      }
      // 工具执行期间用户点了「停止」：不再喂下一轮，直接按中止收尾
      throwIfAborted(signal);
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
  read_pta_compile_result: READ_PTA_COMPILE_RESULT_SCRIPT,
  simulate_pta_run: SIMULATE_PTA_RUN_SCRIPT,
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
  // 每个工具开始前先看一眼停止标记：这一轮已经被停掉就别再往页面里动手
  throwIfAborted(signal);
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
      // 编译最长能跑一分钟，中途被停也要立刻放手
      const result = await abortable(compileAndRun({ code, stdin, signal }), signal);
      return { output: formatCompileResult(result), isError: false };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (name === 'compile_and_run_js') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const stdin = typeof args.stdin === 'string' ? args.stdin : '';
    try {
      const result = await abortable(compileAndRunJs({ code, stdin, signal }), signal);
      return { output: formatCompileResult(result), isError: false };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (name === 'compile_and_run_python') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const stdin = typeof args.stdin === 'string' ? args.stdin : '';
    try {
      const result = await abortable(compileAndRunPython({ code, stdin, signal }), signal);
      return { output: formatCompileResult(result), isError: false };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (name === 'write_editor_code') {
    const notes: string[] = [];

    // 先留一份写入前的原文：写入成功后用它自动合成 diff 卡片（用户一定看得到改动）
    const beforeCode = await readEditorCode(tabId, signal);

    // 作答区选的语言要是 Python 2，先切成 Python 3：
    // 插件内置的 Python 运行器是 Python 3，模型写的也是 Python 3 的代码，
    // 不切的话提交过去 PTA 用 Python 2 编译，直接报「Non-zero Exit Code」
    const switched = await alignLanguage(tabId);
    if (switched) notes.push(switched);

    const outcome = await abortable(
      writeEditorCode({
        tabId,
        code: typeof args.code === 'string' ? args.code : '',
        signal,
      }),
      signal,
    );

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
      notes.push(await verifyWrittenCode(injectScript, tabId, args.code, signal));
    }

    // 自动 diff：写入前后的原文都拿到了才算（读不到就不硬造一张残缺的 diff）
    let autoDiff: DiffPayload | undefined;
    const written = typeof args.code === 'string' ? args.code : '';
    if (!outcome.isError && beforeCode !== null && written && beforeCode !== written) {
      const stats = diffStats(diffLines(beforeCode, written));
      autoDiff = {
        left: beforeCode,
        right: written,
        leftLabel: '改动前',
        rightLabel: '改动后',
      };
      notes.push(`改动已自动展示：新增 ${stats.added} 行，修改 ${stats.changed} 行，删除 ${stats.removed} 行`);
    }

    return {
      output: [outcome.output, ...notes].join('；'),
      isError: outcome.isError,
      ...(autoDiff ? { autoDiff } : {}),
    };
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
    // 等超时了要当成错误报给模型：它该知道自己没拿到结论，可以刷新页面再来
    if (name === 'submit_answer' || name === 'read_judge_result') {
      const timedOut = /还没出结论|还没读到能归一化成状态码/.test(result.output);
      if (timedOut) {
        return {
          output: result.output + '\n（等待超时。你有权调用 refresh_page 刷新页面，然后再调 read_judge_result 读一次；提交前记得先 close_dialogs 关掉提交结果 dialog。）',
          isError: true,
        };
      }
    }
    return { output: result.output, isError: false };
  }

  if (name === 'refresh_page') {
    try {
      await ext.tabs.reload(tabId);
      return { output: '已刷新页面。', isError: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { output: `刷新页面失败：${reason}`, isError: true };
    }
  }

  if (name === 'simulate_keyboard_input') {
    // 不再受任何开关管制：要真按键就直接用调试器，attach 失败由 typeWithDebugger 自己兜底
    return typeWithDebugger(args, tabId, runPageTool, signal);
  }

  // 其余工具需要页面上下文
  return abortable(runPageTool(name, args), signal);
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
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const text = typeof args.text === 'string' ? args.text : '';
  const press = typeof args.press === 'string' ? args.press.trim() : '';
  // 逐字敲可能要几十秒，聚焦 / 回读 / 敲键每一步都得能被「停止」打断
  const page = (params: Record<string, unknown>) =>
    abortable(runPageTool('simulate_keyboard_input', params), signal);

  const focused = await page({ ...args, focusOnly: true });
  if (focused.isError) return focused;

  const steps = [focused.output];
  try {
    if (text) {
      // 逐字敲，边敲边和编辑器的自动闭合 / 自动缩进对抗
      const stats = await abortable(
        runTypist(createDebuggerIo(tabId), text, perCharDelay(args), signal),
        signal,
      );
      steps.push(describeTypist(stats));
    }
    if (press) {
      await abortable(pressKey(tabId, press), signal);
      steps.push(`已用真实按键按下 ${press}`);
    }

    // 按键是异步生效的，不回读确认就是假成功
    if (text) {
      const readBack = await page({ selector: args.selector, readOnly: true });
      if (!readBack.isError) steps.push(compareTyped(text, readBack.output));
    }

    return { output: steps.join('；'), isError: false };
  } catch (error) {
    // 被用户停掉的输入不该再退回模拟事件接着敲
    if (isAbortError(error, signal)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await page(args);
    return {
      output: `调试器输入失败（${reason}），已退回模拟事件：${fallback.output}`,
      isError: fallback.isError,
    };
  } finally {
    // 横幅只在真正输入的这一小会儿出现
    await detach(tabId);
  }
}

/** 页面语言脚本返回的结构 */
interface LanguageInfo {
  language: string;
  ok?: boolean;
  detail?: string;
}

/** 解析页面语言脚本的返回值（它跑在页面里，返回值是 JSON 字符串） */
function parseLanguageInfo(output: string): LanguageInfo {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object') return { language: '' };
    const info: LanguageInfo = { language: '' };
    if ('language' in parsed && typeof parsed.language === 'string') info.language = parsed.language;
    if ('ok' in parsed && typeof parsed.ok === 'boolean') info.ok = parsed.ok;
    if ('detail' in parsed && typeof parsed.detail === 'string') info.detail = parsed.detail;
    return info;
  } catch {
    return { language: '' };
  }
}

/**
 * 作答区选的语言是 Python 2 时，把它切成 Python 3。
 *
 * 有些题被题组配置成了 Python 2（页面上写「Python (python2)」），而插件内置的
 * Python 运行器和模型写的代码都是 Python 3 的：不切的话本地自测通过，提交过去
 * PTA 用 Python 2 编译，直接判「Non-zero Exit Code」。
 */
async function alignLanguage(tabId: number): Promise<string> {
  try {
    const read = await injectScript(tabId, LANGUAGE_SCRIPT, undefined, undefined, undefined);
    if (parseLanguageInfo(read.output).language !== 'python2') return '';
    const switched = await injectScript(tabId, LANGUAGE_SCRIPT, { target: 'python3' }, undefined, undefined);
    const result = parseLanguageInfo(switched.output);
    if (result.ok) return result.detail ?? '作答语言已切到 Python 3';
    return `注意：这道题被配置成了 Python 2，切不到 Python 3（${result.detail ?? '下拉里没有'}）。`
      + '本地运行器是 Python 3，自测结果可能和 PTA 实际编译的不一致；代码要按 Python 2 的写法来。';
  } catch {
    return '';
  }
}

/** 语言名（用于给模型看的人话） */
function langLabel(language: string): string {
  switch (language) {
    case 'python':
    case 'python2':
    case 'python3': return 'Python';
    case 'js': return 'JavaScript';
    case 'c': return 'C';
    default: return language || '未知语言';
  }
}

/** 页面上没认得出语言时，按代码长相猜一个（宁可不猜，也不要把 Python 当 C 报编译失败） */
function guessLanguage(code: string): string {
  if (/^\s*(#include|int\s+main\s*\()/m.test(code)) return 'c';
  if (/^\s*(def |import |print\s*\(|class |if\s+__name__)/m.test(code)) return 'python';
  if (/^\s*(function |const |let |var |console\.)/m.test(code)) return 'js';
  return 'c';
}

/** 按语言跑一遍代码，返回统一的编译结果 */
async function runWithLanguage(
  language: string,
  code: string,
  stdin: string,
  signal: AbortSignal,
): Promise<CompileResult> {
  if (language === 'python' || language === 'python2' || language === 'python3') {
    return compileAndRunPython({ code, stdin, signal });
  }
  if (language === 'js') return compileAndRunJs({ code, stdin, signal });
  return compileAndRun({ code, stdin, signal });
}

/**
 * 写入后的自动检查：拿页面上的样例把刚写的代码编译一遍并对输出，
 * 再看提交按钮现在可用不可用（确认页面认了这次修改）。
 *
 * 编译比对必须按**页面上选定的语言**走：PTA 的题目大部分是 Python，
 * 一律按 C 编译会把好好的 Python 代码报成「编译失败」，那是假的。
 */
async function verifyWrittenCode(
  inject: typeof injectScript,
  tabId: number,
  code: unknown,
  signal: AbortSignal,
): Promise<string> {
  const source = typeof code === 'string' ? code : '';
  const checks: string[] = [];

  // 1) 样例编译并比对输出（用第一组样例，避免每次都多跑一遍）
  try {
    const samplesRaw = await inject(tabId, READ_PROBLEM_SCRIPT, { samplesOnly: true }, undefined, signal);
    const parsed = JSON.parse(samplesRaw.output) as {
      samples?: { input: string; output: string }[];
      language?: string;
    };
    const sample = parsed.samples?.[0];
    const language = parsed.language ?? '';
    if (!sample) {
      checks.push('自动检查：题面里没识别出样例，跳过编译比对');
    } else {
      // 按题目语言挑编译器；语言认不出来时按代码长相猜一下
      const lang = language || guessLanguage(source);
      const compiled = await abortable(runWithLanguage(lang, source, sample.input, signal), signal);
      if (compiled.compileOutput) {
        checks.push(`自动检查：${langLabel(lang)}编译失败——${compiled.compileOutput.split('\n')[0]}`);
      } else if (!compiled.ok) {
        checks.push(`自动检查：${langLabel(lang)}运行返回 ${compiled.statusText}`);
      } else {
        const diff = compareOutput(sample.output, compiled.stdout);
        checks.push(
          diff.same
            ? `自动检查：样例 1（${langLabel(lang)}，输入 ${JSON.stringify(sample.input.trim())}）输出一致`
            : `自动检查：样例 1 输出不一致——${diff.detail}`,
        );
      }
    }
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    checks.push(`自动检查：编译比对没做成（${reason}）`);
  }

  // 2) 提交按钮可用性
  try {
    const ready = await inject(tabId, CHECK_READY_SCRIPT, undefined, undefined, signal);
    checks.push(`页面状态：${ready.output}`);
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
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
