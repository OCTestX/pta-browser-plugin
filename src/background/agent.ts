import {
  MAX_TOOL_ROUNDS,
  SYSTEM_PROMPT,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  isToolName,
  parseToolArguments,
  truncate,
  TOOL_RESULT_LIMITS,
} from '../shared/tools';
import { abortable, isAbortError, throwIfAborted } from '../shared/abort';
import type { ApiMessage } from '../shared/types';
import { asStdin, compileAndRun, compileAndRunCpp, checkCode, compareOutput, formatCompileResult, type CompileResult } from './compile';
import { compileAndRunJs } from './compile';
import { compileAndRunPython } from './compile';
import { ext } from '../shared/browser';
import { pokeEditor as poke, readEditorCode, writeEditorCode } from './input-methods';
import { createDebuggerIo, detach, pressKey } from './debugger-input';
import {
  CHECK_READY_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  LANGUAGE_SCRIPT,
  NEXT_PROBLEM_SCRIPT,
  LIST_PROBLEMS_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
  READ_PTA_COMPILE_RESULT_SCRIPT,
  SIMULATE_PTA_RUN_SCRIPT,
  WRITE_ANSWERS_SCRIPT,
} from './pta-scripts';
import { describeTypist, runTypist } from './typist';
import { storeExplanation } from './explain-pages';
import { batchStats, batchSummary, recordVerdict, resetBatch, setCurrentProblem } from './batch-progress';
import { compactConversation } from '../shared/context-window';

const DEFAULT_PER_CHAR_DELAY_MS = 8;
/**
 * 赶题模式（/fuck）允许的工具轮数。
 *
 * 平时 80 轮只够做一道题；赶题模式要连着做完整个题目列表，
 * 每道题大概要 5 轮（读题、编译、写代码、提交、看结论、换题），300 轮够做几十题。
 */
const FUCK_MAX_TOOL_ROUNDS = 300;
import { streamChat } from './deepseek';
import { injectScript } from './js-inject';
import { loadSettings } from './settings';
import { statementHasImages } from '../shared/settings';
import {
  decideVisionMode,
  extractImageUrls,
  visionUserMessage,
  type VisionApiMessage,
} from '../shared/model-capabilities';
import { buildConversation, commandForcesWrite, parseSlashCommand } from '../shared/commands';
import { diffLines, diffStats } from '../shared/diff';
import {
  choiceDeniesSubmit,
  choiceDeniesWrite,
  parseOptionQuestion,
  submitGuardReason,
  whyToolBlockReason,
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
 * 斜杠指令对应的补充说明，塞进这一轮的上下文里改写模型的行为。
 *
 * /new 由前端直接开新会话（不发消息），这里不处理。
 */
function commandInstruction(id: string, rest: string): string {
  const extra = rest ? `\n用户补充：${rest}` : '';
  if (id === 'resolve') {
    return [
      '【本轮指令 /resolve】用户要你直接把这道题做出来。',
      '这一轮不用再问「要不要我改 / 要不要我提交」：先读题面（read_problem），写出代码，',
      '用 compile_and_run_* 或 simulate_pta_run 跑一遍样例确认，然后写进作答区（write_editor_code）并提交（submit_answer）。',
      '题目是选择题或判断题时，read_problem 会把所有小题和选项列出来，',
      '你把答案用空格分隔后交给 write_editor_code 填进去。',
      '做完把结论说清楚就行。' + extra,
    ].join('\n');
  }
  if (id === 'why') {
    return [
      '【本轮指令 /why】用户要你讲清楚他现在的代码错在哪里。',
      '先 read_editor_code 读出作答区里现在的代码，再 read_problem 看题目要求，',
      '然后指出：错在哪一行、为什么会错、正确写法是什么、怎么验证。',
      '这一轮只讲解，不要改代码、不要提交。',
      '不要调用 js_inject 翻页面/侧栏/判题记录，也不要调 read_judge_result；',
      '只允许 read_editor_code、read_problem 和 compile_and_run_* 做本地验证。',
      '如果代码能通过样例、没有明显错误，就直接说「代码没有发现错误」，',
      '不要为了找错误去翻判题历史、侧栏状态或测试点。' + extra,
    ].join('\n');
  }
  if (id === 'fuck') {
    return [
      '【本轮指令 /fuck】用户开了「极限赶时间无人监管模式」。规矩只有几条：',
      '不要解释、不要寒暄、不要问问题——直接做题。',
      '每道题按这个顺序做完：read_problem 读题 → write_editor_code 写代码 →',
      'compile_and_run_c/python/js（或 simulate_pta_run）拿样例验一遍 → submit_answer 提交 → read_judge_result 看结论；',
      '拿到判题结论后调 next_problem 切到下一题，接着做下一道；',
      'next_problem 会自动跳过已经提交过的题，当前题型做完了也会自动切到下一个题型（判断/选择/代码填空/编程），',
      '所以你只要一直调 next_problem 就行，不用自己管侧栏；它说「已经是最后一题了」就停，',
      '用一句话汇总：做了几题、过了几题、哪几题没过。',
      '**代码填空题**：作答区里就是那段代码（要填的地方是空的或带 TODO），',
      '先 read_editor_code 把作答区现在的代码读出来，在它基础上把空缺补完整，再用 write_editor_code 写回去——不要凭空重写整段。',
      '一道题最多自己改两次；还是不过就调 next_problem（带 skipCurrent=true）跳过它，继续下一题。',
      '用户随时能按「停止」打断，你不用管，也别解释你在干什么。' + extra,
    ].join('\n');
  }
  if (id === 'what') {
    return [
      '【本轮指令 /what】用户要一份苏格拉底式的讲解网页（不是干巴巴的题解）。',
      '做这几步：',
      '1. read_problem 拿到题面、样例与边界条件；',
      '2. 设计一份自包含的单文件 HTML：围绕这道题出 10–12 道选择题，分 4 个阶段（看懂过程 / 找出规律 / 边界与实现 / 用样例验算），',
      '   每题 4 个选项、只有 1 个正确，干扰项要来自真实误区，正确项不要永远放 A；',
      '   答错要锁住那个选项并给分级提示（一级指向观察、二级指向机制、三级给具体小例子，提示里不能出现正确答案），答对才给解释；',
      '   再配一个可交互的动态演示（可改参数、能看出累计量怎么变），演示的默认值不要用样例数据，免得提前剧透；',
      '   页面不引 CDN、不引外部字体，样式写在 <style> 里、逻辑写在 <script> 里；',
      '3. 用 write_explanation_page 把整份 HTML 交上来（标题也给一个），插件会给用户一张「打开讲解页」的邀请卡片。',
      '不要把整份 HTML 贴进回答里。' + extra,
    ].join('\n');
  }
  return '';
}

/**
 * 赶题模式里替用户回答模型抛出来的问题。
 *
 * 选项里凡是「不要改 / 先别提交」这类都跳过，挑剩下的第一个（通常是「要」或「直接做」）。
 * 一个都没有就退回第一个选项——反正没人在线等，答错也比卡住强。
 */
function pickAutoAnswer(options: string[]): string {
  const allow = options.find(
    (option) => !choiceDeniesWrite(option) && !choiceDeniesSubmit(option),
  );
  return allow ?? options[0] ?? '做';
}

/** 视觉模式判定后追加在 read_problem 结果末尾的说明：让模型知道自己没看到图 */
const VISION_OFF_NOTE =
  '\n（视觉模式已关闭：上面的图片没有作为图像输入发给你，不要假装看过图。'
  + '需要读图时请让用户把设置里的视觉模式改成「自动」或「开」。）';
const VISION_UNSUPPORTED_NOTE =
  '\n（当前模型不支持图像输入：上面的图片没有发给你，不要假装看过图，只能依据图片的 alt/标题文字推断。）';
const VISION_UNSENDABLE_NOTE =
  '\n（题面里的图片是内嵌 data: URI，插件拿不到可发送的地址，没有真正发图；不要假装看过图。）';

/**
 * 把视觉消息塞进 conversation。
 *
 * ApiMessage 的 content 只声明了字符串（content script 拼出来的消息都是字符串），
 * 视觉消息在运行时是 OpenAI 兼容的内容块数组。这是全项目唯一需要放宽类型的地方，
 * 断言只留在这一处，别处继续按 ApiMessage 使用。
 */
function pushVisionMessage(conversation: ApiMessage[], message: VisionApiMessage): void {
  conversation.push(message as unknown as ApiMessage);
}

/** 题面里的图片可能是相对地址：拿标签页地址补全 */
async function currentTabUrl(tabId: number): Promise<string | undefined> {
  try {
    const tab = await ext.tabs.get(tabId);
    return typeof tab?.url === 'string' ? tab.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * agent loop：请求模型 → 如果它要调工具就执行 → 把结果回灌 → 再来一轮，直到它给出最终回答。
 * 最多 MAX_TOOL_ROUNDS 轮，防止模型来回刷工具。
 */
export async function runAgent(options: RunAgentOptions): Promise<void> {
  const { messages, tabId, signal, events } = options;
  const settings = await loadSettings();

  // 斜杠指令（/resolve、/fuck、/why、/what…）：改写这一轮的行为
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
  const command = parseSlashCommand(lastUserMessage?.content ?? '');
  // 指令说明必须并进开头的 system；追加到 user/assistant 后面会被接口拒绝（HTTP 400）
  const instruction = command ? commandInstruction(command.id, command.rest) : '';
  const conversation: ApiMessage[] = buildConversation(SYSTEM_PROMPT, messages, instruction) as ApiMessage[];
  // /fuck：极限赶时间无人监管模式——不问、不解释、直接提交、做完自动切下一题
  const fuckMode = command?.id === 'fuck';
  // /resolve 与 /fuck：用户明说「直接答题」，这一轮不再要求先 ask
  const forced = commandForcesWrite(command?.id);
  // 赶题模式要连着做完整个题目列表，工具轮数得放开（平时 80 轮只够做一道题）
  const maxRounds = fuckMode ? FUCK_MAX_TOOL_ROUNDS : MAX_TOOL_ROUNDS;
  if (fuckMode) {
    // 面板上给个明确的横幅：这个模式会自己往下做，用户想插手就按「停止」
    resetBatch(tabId);
    events.onNotice('赶题模式开始：直接做题、直接提交，做完自动切到下一题。按「停止」可以随时打断。');
  }
  // 一轮对话往往要多次请求模型，用量累加起来才是这一轮真实花掉的 token
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const lastUserText = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  // 护栏状态：每次 runAgent 对应用户的一条新消息；ask 的回答会更新 denied
  let askUsedThisTurn = false;
  let writeDenied = false;
  let submitDenied = false;
  // 本轮是否检测到图片、是否真的把图发给了模型、降级/关闭提示是否已经说过
  let problemHasImage = false;
  let vlmActiveForTurn = false;
  let vlmNoticeShown = false;
  // 已经发过的图片地址：同一张图不要在后续轮次里重复发
  const sentImageUrls = new Set<string>();
  let lastAutoDiffRight: string | null = null;

  for (let round = 0; round < maxRounds; round += 1) {
    // 用户随时可以按「停止」：上一轮工具刚收工还没发下一次请求时也要立刻退出
    throwIfAborted(signal);
    // 赶题模式一跑几十题，旧工具结果会把上下文撑爆；只保留系统提示 + 最近一段
    compactConversation(conversation);
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
        // 赶题模式不等人：模型在正文里问「要不要我改」，替用户答一个「做」
        const choice = fuckMode
          ? pickAutoAnswer(optionQuestion.options)
          : await events.askUser(autoAskId, optionQuestion.question, optionQuestion.options);
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

    // 同一条 assistant 消息可能带多个 tool_call：图片消息要等这一批工具结果全部回灌完再发，
    // 否则 user 消息会插在 assistant(tool_calls) 与后面的 tool 结果之间，接口会拒绝这种历史。
    const pendingImageUrls: string[] = [];
    for (const call of toolCalls) {
      throwIfAborted(signal);
      events.onToolStart({
        callId: call.id,
        name: call.function.name,
        args: call.function.arguments,
      });
      const toolName = call.function.name;
      // 硬门：没 ask 过（且用户本条没明确授权）时，直接拦下改代码/提交，逼模型先问
      const commandBlocked = command?.id === 'why' ? whyToolBlockReason(toolName) : null;
      const blockedReason = commandBlocked ??
        (toolName === 'write_editor_code'
          ? writeGuardReason({ askUsed: askUsedThisTurn, denied: writeDenied, lastUserText, forced })
          : toolName === 'submit_answer'
            ? submitGuardReason({ askUsed: askUsedThisTurn, denied: submitDenied, lastUserText, forced })
            : null);

      let outcome: ToolOutcome;
      if (fuckMode && toolName === 'ask') {
        // 赶题模式不等人：模型要问就自己答一个「做」，不等面板上的卡片
        outcome = { output: '用户选择了「做」', isError: false };
      } else if (blockedReason) {
        outcome = { output: blockedReason, isError: true };
      } else {
        try {
          outcome = await runTool(call.function.name, call.function.arguments, {
            tabId,
            callId: call.id,
            signal,
            runPageTool: events.runPageTool,
            askUser: events.askUser,
            onBatchNotice: fuckMode ? events.onNotice : undefined,
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
      // 视觉输入：read_problem 把图片摊平成 [图片… <url>]，这里按设置决定是否真的发图。
      // 只有「auto/on + 模型支持看图 + 拿到可发送的 http(s) 地址」才构造 image_url 内容块；
      // 其余情况都给模型一句明确的「没有发图」，不能让它假装看过图。
      if (toolName === 'read_problem' && !outcome.isError) {
        problemHasImage = statementHasImages(outcome.output);
        if (problemHasImage) {
          const decision = decideVisionMode({
            mode: settings.vlmMode,
            model: settings.model,
            hasImages: true,
          });
          if (decision === 'active') {
            const { urls } = extractImageUrls(outcome.output, await currentTabUrl(tabId));
            const fresh = urls.filter((url) => !sentImageUrls.has(url));
            if (fresh.length > 0) {
              vlmActiveForTurn = true;
              for (const url of fresh) sentImageUrls.add(url);
              pendingImageUrls.push(...fresh);
            } else if (urls.length === 0 && pendingImageUrls.length === 0) {
              // 题面里的图只有内嵌 data: URI（或没有 src）：拿不到可发送的地址
              vlmActiveForTurn = false;
              outcome = { ...outcome, output: outcome.output + VISION_UNSENDABLE_NOTE };
              if (!vlmNoticeShown) {
                events.onNotice('题面包含图片，但图片是内嵌 data: URI，插件拿不到可发送的图片地址，已按纯文本处理（模型没有看到图）。');
                vlmNoticeShown = true;
              }
            }
          } else if (decision === 'off') {
            // 用户明确关掉了视觉模式：就算模型能看图也不发，更不能提示「支持看图」
            vlmActiveForTurn = false;
            outcome = { ...outcome, output: outcome.output + VISION_OFF_NOTE };
            if (!vlmNoticeShown) {
              events.onNotice('视觉模式已关闭（off）：题面里的图片不会发给模型，已按纯文本处理。要识别题面图片，请把设置里的视觉模式改成「自动」或「开」。');
              vlmNoticeShown = true;
            }
          } else {
            // 设置想看图，但当前模型不支持：提示一次降级，不阻断工具链
            vlmActiveForTurn = false;
            outcome = { ...outcome, output: outcome.output + VISION_UNSUPPORTED_NOTE };
            if (!vlmNoticeShown) {
              events.onNotice(`题面包含图片，但当前模型（${settings.model}）不支持看图，已按纯文本模式处理。可在设置里把视觉模式改为 off，或换一台看图模型再试。`);
              vlmNoticeShown = true;
            }
          }
        }
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
        content: truncate(outcome.output, TOOL_RESULT_LIMITS[toolName as keyof typeof TOOL_RESULT_LIMITS]),
      });
    }

    // 所有 tool 结果都回灌完了，再发图像消息：assistant(tool_calls) → tool… → user(图片) 才是合法顺序。
    // 这里发的是真正的 OpenAI 兼容 image_url 内容块，不是文本占位。
    if (vlmActiveForTurn && pendingImageUrls.length > 0) {
      pushVisionMessage(
        conversation,
        visionUserMessage(
          `【视觉模式】以下图片由插件自动附上（不是用户的新请求）：read_problem 读到的题面图片（${pendingImageUrls.length} 张），`
          + '请结合图片内容理解题面（图片里的公式、示意图、函数图像等）。',
          pendingImageUrls,
        ),
      );
    }
  }

  events.onNotice(`已经连续调用 ${maxRounds} 轮工具了，先停在这里。可以让我继续。`);
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
  next_problem: NEXT_PROBLEM_SCRIPT,
  list_problems: LIST_PROBLEMS_SCRIPT,
  set_language: LANGUAGE_SCRIPT,
};

export interface ToolContext {
  tabId: number;
  /** 当前这次工具调用的 id：ask 要用它把问题和面板上的卡片对上 */
  callId: string;
  signal: AbortSignal;
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  askUser: (callId: string, question: string, options: string[]) => Promise<string>;
  /** 赶题模式里把进度推给面板（横幅） */
  onBatchNotice?: (text: string) => void;
}

/**
 * 在 PTA 页面主世界里跑一个页面脚本（题面、代码、提交、判题、模拟运行、编译输出）。
 * 「强制用 PTA 运行环境」时，内置编译器的调用也会转到这里来。
 */
async function runPtaScript(
  name: keyof typeof PTA_SCRIPTS,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolOutcome> {
  const { tabId, signal } = context;
  // 这两条会轮询到出结论为止，页面里的等待时间必须比页面超时留得久
  // next_problem 也要等页面换题（切题最多等 15 秒），所以同样得留够时间
  // simulate_pta_run 的页面脚本默认等 60 秒；注入层默认只有 15 秒，不在这里放宽会被硬砍
  const defaults: Record<string, number> = {
    submit_answer: 20,
    read_judge_result: 60,
    next_problem: 20,
    simulate_pta_run: 60,
  };
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

/** 「强制用 PTA 运行环境」这个开关开了没有 */
async function forcePtaRunEnabled(): Promise<boolean> {
  try {
    const settings = await loadSettings();
    return settings.forcePtaRun === true;
  } catch {
    return false;
  }
}

/**
 * 把一段代码交给 PTA 自己的编译器与机器跑。
 *
 * 走的正是 simulate_pta_run 那条路：展开测试面板 → 填数据集 → 点「运行测试」→ 读回结果；
 * 编译不过时结果里带的是 PTA「编译器输出」里的编译错误。
 * 区别只有一个：代码得先写进作答区（PTA 只能跑编辑器里的那份）。
 */
async function runOnPta(
  code: string,
  stdin: unknown,
  context: ToolContext,
  note = '（已按设置改用 PTA 自己的编译器与运行环境，不是插件内置的编译器）',
  language?: string,
): Promise<ToolOutcome> {
  const { tabId, signal } = context;
  if (language) {
    const switched = await injectScript(tabId, LANGUAGE_SCRIPT, { target: language }, undefined, signal);
    if (!switched.ok) {
      return { output: `没能把作答语言切到 ${language}：${switched.output}`, isError: true };
    }
  }
  const written = await abortable(writeEditorCode({ tabId, code, signal }), signal);
  if (written.isError) {
    return { output: `（改用 PTA 的运行环境）但代码没能写进作答区：${written.output}`, isError: true };
  }
  const outcome = await runPtaScript('simulate_pta_run', { stdin: asStdin(stdin) }, context);
  return {
    output: `${note}\n${outcome.output}`,
    isError: outcome.isError,
  };
}

/** 读这一页的题型（编程题 / 选择题 / 判断题…）；读不到就返回 null */
async function readProblemType(
  tabId: number,
  signal: AbortSignal,
): Promise<{ id: number; name: string; isChoice: boolean } | null> {
  try {
    const raw = await injectScript(tabId, READ_PROBLEM_SCRIPT, { typeOnly: true }, undefined, signal);
    if (!raw.ok) return null;
    const parsed = JSON.parse(raw.output) as {
      type?: { id: number; name: string; isChoice: boolean };
    };
    return parsed.type ?? null;
  } catch {
    return null;
  }
}

/** 把空格分隔的答案填进选择/判断题的单选框 */
async function writeChoiceAnswers(
  tabId: number,
  text: string,
  signal: AbortSignal,
): Promise<{
  filled: { index: number; token: string; text: string }[];
  problems: string[];
  total: number;
} | null> {
  try {
    const raw = await injectScript(tabId, WRITE_ANSWERS_SCRIPT, { text }, undefined, signal);
    if (!raw.ok) return null;
    return JSON.parse(raw.output) as {
      filled: { index: number; token: string; text: string }[];
      problems: string[];
      total: number;
    };
  } catch {
    return null;
  }
}

interface NextProblemResult {
  ok?: boolean;
  title?: string;
  url?: string;
  index?: number;
  total?: number;
  remaining?: number;
  reason?: string;
  type?: string;
  switchedType?: boolean;
  ready?: boolean;
}

function parseNextProblem(raw: string): NextProblemResult | null {
  try {
    return JSON.parse(raw) as NextProblemResult;
  } catch {
    return null;
  }
}

/** 从题目地址里取题目 ID：换题、读题两条路都用同一个 key 记账 */
function problemKeyFrom(url: string): string {
  const match = String(url || '').match(/problemSetProblemId=([^&#]+)/);
  if (!match) return String(url || '');
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 把 next_problem 脚本的 JSON 结果说成人话。
 *
 * 模型靠这句话决定还要不要继续做下一题，所以要把「还剩几题」讲清楚。
 * 走到题单末尾时把本轮统计也带上，模型不用自己数做过几题。
 */
function describeNextProblem(raw: string, summary = ''): string {
  const parsed = parseNextProblem(raw);
  if (!parsed) return raw;
  if (parsed.ok) {
    const position =
      typeof parsed.index === 'number' && typeof parsed.total === 'number'
        ? `（第 ${parsed.index + 1}/${parsed.total} 题）`
        : '';
    const left = typeof parsed.remaining === 'number' ? `，还剩 ${parsed.remaining} 题` : '';
    const switched = parsed.switchedType ? '（已切换题型）' : '';
    return `已切到下一题${switched}：${parsed.title ?? ''}${position}${left}。地址：${parsed.url ?? ''}`;
  }
  const tail = summary ? `\n\n${summary}` : '';
  return `没有下一题了：${parsed.reason ?? '题目列表已经走完'}${tail}`;
}

/** 读题工具的输出里带上标题/ID/地址，赶题统计靠它知道「现在在做哪道题」 */
function rememberProblemFromRead(tabId: number, output: string): void {
  const id = /(?:^|\n)题目 ID：(\S+)/.exec(output)?.[1];
  const url = /(?:^|\n)地址：(\S+)/.exec(output)?.[1];
  const title = /(?:^|\n)题目：(.+)/.exec(output)?.[1]?.trim();
  const type = (String(url || '').match(/\/problems\/type\/(\d+)/) || [])[1] || '';
  const key = id || problemKeyFrom(url || '') || title || '';
  if (key) setCurrentProblem(tabId, { key, title, type });
}

/** 从判题结果里取结论；同一段输出里可能有多个，取最后一个 */
function rememberVerdictFromJudge(tabId: number, output: string): void {
  const matches = [...String(output).matchAll(/判题结论[：:]\s*([A-Z]{2,4})/g)];
  const verdict = matches.at(-1)?.[1];
  if (verdict) recordVerdict(tabId, verdict);
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

  // 带工具名解析：write_zip / write_document 的 filesJson 在这里解析成 files
  const parsed = parseToolArguments(rawArguments, name);
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

  if (name === 'write_explanation_page') {
    const html = typeof args.html === 'string' ? args.html : '';
    if (!html.trim()) return { output: '缺少 html 参数', isError: true };
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '讲解页';
    try {
      const pageId = await storeExplanation(html, title);
      // 结果里带上 id 与标题，面板据此显示「打开讲解页」的邀请卡片
      return {
        output: JSON.stringify({ pageId, title, ok: true }),
        isError: false,
      };
    } catch (error) {
      return {
        output: `讲解页没能存下来：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  if (name === 'js_inject') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const result = await injectScript(tabId, code, undefined, undefined, signal);
    return { output: result.output, isError: !result.ok };
  }

  if (name === 'compile_and_run_c' || name === 'compile_and_run_cpp' || name === 'compile_and_run_js' || name === 'compile_and_run_python') {
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };
    const stdin = asStdin(args.stdin);
    // 开了「强制用 PTA 运行环境」：不跑本地编译器，改用 PTA 自己的编译器与机器
    if (await forcePtaRunEnabled()) {
      return runOnPta(code, stdin, context);
    }
    try {
      // 编译最长能跑一分钟，中途被停也要立刻放手
      const result = await abortable(
        name === 'compile_and_run_c'
          ? compileAndRun({ code, stdin, signal })
          : name === 'compile_and_run_cpp'
            ? compileAndRunCpp({ code, stdin, signal })
            : name === 'compile_and_run_js'
              ? compileAndRunJs({ code, stdin, signal })
              : compileAndRunPython({ code, stdin, signal }),
        signal,
      );
      // 说清用的是哪个运行时：模型才知道这个结果能不能代表 PTA 上的表现
      return { output: `（用插件内置的编译器）\n${formatCompileResult(result)}`, isError: false };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      return { output: error instanceof Error ? error.message : String(error), isError: true };
    }
  }

  if (name === 'write_editor_code') {
    const notes: string[] = [];
    const code = typeof args.code === 'string' ? args.code : '';
    if (!code.trim()) return { output: '缺少 code 参数', isError: true };

    // 选择题/判断题的作答区是单选框，不是代码编辑器：走填答案那条路
    const pageType = await readProblemType(tabId, signal);
    if (pageType?.isChoice) {
      const filled = await writeChoiceAnswers(tabId, code, signal);
      if (!filled) {
        return {
          output: `这页是${pageType.name}，但答案没能填进去。答案要用空格分隔（第一个对第一题），可以写选项字母或选项原文。`,
          isError: true,
        };
      }
      const detail = filled.filled
        .map((item) => `第 ${item.index} 题 → ${item.text}`)
        .join('；');
      const problems = filled.problems.length ? '\n问题：' + filled.problems.join('；') : '';
      return {
        output: `已按「${pageType.name}」填入 ${filled.filled.length}/${filled.total} 题：${detail}${problems}`,
        isError: filled.problems.length > 0,
      };
    }

    // 多文件题：模型用 editorIndex 指定写第几个可写编辑器；不传就按默认（最长的那个）
    const wantedIndex = Number(args.editorIndex);
    const editorIndex = Number.isInteger(wantedIndex) && wantedIndex >= 0 ? wantedIndex : undefined;

    // 先留一份写入前的原文：写入成功后用它自动合成 diff 卡片（用户一定看得到改动）
    const beforeCode = await readEditorCode(tabId, signal, editorIndex);

    // 作答区选的语言要是 Python 2，先切成 Python 3：
    // 插件内置的 Python 运行器是 Python 3，模型写的也是 Python 3 的代码，
    // 不切的话提交过去 PTA 用 Python 2 编译，直接报「Non-zero Exit Code」
    const switched = await alignLanguage(tabId);
    if (switched) notes.push(switched);

    const outcome = await abortable(
      writeEditorCode({
        tabId,
        code,
        signal,
        editorIndex,
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
      notes.push(await verifyWrittenCode(injectScript, context, code, pageType?.id ?? 0));
    }

    // 自动 diff：写入前后的原文都拿到了才算（读不到就不硬造一张残缺的 diff）
    let autoDiff: DiffPayload | undefined;
    const written = code;
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

  if (name === 'set_language') {
    const outcome = await runPtaScript('set_language', args, context);
    try {
      const info = JSON.parse(outcome.output) as { language?: string; ok?: boolean; detail?: string };
      const wants = typeof args.language === 'string' && args.language.trim().length > 0;
      if (!wants) return { output: `当前作答语言：${info.language || '未知'}`, isError: false };
      if (info.ok === true) {
        return { output: `已把作答语言切到「${info.language || ''}」${info.detail ? `：${info.detail}` : ''}`, isError: false };
      }
      return {
        output: `切换失败：${info.detail || '题组不允许切到这个语言'}（当前 ${info.language || '未知'}）`,
        isError: true,
      };
    } catch {
      return outcome;
    }
  }

  if (name === 'simulate_pta_run' && typeof args.code === 'string' && args.code.trim()) {
    // 语言没有本地运行器时（Java / Go / C# …）一条命令搞定：写进作答区 → 在 PTA 上跑
    return runOnPta(
      args.code,
      args.stdin,
      context,
      '（代码已先写进作答区，再在 PTA 自己的环境里运行）',
      typeof args.language === 'string' && args.language.trim() ? args.language : undefined,
    );
  }

  // 赶题模式：切到题目列表里的下一题（脚本返回 JSON，这里说成人话）
  if (name === 'next_problem') {
    const outcome = await runPtaScript('next_problem', args, context);
    const parsed = parseNextProblem(outcome.output);
    if (parsed?.ok) {
      const key = problemKeyFrom(parsed.url ?? '') || parsed.title || '';
      if (key) setCurrentProblem(tabId, { key, title: parsed.title, type: parsed.type });
    }
    const summary = parsed && parsed.ok === false ? batchSummary(tabId) : '';
    if (parsed?.ok && context.onBatchNotice) {
      const stats = batchStats(tabId);
      if (stats) {
        const left = typeof parsed.remaining === 'number' ? `，还剩 ${parsed.remaining} 题` : '';
        context.onBatchNotice(`赶题进度：已做 ${stats.attempted} 题、AC ${stats.accepted} 题${left}`);
      }
    }
    return { output: describeNextProblem(outcome.output, summary), isError: outcome.isError };
  }

  // PTA 相关动作都在页面主世界跑（编辑器实例、判题弹窗都是页面自己的东西）
  if (PTA_SCRIPTS[name]) {
    // 页面脚本只认字符串：模型把数据集写成数字（stdin: 2）时先归一化，别静默丢成空串
    const scriptArgs = name === 'simulate_pta_run' ? { ...args, stdin: asStdin(args.stdin) } : args;
    const outcome = await runPtaScript(name, scriptArgs, context);
    if (name === 'read_problem' && !outcome.isError) rememberProblemFromRead(tabId, outcome.output);
    if ((name === 'submit_answer' || name === 'read_judge_result') && !outcome.isError) {
      rememberVerdictFromJudge(tabId, outcome.output);
    }
    return outcome;
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
    case 'cpp':
    case 'c++':
    case 'cxx': return 'C++';
    case 'c': return 'C';
    case 'java': return 'Java';
    case 'go': return 'Go';
    case 'rust': return 'Rust';
    case 'csharp': return 'C#';
    default: return language || '未知语言';
  }
}

/** 页面上没认得出语言时，按代码长相猜一个（宁可不猜，也不要把 Python 当 C 报编译失败） */
function guessLanguage(code: string): string {
  // C++ 要先判：#include <iostream>、std::、using namespace std 都是 C 里不可能出现的
  if (
    /^\s*#include\s*[<"](iostream|string|vector|algorithm|map|set|queue|stack|deque|list|utility|unordered_map|unordered_set|bitset|numeric|functional|cstdio|cstring|cmath|cstdlib|memory)/m.test(code)
    || /\bstd::|\busing\s+namespace\s+std\b|\bcout\s*<<|\bcin\s*>>/.test(code)
  ) return 'cpp';
  if (/^\s*(#include|int\s+main\s*\()/m.test(code)) return 'c';
  if (/^\s*(def |import |print\s*\(|class |if\s+__name__)/m.test(code)) return 'python';
  if (/^\s*(function |const |let |var |console\.)/m.test(code)) return 'js';
  return 'c';
}

/**
 * 按语言跑一遍代码，返回统一的编译结果；没有内置运行器时返回 null。
 *
 * 这里必须把「本地跑不了」和「跑失败」分开：Java / Go 以前会被默认当成 C 去编，
 * 于是好好的 Java 代码被报成「C 编译失败」，模型会照着假错误改坏代码。
 */
async function runWithLanguage(
  language: string,
  code: string,
  stdin: string,
  signal: AbortSignal,
): Promise<CompileResult | null> {
  const lang = String(language || '').toLowerCase();
  if (lang === 'python' || lang === 'python2' || lang === 'python3') {
    return compileAndRunPython({ code, stdin, signal });
  }
  if (lang === 'js' || lang === 'javascript' || lang === 'node') {
    return compileAndRunJs({ code, stdin, signal });
  }
  if (lang === 'cpp' || lang === 'c++' || lang === 'cxx' || lang === 'clang++') {
    return compileAndRunCpp({ code, stdin, signal });
  }
  if (lang === 'c' || lang === 'gcc' || lang === 'clang' || lang === 'c语言') {
    return compileAndRun({ code, stdin, signal });
  }
  return null;
}

/**
 * 用同一份代码依次跑前几组样例。
 *
 * 只跑第一组时，很多「首样例对、边界错」的题要等提交后才暴露；
 * 这里最多跑三组（输入输出各自不超过 4000 字符），编译错误或第一处不一致就停。
 */
async function runSamplesWithLanguage(
  language: string,
  code: string,
  samples: { input: string; output: string }[],
  signal: AbortSignal,
): Promise<string[]> {
  const checks: string[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const compiled = await runWithLanguage(language, code, sample.input, signal);
    const label = `${langLabel(language)}`;
    if (!compiled) {
      checks.push(`自动检查：${label}没有内置运行器，跳过本地编译比对（请用 simulate_pta_run 在 PTA 上验证样例）`);
      return checks;
    }
    if (compiled.compileOutput) {
      checks.push(`自动检查：${label}编译失败——${compiled.compileOutput.split('\n')[0]}`);
      return checks;
    }
    if (!compiled.ok) {
      checks.push(`自动检查：样例 ${index + 1} ${label}运行返回 ${compiled.statusText}`);
      return checks;
    }
    const diff = compareOutput(sample.output, compiled.stdout);
    if (diff.same) {
      checks.push(`自动检查：样例 ${index + 1}（${label}，输入 ${JSON.stringify(sample.input.trim())}）输出一致`);
      continue;
    }
    checks.push(`自动检查：样例 ${index + 1} 输出不一致——${diff.detail}`);
    return checks;
  }
  return checks;
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
  context: ToolContext,
  code: unknown,
  problemTypeId: number,
): Promise<string> {
  const { tabId, signal } = context;
  const source = typeof code === 'string' ? code : '';
  const checks: string[] = [];

  // 代码填空 / 多文件题不能按「一份完整程序」去跑样例：
  //   · type 6 的作答区只是裁判程序的一段，单独编译会把 printf 报成未声明、也没有 main；
  //   · type 9 要所有文件一起编译，只给一份代码必然链接失败。
  // 这里只做带 prelude 的语法检查，运行验证交给 simulate_pta_run。
  if (problemTypeId === 6 || problemTypeId === 9) {
    if (problemTypeId === 6) {
      try {
        // 语法检查要按页面选的语言走（C / C++），不能瞎猜
        let language = '';
        try {
          const raw = await inject(tabId, READ_PROBLEM_SCRIPT, { samplesOnly: true }, undefined, signal);
          // 这里是页面脚本返回的 JSON，形状由 READ_PROBLEM_SCRIPT 的 samplesOnly 分支固定
          const parsedLanguage = JSON.parse(raw.output) as { language?: string };
          language = parsedLanguage.language ?? '';
        } catch {
          language = '';
        }
        const checked = await abortable(checkCode(source, language, signal, true), signal);
        checks.push(
          checked.errorCount > 0
            ? `自动语法检查：${checked.errorCount} 个错误——${checked.diagnostics[0]?.message ?? ''}`
            : `自动语法检查：${checked.note || '没有语法错误'}`,
        );
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        checks.push(`自动语法检查没做成（${error instanceof Error ? error.message : String(error)}）`);
      }
    } else {
      checks.push('自动检查：多文件题不本地编译比对（需要所有文件一起编译），请用 simulate_pta_run 在 PTA 上验证');
    }
    // 提交按钮状态仍然要查
    try {
      const ready = await inject(tabId, CHECK_READY_SCRIPT, undefined, undefined, signal);
      checks.push(`页面状态：${ready.output}`);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      checks.push(`页面状态没读到（${error instanceof Error ? error.message : String(error)}）`);
    }
    return checks.join('；');
  }

  // 1) 样例编译并比对输出（用第一组样例，避免每次都多跑一遍）
  try {
    const samplesRaw = await inject(tabId, READ_PROBLEM_SCRIPT, { samplesOnly: true }, undefined, signal);
    const parsed = JSON.parse(samplesRaw.output) as {
      samples?: { input: string; output: string }[];
      language?: string;
    };
    const samples = (parsed.samples ?? []).filter(
      (item) => item.input.length <= 4000 && item.output.length <= 4000,
    );
    const sample = samples[0];
    const language = parsed.language ?? '';
    if (!sample) {
      checks.push('自动检查：题面里没识别出样例，跳过编译比对');
    } else if (await forcePtaRunEnabled()) {
      // 强制用 PTA 运行环境：只跑第一组（每次都要真的点一次「运行测试」，很慢）
      const outcome = await runPtaScript('simulate_pta_run', { stdin: sample.input }, context);
      const expected = sample.output.trim();
      const hit = expected.length > 0 && outcome.output.includes(expected);
      checks.push(
        hit
          ? `自动检查：样例 1（PTA 运行环境，输入 ${JSON.stringify(sample.input.trim())}）输出一致`
          : `自动检查：样例 1（PTA 运行环境）没看到期望输出——${outcome.output.slice(0, 300).replace(/\n/g, ' ')}`,
      );
    } else {
      // 按题目语言挑编译器；语言认不出来时按代码长相猜一下
      const lang = language || guessLanguage(source);
      const compiledList = await abortable(
        runSamplesWithLanguage(lang, source, samples.slice(0, 3), signal),
        signal,
      );
      checks.push(...compiledList);
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
