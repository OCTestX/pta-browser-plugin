/**
 * 长对话压缩：赶题模式一跑就是几十道题，工具结果会把上下文撑爆。
 *
 * 策略很保守：
 *   · 系统提示（角色设定、/fuck 规矩）全部保留；
 *   · 从最新一条往前按字符预算装，装到预算为止；
 *   · 截断点落在 tool 消息上时往前退到发起它的 assistant，避免留下「没有
 *     assistant tool_calls 的孤儿 tool 消息」——接口会直接拒绝这种历史；
 *   · 丢掉的部分用一条 system 消息说明，模型知道前面被省略了。
 *
 * 纯函数，Node 里可以直接单测。
 */

import type { ApiMessage } from './types';

/** 估算一条消息占多少字符（tool_calls 的参数也要算） */
function messageSize(message: ApiMessage): number {
  const content = typeof message.content === 'string' ? message.content : '';
  const calls = message.tool_calls ?? [];
  let size = content.length;
  for (const call of calls) {
    size += String(call.function?.name ?? '').length + String(call.function?.arguments ?? '').length;
  }
  return size;
}

/**
 * 原地压缩 conversation。返回是否真的压缩过。
 *
 * @param maxChars 保留的非系统消息大约占多少字符；默认 120k，给模型留出输出与工具调用的余量。
 */
export function compactConversation(conversation: ApiMessage[], maxChars = 120_000): boolean {
  const systemMessages = conversation.filter((message) => message.role === 'system');
  const body = conversation.filter((message) => message.role !== 'system');
  const systemSize = systemMessages.reduce((sum, message) => sum + messageSize(message), 0);
  const bodySize = body.reduce((sum, message) => sum + messageSize(message), 0);
  if (systemSize + bodySize <= maxChars) return false;

  // 从尾部往前装
  let tailStart = body.length;
  let kept = systemSize;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    kept += messageSize(body[index]);
    if (kept > maxChars) break;
    tailStart = index;
  }
  // 一条都装不下时至少留最后一条，否则会把当前任务也删掉
  if (tailStart >= body.length) tailStart = Math.max(0, body.length - 1);
  // 不要把 tool 消息和它的 assistant 拆开
  while (tailStart > 0 && body[tailStart]?.role === 'tool') tailStart -= 1;

  const dropped = tailStart;
  const summary: ApiMessage = {
    role: 'system',
    content: `【历史已压缩】为了不撑爆上下文，前面 ${dropped} 条旧消息（大多是已经做完的题的工具结果）已省略；`
      + '当前题目、最近的判题结论与统计以这之后的消息为准。',
  };
  conversation.splice(0, conversation.length, ...systemMessages, summary, ...body.slice(tailStart));
  return true;
}
