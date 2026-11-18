import { isAbortError } from '../shared/abort';
import { ext } from '../shared/browser';
import { isContentRequest } from '../shared/messages';
import type {
  AttachChatResponse,
  BackgroundEvent,
  DiffPayload,
  EditorAssistInstallResponse,
  ModelsListResponse,
  RunToolRequest,
  StartChatResponse,
  TestInputResponse,
  ToolRunResponse,
} from '../shared/messages';
import { isCompleteBaseURL, normalizeBaseURL } from '../shared/settings';
import { createId, type ApiMessage } from '../shared/types';
import { runAgent, type ToolOutcome } from './agent';
import { batchActive, batchSnapshot, finishBatch } from './batch-progress';
import { DEFAULT_INPUT_METHOD, findInputMethod } from '../shared/input-methods';
import { pasteIntoEditor, runInputMethod } from './input-methods';
import { readClipboardText } from './clipboard';
import { openExplanation } from './explain-pages';
import { injectScript } from './js-inject';
import { EDITOR_AGENT_SOURCE } from './editor-agent';
import { EDITOR_ASSIST_VERSION, type EditorAssistInstallArgs } from '../shared/editor-assist-protocol';
import { C_LIBRARY_DOCS } from '../shared/c-library-docs';
import { CPP_LIBRARY_DOCS } from '../shared/cpp-library-docs';
import { checkCode } from './compile';
import { checkForUpdates, loadSettings, saveSettings, toSettingsView } from './settings';

const TOGGLE_PANEL: BackgroundEvent = { type: 'toggle-panel' };
const RESET_PANEL_LAYOUT: BackgroundEvent = { type: 'panel/reset-layout' };

/** requestId -> AbortController，用于「停止生成」 */
const runningRequests = new Map<string, AbortController>();

/** requestId -> 标签页 id：新对话开始时要把同一个页面里上一轮还在跑的那一轮掐掉 */
const runningRequestTabs = new Map<string, number>();

/** 全屏 diff 存在 chrome.storage.local 里的键前缀（diff.html 按 id 取回） */
const DIFF_STORAGE_PREFIX = 'pta-assistant-diff:';
/** 最多留几份全屏 diff，旧的顺手清掉 */
const DIFF_KEEP = 8;

/**
 * requestId -> AbortController，页面里的「内置粘贴」写入任务。
 * 整段代码写进编辑器可能要几十秒，所以同样要能被「停止」打断。
 */
const runningInputs = new Map<string, AbortController>();
/** 每个正在跑的输入任务属于哪个标签页：面板的「停止」要能按到这个标签页上的任务 */
const runningInputTabs = new Map<string, number>();

/** callId -> 等用户点选的 ask 工具：面板点完选项用 chat/ask-answer 回来兑现 */
interface PendingAsk {
  requestId: string;
  settle: (choice: string) => void;
  timer: number;
}
const pendingAsks = new Map<string, PendingAsk>();

/**
 * 等太久用户就当卡死了：超时后按「用户没有作答」继续，agent loop 不再挂着。
 * 15 分钟：问用户判题结果、写题解这类问题，用户可能中途去查资料，
 * 2 分钟就判「没人管」会白白打断正常的一轮；真有走人的情况，用户点「停止」同样能收工。
 */
const ASK_TIMEOUT_MINUTES = 15;
const ASK_TIMEOUT_MS = ASK_TIMEOUT_MINUTES * 60_000;

/**
 * ask 工具：把选择题发给面板并等用户点选。
 * 超时、用户点「停止」、或者这一轮结束时都会解掉等待。
 */
function askUserInTab(
  requestId: string,
  tabId: number,
  callId: string,
  question: string,
  options: string[],
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.resolve('用户已停止，没有作答');

  return new Promise<string>((resolve) => {
    const settle = (choice: string) => {
      const pending = pendingAsks.get(callId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingAsks.delete(callId);
      resolve(choice);
    };
    const timer = setTimeout(() => {
      settle(`用户 ${ASK_TIMEOUT_MINUTES} 分钟内没有作答，按「没有作答」继续`);
      sendToTab(tabId, {
        type: 'chat/notice',
        requestId,
        text: `这次提问等了 ${ASK_TIMEOUT_MINUTES} 分钟还没有作答，已经按「没有作答」继续`,
      });
    }, ASK_TIMEOUT_MS);

    pendingAsks.set(callId, { requestId, settle, timer });
    signal.addEventListener('abort', () => settle('用户已停止这次提问，没有作答'), { once: true });

    sendToTab(tabId, { type: 'chat/ask', requestId, callId, question, options });
  });
}

/** 一轮结束（正常收尾或中止）时把还没答的 ask 全部解掉 */
function releaseAsks(requestId: string): void {
  for (const pending of [...pendingAsks.values()]) {
    if (pending.requestId === requestId) pending.settle('用户没有选择，这一轮结束了');
  }
}

/** 两次图标点击间隔在这个毫秒数内就算双击（双击图标 = 恢复位置与大小的默认） */
const DOUBLE_CLICK_MS = 400;
const lastIconClick = new Map<number, number>();

// 点击工具栏图标 -> 通知当前标签页里的 content script 开/关悬浮窗
ext.action.onClicked.addListener((tab) => {
  const tabId = tab.id;
  if (tabId === undefined) return;
  // 排查「点图标没反应」时，可以在扩展详情页点 service worker 打开控制台看这行日志
  console.log(`[PTA 助手] 图标被点击，切换标签页 ${tabId} 上的悬浮窗`);

  const now = Date.now();
  const previous = lastIconClick.get(tabId);
  if (previous !== undefined && now - previous <= DOUBLE_CLICK_MS) {
    // 第二下不再开关面板，只把位置与大小复位（否则开→关，窗口直接没了）
    lastIconClick.delete(tabId);
    sendToTab(tabId, RESET_PANEL_LAYOUT);
    return;
  }
  lastIconClick.set(tabId, now);
  void toggleInTab(tabId);
});

async function toggleInTab(tabId: number): Promise<void> {
  try {
    await ext.tabs.sendMessage(tabId, TOGGLE_PANEL);
    return;
  } catch {
    // 页面是在插件安装/重载之前打开的，content script 还没注入，这里补一次
  }

  try {
    await ext.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await ext.tabs.sendMessage(tabId, TOGGLE_PANEL);
  } catch (error) {
    // chrome:// 之类注入不了的页面，忽略
    console.warn('[PTA 助手] 无法在当前页面打开悬浮窗', error);
  }
}

ext.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // 返回 undefined 表示这条消息不由我们处理（Firefox 不太接受显式返回 false）
  if (!isContentRequest(message)) return undefined;

  const tabId = sender.tab?.id;
  void (async () => {
    switch (message.type) {
      case 'editor/assist/install': {
        // 作答区只有 MAIN world 拿得到 CodeMirror 实例，装脚本这件事只能由后台做
        if (tabId === undefined) {
          sendResponse({ ok: false, token: '', message: '当前页面不支持（请刷新页面后重试）' } satisfies EditorAssistInstallResponse);
          return;
        }
        const token = createId();
        const args: EditorAssistInstallArgs = {
          token,
          version: EDITOR_ASSIST_VERSION,
          docs: { ...C_LIBRARY_DOCS, ...CPP_LIBRARY_DOCS },
          // 四个增强全开：整理代码、彩虹括号、实时语法检查、标准库函数注释
          features: { format: true, rainbow: true, check: true, hover: true },
        };
        const injected = await injectScript(tabId, EDITOR_AGENT_SOURCE, args);
        // 页面里已经装过时它会把**自己那份** token 交回来，两边必须用同一个
        let used = token;
        try {
          const parsed = JSON.parse(injected.output) as { token?: unknown };
          if (typeof parsed.token === 'string' && parsed.token) used = parsed.token;
        } catch {
          // 输出不是 JSON 就不要了，按新 token 走
        }
        sendResponse({
          ok: injected.ok,
          token: injected.ok ? used : '',
          message: injected.ok ? '' : injected.output,
          world: injected.world,
        } satisfies EditorAssistInstallResponse);
        return;
      }
      case 'editor/check': {
        sendResponse(await checkCode(message.code, message.language, undefined, message.fragment === true));
        return;
      }
      case 'settings/get': {
        sendResponse(toSettingsView(await loadSettings()));
        return;
      }
      case 'update/check': {
        // force=true 时跳过缓存重新查（设置页的「检查更新」按钮）
        sendResponse(await checkForUpdates(message.force === true));
        return;
      }
      case 'settings/save':
        sendResponse(toSettingsView(await saveSettings(message.patch)));
        return;
      case 'ui/open-url': {
        // 设置页的「教程」按钮：只放行 http(s)，避免变成任意开页面的入口
        if (!/^https?:\/\//.test(message.url)) {
          sendResponse({ ok: false, message: '只允许打开 http/https 链接' } satisfies StartChatResponse);
          return;
        }
        try {
          await ext.tabs.create({ url: message.url });
          sendResponse({ ok: true } satisfies StartChatResponse);
        } catch (error) {
          sendResponse({ ok: false, message: toErrorMessage(error) } satisfies StartChatResponse);
        }
        return;
      }
      case 'ui/navigate': {
        // 赶题总览卡里点某道题：把这个标签页导航到那道题。
        // content script 没有 chrome.tabs，只能让后台来跳；只放行 http(s)，别变成任意开页面的入口。
        if (!/^https?:\/\//.test(message.url)) {
          sendResponse({ ok: false, message: '只允许跳转到 http/https 链接' } satisfies StartChatResponse);
          return;
        }
        if (tabId === undefined) {
          sendResponse({ ok: false, message: '当前页面不支持跳转' } satisfies StartChatResponse);
          return;
        }
        try {
          await ext.tabs.update(tabId, { url: message.url });
          sendResponse({ ok: true } satisfies StartChatResponse);
        } catch (error) {
          sendResponse({ ok: false, message: toErrorMessage(error) } satisfies StartChatResponse);
        }
        return;
      }
      case 'ui/open-diff': {
        // diff 卡片的「全屏」：先落盘一份完整数据，再开标签页按 id 取回
        try {
          const id = await storeDiff(message.diff);
          await ext.tabs.create({ url: ext.runtime.getURL(`diff.html?id=${encodeURIComponent(id)}`) });
          sendResponse({ ok: true } satisfies StartChatResponse);
        } catch (error) {
          sendResponse({ ok: false, message: toErrorMessage(error) } satisfies StartChatResponse);
        }
        return;
      }
      case 'ui/open-explain': {
        // 讲解页的邀请卡片：后台开新标签页打开
        try {
          await openExplanation(message.pageId);
          sendResponse({ ok: true } satisfies StartChatResponse);
        } catch (error) {
          sendResponse({ ok: false, message: toErrorMessage(error) } satisfies StartChatResponse);
        }
        return;
      }
      case 'clipboard/read': {
        const clip = await readClipboardText();
        sendResponse({ ok: clip.ok, text: clip.text, message: clip.message });
        return;
      }
      case 'code/paste': {
        // 页面里拦下的 Ctrl+V / Ctrl+M：用「内置粘贴」在光标处插入剪贴板内容
        if (tabId === undefined) {
          sendResponse({ ok: false, result: '当前页面不支持（请刷新页面后重试）' } satisfies ToolRunResponse);
          return;
        }
        const controller = new AbortController();
        const requestId = message.requestId ?? createId();
        runningInputs.set(requestId, controller);
        runningInputTabs.set(requestId, tabId);
        const stopKeepAlive = keepServiceWorkerAlive(() => runningInputs.has(requestId));
        let outcome: ToolOutcome;
        try {
          outcome = await pasteIntoEditor({ tabId, text: message.text, signal: controller.signal });
        } catch (error) {
          outcome = {
            output: isAbortError(error, controller.signal) ? '已停止，剪贴板内容没有写进去' : toErrorMessage(error),
            isError: true,
          };
        } finally {
          stopKeepAlive();
          runningInputs.delete(requestId);
          runningInputTabs.delete(requestId);
        }
        sendResponse({
          ok: !outcome.isError,
          result: outcome.output,
        } satisfies ToolRunResponse);
        return;
      }
      case 'models/list': {
        sendResponse(await listModels(message.baseURL, message.apiKey));
        return;
      }
      case 'chat/start':
        sendResponse(await startChat(message.requestId, message.messages, tabId));
        return;
      case 'chat/attach': {
        // 页面重新挂载后（刷新、整页跳转），把这一页正在跑的那一轮重新接上：
        // 没有它，面板就收不到那一轮的事件，「停止」也按不到后台
        if (tabId === undefined) {
          sendResponse({ ok: false } satisfies AttachChatResponse);
          return;
        }
        let requestId = '';
        for (const [id, idTab] of runningRequestTabs) {
          if (idTab === tabId && runningRequests.has(id)) {
            requestId = id;
            break;
          }
        }
        sendResponse({
          ok: Boolean(requestId),
          requestId,
          // 赶题模式跑到一半页面刷新了：把当前进度一起带回去，总览卡不会空白
          ...(batchActive(tabId) ? { snapshot: batchSnapshot(tabId) } : {}),
        } satisfies AttachChatResponse);
        return;
      }
      case 'chat/stop': {
        // 面板只有一个「停止」：这一轮对话在跑、或者正在写作答区，都归它管
        runningRequests.get(message.requestId)?.abort();
        runningInputs.get(message.requestId)?.abort();
        // 粘贴这类任务是页面自己发起的（id 对不上对话的 requestId），
        // 所以按标签页再扫一遍：这个标签页上正在跑的输入任务一起停掉。
        if (tabId !== undefined) {
          for (const [id, inputTab] of runningInputTabs) {
            if (inputTab === tabId) runningInputs.get(id)?.abort();
          }
        }
        releaseAsks(message.requestId);
        sendResponse({ ok: true } satisfies StartChatResponse);
        return;
      }
      case 'chat/ask-answer': {
        const pending = pendingAsks.get(message.callId);
        if (!pending || pending.requestId !== message.requestId) {
          sendResponse({ ok: false, message: '这次提问已经结束了' } satisfies StartChatResponse);
          return;
        }
        pending.settle(message.choice);
        sendResponse({ ok: true } satisfies StartChatResponse);
        return;
      }
      case 'tool/test-input': {
        // 设置页的测试按钮：按指定方法往作答区写一次，用来实测哪种不会被页面拦住
        if (tabId === undefined) {
          sendResponse({ ok: false, result: '当前页面不支持（请刷新页面后重试）' } satisfies TestInputResponse);
          return;
        }
        const method = findInputMethod(message.method ?? DEFAULT_INPUT_METHOD);
        const outcome = await runInputMethod({
          methodId: method.id,
          text: message.text,
          tabId,
        });
        sendResponse({
          ok: !outcome.isError,
          result: `【${method.label}】${outcome.output}`,
          method: method.id,
        } satisfies TestInputResponse);
        return;
      }
    }
  })().catch((error: unknown) => {
    sendResponse({ ok: false, message: toErrorMessage(error) });
  });

  return true; // 保持消息通道，等异步结果
});

/**
 * 面板可能长时间什么都不做（等用户作答最多 15 分钟、等判题结论一两分钟、整段写作答区）。
 * MV3 的 service worker 空闲到点会被回收，那时 pendingAsks 里的等待会跟着进程一起消失，
 * agent loop 就永远挂住了——每 20 秒戳一次扩展 API 把空闲计时器重置掉。
 */
function keepServiceWorkerAlive(isAlive: () => boolean): () => void {
  const interval = setInterval(() => {
    if (!isAlive()) {
      clearInterval(interval);
      return;
    }
    void Promise.resolve(ext.runtime.getPlatformInfo?.()).catch(() => undefined);
  }, 20_000);
  return () => clearInterval(interval);
}

/**
 * 问接口「你有哪些模型」：OpenAI 兼容的 GET {baseURL}/models。
 * Key 优先用面板上刚填的（还没保存），没填就用后台存着的那把。
 */
async function listModels(baseURL: string, draftApiKey?: string): Promise<ModelsListResponse> {
  const settings = await loadSettings();
  const apiKey = (draftApiKey ?? '').trim() || settings.apiKey;
  if (!apiKey) return { ok: false, models: [], message: '还没有 API Key，先填上再加载模型列表' };

  const base = normalizeBaseURL(baseURL);
  if (!isCompleteBaseURL(base)) {
    return { ok: false, models: [], message: '接口地址还没填完整（要写成 https://…/v1 这样的完整地址）' };
  }

  try {
    const response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        models: [],
        message: `接口返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`,
      };
    }
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    const models = (Array.isArray(payload.data) ? payload.data : [])
      .map((item) => (typeof item?.id === 'string' ? item.id : ''))
      .filter((id) => id.length > 0)
      .sort();
    if (models.length === 0) {
      return { ok: false, models: [], message: '这个接口没有返回模型列表（可能不是 OpenAI 兼容的 /models）' };
    }
    return { ok: true, models };
  } catch (error) {
    return { ok: false, models: [], message: toErrorMessage(error) };
  }
}

async function startChat(
  requestId: string,
  messages: ApiMessage[],
  tabId: number | undefined,
): Promise<StartChatResponse> {
  const settings = await loadSettings();
  if (!settings.apiKey) {
    return { ok: false, message: '尚未配置 API Key，点右上角齿轮填入后即可开始对话' };
  }
  if (tabId === undefined) {
    return { ok: false, message: '当前页面不支持对话（请刷新页面后重试）' };
  }
  if (runningRequests.has(requestId)) {
    return { ok: false, message: '这个消息已经在生成中了' };
  }

  // 同一个页面只保留一轮：面板点了「新会话」再发消息时，上一轮即使还没收完尾也强制停掉，
  // 否则旧请求的结果会和新上下文交错着回来
  for (const [oldId, oldController] of runningRequests) {
    if (oldId !== requestId && runningRequestTabs.get(oldId) === tabId) {
      oldController.abort();
      releaseAsks(oldId);
      runningRequestTabs.delete(oldId);
    }
  }

  const controller = new AbortController();
  runningRequests.set(requestId, controller);
  runningRequestTabs.set(requestId, tabId);
  const stopKeepAlive = keepServiceWorkerAlive(() => runningRequests.has(requestId));

  void (async () => {
    try {
      await runAgent({
        messages,
        tabId,
        signal: controller.signal,
        events: {
          onDelta: (text) => sendToTab(tabId, { type: 'chat/delta', requestId, text }),
          onToolStart: (call) =>
            sendToTab(tabId, {
              type: 'chat/tool-start',
              requestId,
              callId: call.callId,
              name: call.name,
              args: call.args,
            }),
          onToolEnd: (callId, result, isError, diff) =>
            sendToTab(tabId, { type: 'chat/tool-end', requestId, callId, result, isError, diff }),
          onNotice: (text) => sendToTab(tabId, { type: 'chat/notice', requestId, text }),
          onBatch: (snapshot) => sendToTab(tabId, { type: 'chat/batch', requestId, snapshot }),
          onUsage: (usage) => sendToTab(tabId, { type: 'chat/usage', requestId, ...usage }),
          runPageTool: (name, args) => runToolInTab(tabId, name, args),
          askUser: (callId, question, options) => askUserInTab(requestId, tabId, callId, question, options, controller.signal),
        },
      });
      // 这一轮是「跑完了」还是「用户按了停止」：看中止标记。
      // agent loop 收到停止后可能正常收尾（不抛错），所以不能只看有没有进 catch。
      finishBatchIfRunning(tabId, requestId, controller.signal.aborted ? 'stopped' : 'done');
      sendToTab(tabId, { type: 'chat/done', requestId, aborted: controller.signal.aborted });
    } catch (error) {
      // 各阶段（模型流 / 页面脚本 / 编译 / 逐字输入）都靠同一个 AbortError 收工，
      // 这里只认「这一轮被停掉了」，别把它当成出错报给用户
      if (isAbortError(error, controller.signal)) {
        // 用户按了停止：卡片要写明「已停止」，并给出「继续赶剩下的题」这个出口
        finishBatchIfRunning(tabId, requestId, 'stopped');
        sendToTab(tabId, { type: 'chat/done', requestId, aborted: true });
      } else {
        // 这一轮是出错的（比如接口报错），不是走完了题单：
        // 卡片上要写明「出错中断」，别报成「已收工」——用户还以为题都做完了。
        finishBatchIfRunning(tabId, requestId, 'error');
        sendToTab(tabId, { type: 'chat/error', requestId, message: toErrorMessage(error) });
      }
    } finally {
      stopKeepAlive();
      releaseAsks(requestId);
      runningRequests.delete(requestId);
      runningRequestTabs.delete(requestId);
    }
  })();

  return { ok: true };
}

/**
 * 这一轮结束了：赶题模式（如果开着）标记成收工，并把最终快照推给面板。
 * 没有开过赶题模式的标签页什么都不做——别凭空给普通对话塞一张进度卡。
 */
function finishBatchIfRunning(
  tabId: number,
  requestId: string,
  reason: 'done' | 'stopped' | 'error' = 'done',
): void {
  if (!batchActive(tabId)) return;
  finishBatch(tabId, reason);
  sendToTab(tabId, { type: 'chat/batch', requestId, snapshot: batchSnapshot(tabId) });
}

/**
 * 把一份 diff 存进 storage.local，返回 id。
 * 只保留最近几份：全屏页刷新时还能按 id 取回，关掉后也不会把 storage 撑满。
 */
/** 从存下来的记录里取创建时间；不是对象或没有这个字段就当 0（排最后） */
function diffCreatedAt(value: unknown): number {
  if (value && typeof value === 'object' && 'createdAt' in value) {
    const createdAt = value.createdAt;
    return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0;
  }
  return 0;
}

async function storeDiff(diff: DiffPayload): Promise<string> {
  const id = createId();
  const all = await ext.storage.local.get(null);
  const entries = Object.entries(all).filter(([key]) => key.startsWith(DIFF_STORAGE_PREFIX));
  // 按存进去的时间排：键是随机的 uuid，按名字排会随机淘汰掉一份（可能正是用户刚点开的）。
  const stale = entries
    .sort((a, b) => diffCreatedAt(a[1]) - diffCreatedAt(b[1]))
    .slice(0, Math.max(0, entries.length - (DIFF_KEEP - 1)))
    .map(([key]) => key);
  if (stale.length > 0) await ext.storage.local.remove(stale);
  await ext.storage.local.set({ [`${DIFF_STORAGE_PREFIX}${id}`]: { ...diff, createdAt: Date.now() } });
  return id;
}

/** url / write_document 要在页面里执行，转给 content script */
async function runToolInTab(
  tabId: number,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const request: RunToolRequest = { type: 'tool/run', name, args };
  try {
    const response = (await ext.tabs.sendMessage(tabId, request)) as ToolRunResponse | undefined;
    if (!response) return { output: `${name} 没有返回结果`, isError: true };
    return { output: response.result, isError: !response.ok };
  } catch (error) {
    return { output: `页面没有响应 ${name}：${toErrorMessage(error)}`, isError: true };
  }
}

function sendToTab(tabId: number, event: BackgroundEvent): void {
  void ext.tabs.sendMessage(tabId, event).catch(() => undefined);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

