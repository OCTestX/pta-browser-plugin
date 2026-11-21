// 接口上下文的两条纯逻辑校验：
//   · sanitizeApiMessages：工具调用与工具结果必须成对，缺一个接口就 400
//   · toApiContext：交给面板存着、下一轮原样再发的那份上下文长什么样
// 用法：node scripts/test-api-context.mjs
import { sanitizeApiMessages, toApiContext } from '../src/shared/types.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `(实际:${JSON.stringify(detail).slice(0, 400)})`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const assistant = (content, calls, reasoning) => ({
  role: 'assistant',
  content: content ?? null,
  ...(calls ? { tool_calls: calls } : {}),
  ...(reasoning ? { reasoning_content: reasoning } : {}),
});
const call = (id) => ({ id, type: 'function', function: { name: 'ask', arguments: '{}' } });
const tool = (id, content) => ({ role: 'tool', tool_call_id: id, content });

/* ---------- sanitizeApiMessages：工具调用与工具结果必须成对 ---------- */

const paired = sanitizeApiMessages([assistant('在', [call('c1')]), tool('c1', '选好了')]);
check('成对的工具调用原样留下', paired.length === 2 && paired[1].tool_call_id === 'c1');

// 这一轮被中途打断：assistant 记下了调用，结果还没回灌
const interrupted = sanitizeApiMessages([assistant('在', [call('c1')])]);
check(
  '没有结果的工具调用被摘掉，assistant 退化成普通回复',
  interrupted.length === 1 && interrupted[0].tool_calls === undefined,
  interrupted,
);

// 同一个 assistant 挂了两个调用，只回来一个：另一个摘掉，assistant 留着
const halfAnswered = sanitizeApiMessages([
  assistant('在', [call('c1'), call('c2')]),
  tool('c1', '选好了'),
]);
check(
  '只回了一部分结果的调用被摘掉，剩下的配对不动',
  halfAnswered.length === 2 && halfAnswered[0].tool_calls?.length === 1 && halfAnswered[0].tool_calls[0].id === 'c1',
  halfAnswered,
);

// 发起者被丢掉的 tool 消息不能留在里面（接口会直接拒）
const orphan = sanitizeApiMessages([tool('c1', '选好了')]);
check('找不到发起者的 tool 消息被丢掉', orphan.length === 0, orphan);

// 没有 tool_call_id 的 tool 消息也是废的
const noId = sanitizeApiMessages([tool('', 'x')]);
check('没有 tool_call_id 的 tool 消息被丢掉', noId.length === 0, noId);

// 思维链不能被顺手改掉
const withReasoning = sanitizeApiMessages([
  assistant('在', [call('c1')], '想了一下'),
  tool('c1', '选好了'),
]);
check('思维链原样保留', withReasoning[0].reasoning_content === '想了一下', withReasoning[0]);

/* ---------- toApiContext：面板存的那份上下文 ---------- */

const context = toApiContext([
  { role: 'system', content: '系统提示' },
  { role: 'user', content: '帮我做这道题' },
  assistant('我先看看', [call('c1')], '想了一下'),
  tool('c1', '用户选择了「改」'),
  assistant('改好了', null, '再想了一下'),
]);
check('系统提示不进上下文（下一轮由后台重新拼在最前面）', context.every((m) => m.role !== 'system'), context);
check('用户消息与工具结果都在', context.length === 4, context.map((m) => m.role));
check('思维链跟着上下文一起走', context[1].reasoning_content === '想了一下', context[1]);

// 图片消息（content 是内容块数组）下一轮不用再发一遍
const withImage = toApiContext([
  { role: 'user', content: '看图' },
  { role: 'user', content: [{ type: 'text', text: '题面图' }, { type: 'image_url', image_url: { url: 'http://x/a.png' } }] },
  assistant('看到了', null),
]);
check('图片内容块的消息不进上下文', withImage.length === 2, withImage);

// 既没有正文也没有工具调用的 assistant 是空壳
const emptyAssistant = toApiContext([
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null },
]);
check('空壳 assistant 被丢掉', emptyAssistant.length === 1, emptyAssistant);

// 打断的一轮：assistant 记下了调用，结果没回来
const broken = toApiContext([
  { role: 'user', content: 'hi' },
  assistant('在', [call('c1')], '想了一下'),
]);
check('打断的一轮留下的落单调用被清掉', broken.length === 2 && broken[1].tool_calls === undefined, broken);
check('打断的一轮思维链仍然留着', broken[1].reasoning_content === '想了一下', broken[1]);

console.log('\n接口上下文校验通过');
