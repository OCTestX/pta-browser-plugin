// 长对话压缩：系统提示保留、按预算保留最近消息、不留下孤儿 tool 消息。
// 纯函数，Node 剥类型后直接导入 .ts。
// 用法：node scripts/test-context-window.mjs
import { compactConversation } from '../src/shared/context-window.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const system = (text) => ({ role: 'system', content: text });
const user = (text) => ({ role: 'user', content: text });
const assistant = (text, calls) => ({
  role: 'assistant',
  content: text ?? null,
  ...(calls ? { tool_calls: calls } : {}),
});
const tool = (id, text) => ({ role: 'tool', tool_call_id: id, content: text });

// 预算内不动
const small = [system('S'), user('U'), assistant('A')];
const before = JSON.stringify(small);
check('没超预算时原样返回', compactConversation(small, 10_000) === false && JSON.stringify(small) === before);

// 超预算：系统保留、插入压缩说明、最近消息保留
const big = [system('SYSTEM-RULES')];
for (let index = 0; index < 40; index += 1) {
  big.push(user(`question-${index}`));
  big.push(assistant(`answer-${index}`));
}
const sizeBefore = JSON.stringify(big).length;
const compacted = compactConversation(big, 300);
check('超预算时会压缩', compacted === true, compacted);
check('系统提示保留', big[0].content === 'SYSTEM-RULES');
check('插入了压缩说明', big[1].role === 'system' && big[1].content.includes('历史已压缩'), big[1]);
check('最近一条消息还在', big[big.length - 1].content === 'answer-39', big[big.length - 1]);
check('压缩后总字符数明显变小', JSON.stringify(big).length < sizeBefore, { before: sizeBefore, after: JSON.stringify(big).length });

// 截断点落在 tool 上时，要退到发起它的 assistant，不能留下孤儿 tool
const withTools = [system('S')];
for (let index = 0; index < 10; index += 1) {
  const id = `call-${index}`;
  withTools.push(user(`q-${index}`));
  withTools.push(assistant(null, [{ id, type: 'function', function: { name: 'read_problem', arguments: '{}' } }]));
  withTools.push(tool(id, `result-${index}-`.repeat(30)));
}
compactConversation(withTools, 500);
const firstBody = withTools.find((message, index) => index > 1 && message.role !== 'system');
check('压缩后第一条正文不是孤儿 tool 消息', firstBody?.role !== 'tool', firstBody);
const toolMessages = withTools.filter((message) => message.role === 'tool');
check('保留下来的 tool 消息前都有对应 assistant', toolMessages.every((message) => {
  const index = withTools.indexOf(message);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (withTools[cursor].role === 'assistant') return true;
    if (withTools[cursor].role !== 'tool') return false;
  }
  return false;
}));

// 最后一条自己就超预算时也要留下，不能把当前任务删空
const giant = [system('S'), user('x'.repeat(5000))];
compactConversation(giant, 100);
check('单条超预算时至少保留最后一条', giant.some((message) => message.role === 'user' && message.content.length === 5000), giant.map((m) => [m.role, m.content?.length]));

console.log('\n上下文压缩通过');
