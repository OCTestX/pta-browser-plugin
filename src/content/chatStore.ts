/**
 * 对话记录的持久化（按标签页）。
 *
 * 之前对话只活在 React 的 state 里：页面一刷新（或者 PTA 自己重新加载），
 * 整段对话就没了，用户得从头再说一遍。这里把消息写进 sessionStorage，
 * 同一标签页刷新后恢复。
 *
 * 隔离单位是标签页而不是地址：同一道题开两个标签页，两段对话各存各的，
 * 不会互相串；同一个标签页里换题、整页跳转，对话也还是自己那段。
 * sessionStorage 天然按标签页隔离、刷新不丢，比原来那份全局
 * chrome.storage.local 更贴合语义——那份全局存储里同 URL 的两个标签页
 * 会写同一个键，谁后写谁覆盖。
 *
 * 一轮进行中的对话（赶题模式 /fuck）另外按 requestId 存一份：
 * 刷新、整页跳转后，后台按 requestId 把面板接回来时用它恢复。
 */

import type { ChatMessage } from '../shared/types';

// 与 panelStore 用同一个键：同一个标签页里两个模块读到的是同一个标签页 id。
const TAB_ID_KEY = 'pta-assistant-tab-id';
const STORE_KEY_PREFIX = 'pta-assistant-chat';

/** 一次最多保留多少条消息：工具结果很长，全存会把配额撑爆 */
const MAX_MESSAGES = 60;
/** 单条消息最多保留多少字符（工具结果最长 4000 字符，截一半足够看清） */
const MAX_CONTENT = 8000;

type Store = Record<string, ChatMessage[]>;

// content script 启动时取一次 sessionStorage；取不到就退化成纯内存（功能不炸）。
const tabStorage = ((): Storage | null => {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
})();

let cachedTabId = '';

function tabId(): string {
  if (cachedTabId) return cachedTabId;
  if (!tabStorage) {
    cachedTabId = 'unknown';
    return cachedTabId;
  }
  try {
    const existing = tabStorage.getItem(TAB_ID_KEY);
    if (existing) {
      cachedTabId = existing;
      return cachedTabId;
    }
  } catch {
    cachedTabId = 'unknown';
    return cachedTabId;
  }
  const created = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    tabStorage.setItem(TAB_ID_KEY, created);
  } catch {
    // 写不进去也不影响这次会话
  }
  cachedTabId = created;
  return cachedTabId;
}

function storeKey(): string {
  return `${STORE_KEY_PREFIX}:${tabId()}`;
}

/**
 * 会话键：按标签页，不按地址。
 * 同一个 URL 的两个标签页是两个不同的键；刷新同一标签页还是原来的键。
 */
export function conversationKey(): string {
  return `tab:${tabId()}`;
}

function trim(messages: ChatMessage[]): ChatMessage[] {
  const clipped = messages.slice(-MAX_MESSAGES).map((message) => ({
    ...message,
    content: message.content.length > MAX_CONTENT
      ? `${message.content.slice(0, MAX_CONTENT)}…（已截断）`
      : message.content,
  }));

  // 工具调用与它的结果必须成对：接口要求每个 tool_call 都有一条对应的 tool 消息。
  // 截断时如果正好切开了这一对，要把它整条丢掉（不然下一次请求会被接口拒掉）。
  const answered = new Set<string>();
  for (const message of clipped) {
    if (message.role === 'tool' && message.toolCallId) answered.add(message.toolCallId);
  }
  return clipped.filter((message) => {
    if (message.role === 'tool') return answered.has(message.toolCallId ?? '');
    // assistant 消息带着还没结果的 tool_calls 也要丢
    if (message.toolCalls && message.toolCalls.length > 0) {
      return message.toolCalls.every((call) => answered.has(call.id));
    }
    return true;
  });
}

/** 读本标签页的整份存储（坏数据一律当空） */
function readStore(): Store {
  if (!tabStorage) return {};
  try {
    const raw = tabStorage.getItem(storeKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store | null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写回本标签页的整份存储 */
function writeStore(store: Store): void {
  if (!tabStorage) return;
  try {
    tabStorage.setItem(storeKey(), JSON.stringify(store));
  } catch {
    // 配额满了就把每个桶压到最近 10 条重存一次，总比每次都失败强
    try {
      const trimmed: Store = {};
      for (const [key, messages] of Object.entries(store)) trimmed[key] = messages.slice(-10);
      tabStorage.setItem(storeKey(), JSON.stringify(trimmed));
    } catch {
      // 还是存不下就放弃这次落盘，内存里的对话还在
    }
  }
}

/**
 * 一轮对话（requestId）对应的存盘键。
 *
 * 赶题模式（/fuck）会在题目之间来回跳，整页跳转后面板会重新挂载，
 * 后台按 requestId 把这一轮接回来（chat/attach）。所以一轮进行中的对话
 * 另外按 requestId 存一份，刷新/换题后能接回去。
 */
export function runConversationKey(requestId: string): string {
  return `run:${requestId}`;
}

/** 取出这个标签页上的对话（没有就是空数组） */
export async function loadMessages(bucket?: string): Promise<ChatMessage[]> {
  const store = readStore();
  // 存盘里记着当时是不是还在流式输出，恢复时一律当成结束了（刷新后没有流了）
  return (store[bucket ?? conversationKey()] ?? []).map((message) => ({ ...message, streaming: false }));
}

/** 把这个标签页上的对话写回去 */
export async function saveMessages(messages: ChatMessage[], bucket?: string): Promise<void> {
  const store = readStore();
  const key = bucket ?? conversationKey();
  const next: Store = { ...store };
  if (messages.length === 0) delete next[key];
  else next[key] = trim(messages);
  writeStore(next);
}

/** 清掉这个标签页上的对话（「新会话」按钮用） */
export async function clearMessages(bucket?: string): Promise<void> {
  const store = readStore();
  const next: Store = { ...store };
  delete next[bucket ?? conversationKey()];
  writeStore(next);
}
