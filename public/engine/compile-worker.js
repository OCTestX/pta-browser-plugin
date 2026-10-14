// 内置 C 编译器的 Worker 侧：加载引擎（clang / lld / sysroot 都是本地资源），
// 串行处理「编译 + 运行」请求。超时终止由宿主负责（worker.terminate 整个杀掉，
// 死循环只有这样才能停下来）。
//
// 协议（postMessage）：
//   收 { id, code, stdin }
//   回 { id, type: 'stage', stage }   阶段推进（compile / run），宿主据此重置超时
//      { id, type: 'done', result }   结构化结果（含编译错误 / 运行结果 / 引擎错误）
//
// 引擎在 memfs 里的文件只增不减，跑满 MAX_RUNS_PER_ENGINE 次后重建一次。

import { createCEngine, runOnEngine, MAX_RUNS_PER_ENGINE } from './engine-core.js';

let engine = null;
let enginePromise = null;

async function readBuffer(name) {
  const response = await fetch(new URL(name, self.location.href));
  if (!response.ok) {
    throw new Error(`加载编译器资源 ${name} 失败（HTTP ${response.status}）`);
  }
  return response.arrayBuffer();
}

async function compileStreaming(name) {
  return WebAssembly.compile(await readBuffer(name));
}

function getEngine() {
  if (engine && engine.runs < MAX_RUNS_PER_ENGINE) return Promise.resolve(engine);
  engine = null;
  if (!enginePromise) {
    enginePromise = (async () => {
      const made = createCEngine({ readBuffer, compileStreaming });
      await made.api.ready; // 这里会把 38MB 的 sysroot 解进 memfs
      engine = made;
      return made;
    })().finally(() => { enginePromise = null; });
  }
  return enginePromise;
}

async function handle(ev) {
  const { id, code, stdin } = ev.data ?? {};
  if (typeof id !== 'number' || typeof code !== 'string') return;

  let current;
  try {
    current = await getEngine();
  } catch (error) {
    postMessage({ id, type: 'done', result: {
      stage: 'engine-error',
      message: `内置编译器加载失败：${error?.message ?? error}`,
    } });
    return;
  }

  const result = await runOnEngine(current, {
    code,
    stdin: typeof stdin === 'string' ? stdin : '',
    onStage: (stage) => postMessage({ id, type: 'stage', stage }),
  });

  if (result.stage === 'engine-error') engine = null; // 下次重建
  postMessage({ id, type: 'done', result });
}

// 引擎单线程，一次只跑一个请求；队列化防并发把日志切片搅乱
let queue = Promise.resolve();
self.onmessage = (ev) => {
  queue = queue.then(() => handle(ev)).catch(() => undefined);
};
