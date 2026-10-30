// 内置运行器的 Worker 侧。
//
// 两套引擎：
//   - C/C++：clang + lld + sysroot 都是本地 wasm 资源，串行处理「编译 + 运行」请求
//   - Python：本地 Pyodide（public/engine/pyodide/ 下的资源），直接解释执行
//
// 超时终止由宿主负责（worker.terminate 整个杀掉，死循环只有这样才能停下来）。
//
// 协议（postMessage）：
//   收 { id, code, stdin, lang }
//   回 { id, type: 'stage', stage }   阶段推进（compile / run），宿主据此重置超时
//      { id, type: 'done', result }   结构化结果（含编译错误 / 运行结果 / 引擎错误）

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

/* ---------- Python（Pyodide，本地资源） ---------- */

let pyodidePromise = null;

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      // pyodide.mjs 是 ESM，动态 import 它；indexURL 指向本地目录，
      // 这样 wasm 与 python_stdlib.zip 都从扩展包里读，不联网
      const { loadPyodide } = await import('./pyodide/pyodide.mjs');
      return loadPyodide({ indexURL: new URL('./pyodide/', self.location.href).href });
    })().catch((error) => {
      pyodidePromise = null; // 下次重试
      throw error;
    });
  }
  return pyodidePromise;
}

async function runPython({ id, code, stdin }) {
  const started = Date.now();
  postMessage({ id, type: 'stage', stage: 'run' });

  let stdout = '';
  let stderr = '';
  let error = null;

  try {
    const py = await getPyodide();

    // Pyodide 的 stdin 要按行喂：input() 一次取一行
    const lines = (stdin || '').split('\n');
    let lineIndex = 0;
    py.setStdin({
      stdin: () => (lineIndex < lines.length ? `${lines[lineIndex++]}\n` : ''),
    });

    const outChunks = [];
    const errChunks = [];
    py.setStdout({ batched: (text) => { outChunks.push(text); } });
    py.setStderr({ batched: (text) => { errChunks.push(text); } });

    await py.runPythonAsync(code);

    stdout = outChunks.join('');
    stderr = errChunks.join('');
  } catch (e) {
    error = e && e.message ? e.message : String(e);
    // 异常信息往往在 stderr 里，模型要看到堆栈
    if (!stderr && error) stderr = error;
  }

  postMessage({
    id,
    type: 'done',
    result: {
      stage: error ? 'run-exit' : 'ok',
      stdout,
      stderr,
      compileOutput: '',
      exitCode: error ? 1 : 0,
      trap: null,
      message: error || '',
      elapsedMs: Date.now() - started,
    },
  });
}

/* ---------- C ---------- */

async function handle(ev) {
  const { id, code, stdin, lang } = ev.data ?? {};
  if (typeof id !== 'number' || typeof code !== 'string') return;

  if (lang === 'python') {
    await runPython({ id, code, stdin: typeof stdin === 'string' ? stdin : '' });
    return;
  }

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
