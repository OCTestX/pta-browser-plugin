import { ext } from '../shared/browser';
import { isContentRequest } from '../shared/messages';
import type {
  BackgroundEvent,
  RunToolRequest,
  StartChatResponse,
  ToolRunResponse,
} from '../shared/messages';
import type { ApiMessage } from '../shared/types';
import { runAgent, type ToolOutcome } from './agent';
import { loadSettings, saveSettings, toSettingsView } from './settings';

const TOGGLE_PANEL: BackgroundEvent = { type: 'toggle-panel' };

/** requestId -> AbortController，用于「停止生成」 */
const runningRequests = new Map<string, AbortController>();

// 点击工具栏图标 -> 通知当前标签页里的 content script 开/关悬浮窗
ext.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  // 排查「点图标没反应」时，可以在扩展详情页点 service worker 打开控制台看这行日志
  console.log(`[PTA 助手] 图标被点击，切换标签页 ${tab.id} 上的悬浮窗`);
  void toggleInTab(tab.id);
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
      case 'chat/start':
        sendResponse(await startChat(message.requestId, message.messages, tabId));
        return;
      case 'chat/stop': {
        runningRequests.get(message.requestId)?.abort();
        sendResponse({ ok: true } satisfies StartChatResponse);
        return;
      }
    }
  })().catch((error: unknown) => {
    sendResponse({ ok: false, message: toErrorMessage(error) });
  });

  return true; // 保持消息通道，等异步结果
});

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
          onToolEnd: (callId, result, isError) =>
            sendToTab(tabId, { type: 'chat/tool-end', requestId, callId, result, isError }),
          onNotice: (text) => sendToTab(tabId, { type: 'chat/notice', requestId, text }),
          runPageTool: (name, args) => runToolInTab(tabId, name, args),
        },
      });
      sendToTab(tabId, { type: 'chat/done', requestId, aborted: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        sendToTab(tabId, { type: 'chat/done', requestId, aborted: true });
      } else {
        sendToTab(tabId, { type: 'chat/error', requestId, message: toErrorMessage(error) });
      }
    } finally {
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

