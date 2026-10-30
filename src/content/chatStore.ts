/**
 * 对话记录的持久化。
 *
 * 之前对话只活在 React 的 state 里：页面一刷新（或者 PTA 自己重新加载），
 * 整段对话就没了，用户得从头再说一遍。这里把消息写进 chrome.storage.local，
 * 刷新后按页面地址恢复。
 *
 * 按地址分桶：同一个题目的地址恢复同一段对话，换一道题就是新的一段，
 * 不会把别的题的上下文串过来。
 */

import { ext } from '../shared/browser';
import type { ChatMessage } from '../shared/types';

const STORE_KEY = 'pta-assistant-chat';

/** 一次最多保留多少条消息：工具结果很长，全存会把配额撑爆 */
const MAX_MESSAGES = 60;
/** 单条消息最多保留多少字符（工具结果最长 4000 字符，截一半足够看清） */
const MAX_CONTENT = 8000;

type Store = Record<string, ChatMessage[]>;

/** 会话键：页面地址去掉 hash（hash 不影响题目） */
export function conversationKey(): string {
  if (typeof location === 'undefined') return 'unknown';
  return `${location.origin}${location.pathname}${location.search}`;
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

/**
 * 读整份存储。每次都重新读，不留内存缓存：
 * 同一道题可能在两个标签页里开着，各留一份缓存会互相覆盖对方的对话。
 */
async function readStore(): Promise<Store> {
  const result = await ext.storage.local.get([STORE_KEY]);
  const stored = result[STORE_KEY] as Store | undefined;
  return stored && typeof stored === 'object' ? stored : {};
}

/** 取出这个页面上的对话（没有就是空数组） */
export async function loadMessages(): Promise<ChatMessage[]> {
  const store = await readStore();
  // 存盘里记着当时是不是还在流式输出，恢复时一律当成结束了（刷新后没有流了）
  return (store[conversationKey()] ?? []).map((message) => ({ ...message, streaming: false }));
}

/** 把这个页面上的对话写回去 */
export async function saveMessages(messages: ChatMessage[]): Promise<void> {
  const store = await readStore();
  const next: Store = { ...store };
  if (messages.length === 0) delete next[conversationKey()];
  else next[conversationKey()] = trim(messages);
  try {
    await ext.storage.local.set({ [STORE_KEY]: next });
  } catch {
    // 配额满了就把这个页面的历史丢掉重存一次，总比每次都失败强
    const trimmed: Store = { ...next };
    trimmed[conversationKey()] = trim(messages).slice(-10);
    await ext.storage.local.set({ [STORE_KEY]: trimmed });
  }
}

/** 清掉这个页面上的对话（「新会话」按钮用） */
export async function clearMessages(): Promise<void> {
  const store = await readStore();
  const next: Store = { ...store };
  delete next[conversationKey()];
  await ext.storage.local.set({ [STORE_KEY]: next });
}
