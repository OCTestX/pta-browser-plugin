// 直接跑 src 里的 TS（依赖 Node 22.18+ 的类型擦除），用假的 fetch 验证 SSE 解析与错误映射。
// 用法：node scripts/test-deepseek.mjs
const { streamChat } = await import('../src/background/deepseek.ts');

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const encoder = new TextEncoder();
function sseResponse(chunks, status = 200) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

const collect = async (chunks, status) => {
  global.fetch = async () => sseResponse(chunks, status);
  const deltas = [];
  await streamChat({
    apiKey: 'sk-x',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4.1-flash',
    turns: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    onDelta: (t) => deltas.push(t),
  });
  return deltas.join('');
};

// 1. 正常流：事件被切成任意边界（含 \r\n、半行）
const raw =
  'data: {"choices":[{"delta":{"content":"第一"}}]}\r\n\r\n' +
  'data: {"choices":[{"delta":{"content":"段"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"内容"}}]}\n\n' +
  'data: [DONE]\n\n';
const text = await collect([raw.slice(0, 20), raw.slice(20, 60), raw.slice(60), 'garbage line\n']);
check('跨 chunk 的半行能正确拼接', text === '第一段内容');

check('忽略没有 choices 的行', (await collect(['data: {"id":"x"}\n\ndata: [DONE]\n\n'])) === '');

// 2. HTTP 错误映射
const expectError = async (chunks, status, keyword) => {
  global.fetch = async () =>
    new Response(chunks.join(''), { status });
  try {
    await streamChat({
      apiKey: 'sk-x',
      baseURL: 'https://api.deepseek.com',
      model: 'm',
      turns: [],
      signal: new AbortController().signal,
      onDelta: () => {},
    });
  } catch (error) {
    check(`${status} -> ${keyword}`, error.message.includes(keyword));
    return;
  }
  throw new Error(`✗ ${status} 没有抛错`);
};
await expectError(['unauthorized'], 401, 'API Key 无效');
await expectError(['insufficient balance'], 402, '余额不足');
await expectError(['slow down'], 429, '429');

// 3. 流里带 error 字段
try {
  await collect(['data: {"error":{"message":"model not found"}}\n\n']);
  throw new Error('✗ 没有抛出流内错误');
} catch (error) {
  check('流内的 error 字段会抛错', error.message.includes('model not found'));
}

// 4. 网络错误
global.fetch = async () => {
  throw new TypeError('fetch failed');
};
try {
  await streamChat({
    apiKey: 'sk-x',
    baseURL: 'https://api.deepseek.com',
    model: 'm',
    turns: [],
    signal: new AbortController().signal,
    onDelta: () => {},
  });
  throw new Error('✗ 网络错误没有转换提示');
} catch (error) {
  check('网络错误转成中文提示', error.message.includes('无法连接'));
}

// 5. 中途停止
const controller = new AbortController();
global.fetch = async (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () =>
      reject(new DOMException('aborted', 'AbortError')),
    );
  });
const pending = streamChat({
  apiKey: 'sk-x',
  baseURL: 'https://api.deepseek.com',
  model: 'm',
  turns: [],
  signal: controller.signal,
  onDelta: () => {},
});
controller.abort();
try {
  await pending;
  throw new Error('✗ 停止后没有抛出 AbortError');
} catch (error) {
  check('停止生成抛出 AbortError 交给上层处理', error.name === 'AbortError');
}

console.log('\nSSE 解析校验通过');
