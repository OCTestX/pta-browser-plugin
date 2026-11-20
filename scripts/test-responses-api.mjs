// OpenAI Responses 协议的纯逻辑单测：消息转换、工具转换、SSE 事件解析。
// 用法：node scripts/test-responses-api.mjs
import {
  consumeResponsesEvent,
  createResponsesState,
  responsesToolCalls,
  toResponsesInput,
  toResponsesTools,
} from '../src/shared/responses-api.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ---- 1. 消息转换 ----
const input = toResponsesInput([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '你好' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_problem', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: '题面' },
  { role: 'assistant', content: '好的' },
]);
check('system / user 原样进去', input[0].role === 'system' && input[1].role === 'user', input.slice(0, 2));
check(
  'assistant 的工具调用拆成 function_call 项',
  input.some((item) => item.type === 'function_call' && item.call_id === 'call_1' && item.name === 'read_problem'),
  input,
);
check(
  '工具结果变成 function_call_output，call_id 对得上',
  input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_1' && item.output === '题面'),
  input,
);
check('没有正文的 assistant 不会塞空 message', !input.some((item) => item.role === 'assistant' && !item.content && !item.type));
check('空内容的消息被跳过', toResponsesInput([{ role: 'user', content: '   ' }]).length === 0);

// ---- 2. 工具定义 ----
const tools = toResponsesTools([
  { type: 'function', function: { name: 'run', description: '跑代码', parameters: { type: 'object', properties: {} } } },
]);
check('工具定义是扁平的（没有 function 包装）', tools[0].type === 'function' && tools[0].name === 'run' && !('function' in tools[0]), tools[0]);
check('参数 schema 原样带过去', JSON.stringify(tools[0].parameters) === '{"type":"object","properties":{}}');

// ---- 3. SSE 事件解析 ----
const state = createResponsesState();
const deltas = [];
const onDelta = (text) => deltas.push(text);

consumeResponsesEvent(JSON.stringify({ type: 'response.created' }), state, onDelta);
consumeResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: '你' }), state, onDelta);
consumeResponsesEvent(JSON.stringify({ type: 'response.output_text.delta', delta: '好' }), state, onDelta);
check('文本增量拼起来并回调', state.content === '你好' && deltas.join('') === '你好', { content: state.content, deltas });

consumeResponsesEvent(
  JSON.stringify({
    type: 'response.output_item.added',
    item: { type: 'function_call', id: 'item_1', call_id: 'call_9', name: 'read_problem', arguments: '' },
  }),
  state,
  onDelta,
);
consumeResponsesEvent(
  JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"a"' }),
  state,
  onDelta,
);
consumeResponsesEvent(
  JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: ':1}' }),
  state,
  onDelta,
);
const calls = responsesToolCalls(state);
check('工具名与参数拼完整', calls.length === 1 && calls[0].function.name === 'read_problem' && calls[0].function.arguments === '{"a":1}', calls);
check('工具 id 用 call_id（下一轮 tool 结果才对得上）', calls[0].id === 'call_9', calls[0]);

// done 里带完整参数：以它为准
consumeResponsesEvent(
  JSON.stringify({
    type: 'response.output_item.done',
    item: { type: 'function_call', id: 'item_1', call_id: 'call_9', name: 'read_problem', arguments: '{"a":2}' },
  }),
  state,
  onDelta,
);
check('done 事件里的完整参数覆盖分片', responsesToolCalls(state)[0].function.arguments === '{"a":2}', responsesToolCalls(state));

consumeResponsesEvent(
  JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }),
  state,
  onDelta,
);
check('用量按 Responses 的字段名读出来', state.usage?.promptTokens === 10 && state.usage?.completionTokens === 4 && state.usage?.totalTokens === 14, state.usage);

// ---- 4. 错误 ----
let threw = '';
try {
  consumeResponsesEvent(JSON.stringify({ type: 'response.failed', response: { error: { message: '额度不足' } } }), createResponsesState(), onDelta, 'gpt');
} catch (error) {
  threw = error.message;
}
check('失败事件抛错并带上原因', threw.includes('额度不足'), threw);

check('认不出的事件不炸也不改状态', (() => {
  const s2 = createResponsesState();
  consumeResponsesEvent(JSON.stringify({ type: 'response.in_progress' }), s2, onDelta);
  return s2.content === '' && s2.calls.size === 0;
})());

console.log('\n全部通过');
