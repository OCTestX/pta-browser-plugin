import { isAbortError } from '../shared/abort';
import { ext } from '../shared/browser';
import { isContentRequest } from '../shared/messages';
import type {
  BackgroundEvent,
  RunToolRequest,
  StartChatResponse,
  TestInputResponse,
  ToolRunResponse,
} from '../shared/messages';
import { createId, type ApiMessage } from '../shared/types';
import { runAgent, type ToolOutcome } from './agent';
import { DEFAULT_INPUT_METHOD, findInputMethod } from '../shared/input-methods';
import { runInputMethod, writeEditorCode } from './input-methods';
import { loadSettings, saveSettings, toSettingsView } from './settings';

const TOGGLE_PANEL: BackgroundEvent = { type: 'toggle-panel' };
const RESET_PANEL_LAYOUT: BackgroundEvent = { type: 'panel/reset-layout' };

/** requestId -> AbortController，用于「停止生成」 */
const runningRequests = new Map<string, AbortController>();

/**
 * requestId -> AbortController，「输入」按钮的写作答区任务。
 * 它也会跑很久（整段代码要写进编辑器），所以「停止」同样要能打断它。
 */
const runningInputs = new Map<string, AbortController>();

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
      case 'settings/get':
        sendResponse(toSettingsView(await loadSettings()));
        return;
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
      case 'chat/start':
        sendResponse(await startChat(message.requestId, message.messages, tabId));
        return;
      case 'chat/stop': {
        // 面板只有一个「停止」：这一轮对话在跑、或者「输入」按钮正在写作答区，都归它管
        runningRequests.get(message.requestId)?.abort();
        runningInputs.get(message.requestId)?.abort();
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
      case 'code/input': {
        // 输入框的「输入」按钮：走写入工具同一条链路（默认实现 → 清空 → 备用实现依次重试），
        // PTA 禁粘贴时用它把整段代码塞进作答区
        if (tabId === undefined) {
          sendResponse({ ok: false, result: '当前页面不支持（请刷新页面后重试）' } satisfies ToolRunResponse);
          return;
        }
        const controller = new AbortController();
        // 面板一定会带 requestId；缺了就自己造一个，保证「停止」这条路仍然能接上
        const requestId = message.requestId ?? createId();
        runningInputs.set(requestId, controller);
        const stopKeepAlive = keepServiceWorkerAlive(() => runningInputs.has(requestId));
        let outcome: ToolOutcome;
        try {
          outcome = await writeEditorCode({ tabId, code: message.code, signal: controller.signal });
        } catch (error) {
          outcome = {
            output: isAbortError(error, controller.signal) ? '已停止，作答区没写完' : toErrorMessage(error),
            isError: true,
          };
        } finally {
          stopKeepAlive();
          runningInputs.delete(requestId);
        }
        sendResponse({
          ok: !outcome.isError,
          result: outcome.isError ? `写入作答区失败：${outcome.output}` : `已写入作答区：${outcome.output}`,
        } satisfies ToolRunResponse);
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

  const controller = new AbortController();
  runningRequests.set(requestId, controller);
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
          onUsage: (usage) => sendToTab(tabId, { type: 'chat/usage', requestId, ...usage }),
          runPageTool: (name, args) => runToolInTab(tabId, name, args),
          askUser: (callId, question, options) => askUserInTab(requestId, tabId, callId, question, options, controller.signal),
        },
      });
      sendToTab(tabId, { type: 'chat/done', requestId, aborted: false });
    } catch (error) {
      // 各阶段（模型流 / 页面脚本 / 编译 / 逐字输入）都靠同一个 AbortError 收工，
      // 这里只认「这一轮被停掉了」，别把它当成出错报给用户
      if (isAbortError(error, controller.signal)) {
        sendToTab(tabId, { type: 'chat/done', requestId, aborted: true });
      } else {
        sendToTab(tabId, { type: 'chat/error', requestId, message: toErrorMessage(error) });
      }
    } finally {
      stopKeepAlive();
      releaseAsks(requestId);
      runningRequests.delete(requestId);
    }
  })();

  return { ok: true };
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

