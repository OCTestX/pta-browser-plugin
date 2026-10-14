// 内置 C 编译引擎核心：clang(wasm) + wasm-ld(wasm) + wasi-libc sysroot，
// 编译、链接、运行全部在本地 WebAssembly 里完成，不联网。
//
// 本文件被两端共用：
//   - compile-worker.js（浏览器里的 Web Worker）
//   - scripts/test-compile.mjs（Node 里直接跑，验证引擎与资源）
//
// 改编自 cppstudio-io/wasm-clang-runtime（Apache-2.0）的
// compiler-bridge.js / compile-worker.js，改成 C 专用并补上 stderr 分流。

import { API } from './shared.js';

/** clang22-noeh / lld22-noeh：剥掉 exnref 异常处理指令的版本，
 *  Chrome 63+/Firefox 115+ 都能跑（标准版要 Chrome 125+）。 */
export const ENGINE_CONFIG = Object.freeze({
  clang: 'clang22-noeh',
  lld: 'lld22-noeh',
  sysroot: 'sysroot22.tar',
  memfs: 'memfs',
  clangResourceInclude: '/lib/clang/22/include',
  lldLibdir: 'lib/wasm32-wasip1',
  lldFlags: Object.freeze(['--export-dynamic']),
  // C 程序：libc + 编译器 builtins，不需要 C++ 那套
  lldLibs: Object.freeze(['-lc', '-lclang_rt.builtins']),
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** 引擎日志上限：防病态输出把内存吃爆（上游同款防线） */
const LOG_CAP = 8 * 1024 * 1024;
/** memfs 里的文件只增不减，跑多了由 Worker 重建引擎防膨胀 */
export const MAX_RUNS_PER_ENGINE = 100;

/**
 * 建一个引擎实例（含 memfs、sysroot 解包）。
 * @param {{ readBuffer: (name: string) => Promise<ArrayBuffer>,
 *           compileStreaming: (name: string) => Promise<WebAssembly.Module>,
 *           hostWrite?: (text: string) => void }} options
 *   readBuffer 按名字读资源（clang22-noeh / lld22-noeh / sysroot22.tar / memfs）；
 *   引擎建一次要几秒（加载 + 解包 38MB sysroot），调用方应复用。
 */
export function createCEngine(options) {
  const log = { text: '', truncated: false };
  const hostWrite = (text) => {
    if (options.hostWrite) options.hostWrite(text);
    if (log.truncated) return;
    log.text += text;
    if (log.text.length > LOG_CAP) {
      log.truncated = true;
      log.text += '\n[引擎输出过大，已截断]\n';
    }
  };
  const api = new API({
    readBuffer: options.readBuffer,
    compileStreaming: options.compileStreaming,
    hostWrite,
    ...ENGINE_CONFIG,
  });
  return { api, log, runs: 0 };
}

const emptyResult = (stage, elapsedMs) => ({
  stage, stdout: '', stderr: '', compileOutput: '',
  exitCode: 0, trap: null, message: '', elapsedMs,
});

/**
 * 在引擎上编译并运行一段 C 代码，返回结构化结果。
 * 结果的 stage 取值：
 *   ok            编译链接运行全部成功
 *   compile-error 编译失败（compileOutput 里是 clang 诊断）
 *   link-error    链接失败
 *   run-exit      运行完成但退出码非零
 *   run-trap      运行崩溃（野指针 / 除零等 wasm trap）
 *   engine-error  引擎自身出错（调用方应丢弃引擎重建）
 * @param {{ api: object, log: { text: string, truncated: boolean }, runs: number }} engine
 * @param {{ code: string, stdin?: string, onStage?: (stage: 'compile' | 'run') => void }} request
 */
export async function runOnEngine(engine, request) {
  const { api, log } = engine;
  engine.runs += 1;
  const name = `pta${engine.runs}`;
  const input = `${name}.c`;
  const obj = `${name}.o`;
  const wasm = `${name}.wasm`;
  const stdin = typeof request.stdin === 'string' ? request.stdin : '';
  const started = Date.now();
  const strip = (text) => text.replace(ANSI_RE, '');

  /* ---------- 编译 ---------- */
  if (request.onStage) request.onStage('compile');
  let startLen = log.text.length;
  try {
    await api.compile({ input, contents: request.code, obj });
  } catch (exn) {
    // clang 报错：进程以非零码退出（ProcExit），诊断文本已写进日志
    if (typeof exn?.code === 'number' && exn.code !== 0) {
      const result = emptyResult('compile-error', Date.now() - started);
      result.compileOutput = strip(log.text.slice(startLen)).trim();
      return result;
    }
    // 引擎本身崩了（wasm trap / 内存不够）
    const result = emptyResult('engine-error', Date.now() - started);
    result.message = exn?.message ?? String(exn);
    return result;
  }

  /* ---------- 链接 ---------- */
  startLen = log.text.length;
  try {
    await api.link(obj, wasm);
  } catch {
    const result = emptyResult('link-error', Date.now() - started);
    result.compileOutput = strip(log.text.slice(startLen)).trim();
    return result;
  }

  /* ---------- 运行 ---------- */
  if (request.onStage) request.onStage('run');
  api.memfs.setStdinStr(stdin);
  const buffer = api.memfs.getFileContents(wasm);
  const program = await WebAssembly.compile(buffer);

  startLen = log.text.length;
  let stderr = '';
  api.memfs.stderrSink = (text) => { stderr += text; };
  let exitCode = 0;
  let trap = null;
  try {
    // 退出码 0：App.run 内部吞掉 ProcExit(0) 正常返回
    await api.run(program, wasm);
  } catch (exn) {
    if (typeof exn?.code === 'number') exitCode = exn.code;
    else trap = exn?.message ?? String(exn);
  } finally {
    api.memfs.stderrSink = null;
  }

  // 程序 stdout = 日志切片去掉首行命令回显、App.run 追加的 Error 尾块
  let stdout = strip(log.text.slice(startLen));
  stdout = stdout.replace(/^> [^\n]*\.wasm\n/, '');
  stdout = stdout.replace(/\n?Error: process exited with code \d+\.\n?$/, '');
  if (trap !== null) {
    stdout = stdout.replace(/\n?Error: [^\n]*(\n\s+at [^\n]*)*\n?$/, '');
  }
  stdout = stdout.replace(/^\n+/, '');

  const result = emptyResult(
    trap !== null ? 'run-trap' : exitCode !== 0 ? 'run-exit' : 'ok',
    Date.now() - started,
  );
  result.stdout = stdout;
  result.stderr = stderr.trim();
  result.exitCode = exitCode;
  result.trap = trap;
  return result;
}
