// 带上 .ts 后缀：这个模块会被 scripts/test-compile.mjs 直接用 Node 导入（Node 不做省略后缀解析）
import { truncate } from '../shared/tools.ts';
import {
  parseClangDiagnostics,
  offsetOfPosition,
  isFragmentContextDiagnostic,
  type CodeDiagnostic,
} from '../shared/code-diagnostics.ts';
import { checkJava } from '../shared/java-diagnostics.ts';
import type { DiagnosticBox } from '../shared/editor-assist-protocol.ts';
import { runInEngine, checkInEngine, type EngineRunResult, type EngineStage } from './compiler-host.ts';

/**
 * 内置 JavaScript 运行器：在本地用浏览器/Node 的 JS 引擎跑一段代码，捕获 stdout/stderr。
 * 不联网、代码不出本机。
 */
export interface JsCompileOptions {
  code: string;
  stdin: string;
  signal?: AbortSignal;
}

export async function compileAndRunJs(options: JsCompileOptions): Promise<CompileResult> {
  const { code, stdin, signal } = options;
  const started = Date.now();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const lines = (stdin || '').split('\n');
  let stdinIndex = 0;
  const readline = () => (stdinIndex < lines.length ? lines[stdinIndex++] : '');
  const formatArg = (value: unknown): string =>
    typeof value === 'string' ? value : (() => {
      try { return JSON.stringify(value); } catch { return String(value); }
    })();
  const consoleObj = {
    log: (...a: unknown[]) => stdout.push(a.map(formatArg).join(' ') + '\n'),
    error: (...a: unknown[]) => stderr.push(a.map(formatArg).join(' ') + '\n'),
    warn: (...a: unknown[]) => stderr.push(a.map(formatArg).join(' ') + '\n'),
    info: (...a: unknown[]) => stdout.push(a.map(formatArg).join(' ') + '\n'),
  };

  // PTA 的 JS 题常按 Node 写：require('readline')、process.stdin。这里给一套够用的垫片，
  // 让「本地能跑」和 PTA 上的 Node 行为尽量一致，而不是只支持 console.log/readline() 两个全局。
  const sourceLines = lines.slice();
  if (sourceLines.length > 0 && sourceLines[sourceLines.length - 1] === '') sourceLines.pop();
  const processObj = {
    argv: ['node', 'main.js'],
    env: {} as Record<string, string>,
    stdin: {
      on(event: string, callback: (value?: string) => void) {
        if (event === 'data') callback(stdin || '');
        else if (event === 'end') callback();
        return this;
      },
      once(event: string, callback: (value?: string) => void) { return this.on(event, callback); },
      setEncoding() { return this; },
      resume() { return this; },
      pause() { return this; },
    },
    stdout: { write: (text: unknown) => { stdout.push(String(text)); return true; } },
    stderr: { write: (text: unknown) => { stderr.push(String(text)); return true; } },
    exit(code = 0) { throw new Error(`process.exit(${code})`); },
    nextTick(callback: () => void) { queueMicrotask(callback); },
  };
  const requireShim = (name: unknown): unknown => {
    const id = String(name).replace(/^node:/, '');
    if (id === 'readline') {
      return {
        createInterface() {
          const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
          const emit = (event: string, ...args: unknown[]) => {
            for (const handler of handlers.get(event) ?? []) handler(...args);
          };
          const api = {
            on(event: string, callback: (...args: unknown[]) => void) {
              if (!handlers.has(event)) handlers.set(event, []);
              handlers.get(event)?.push(callback);
              if (event === 'line') sourceLines.forEach((line) => callback(line));
              if (event === 'close') queueMicrotask(() => callback());
              return api;
            },
            once(event: string, callback: (...args: unknown[]) => void) { return api.on(event, callback); },
            close() { emit('close'); },
            question(_question: string, callback: (answer: string) => void) {
              callback(sourceLines[stdinIndex++] ?? '');
            },
            setPrompt() { return api; },
            prompt() { return api; },
          };
          return api;
        },
      };
    }
    if (id === 'fs') {
      return {
        readFileSync: () => stdin,
        readFile: (_path: unknown, callback: (error: null, data: string) => void) => callback(null, stdin),
      };
    }
    if (id === 'process') return processObj;
    throw new Error(`require('${String(name)}') 在内置 JS 运行器里不可用`);
  };

  if (signal?.aborted) throw new Error('已停止');
  let error: string | null = null;
  // readline 不能当函数参数传：用户在代码里常写 `const readline = require('readline')`，
  // 参数名会被 const 重声明直接报「Identifier 'readline' has already been declared」。
  // 临时挂到 globalThis 上，老代码里直接调 readline() 也还能用；执行完就还原。
  const runtimeGlobal = globalThis as unknown as Record<string, unknown>;
  const hadReadline = Object.prototype.hasOwnProperty.call(runtimeGlobal, 'readline');
  const previousReadline = runtimeGlobal.readline;
  try {
    runtimeGlobal.readline = readline;
    // 用 AsyncFunction 支持顶层 await；执行完再放一帧，让 readline 的 close / nextTick 跑完
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    const fn = new AsyncFunction(
      'console', 'stdin', 'process', 'require', 'module', 'exports', code,
    );
    const moduleObj = { exports: {} as unknown };
    const r = await fn(
      consoleObj, stdin || '', processObj, requireShim, moduleObj, moduleObj.exports,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (r !== undefined) stdout.push(String(r) + '\n');
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (hadReadline) runtimeGlobal.readline = previousReadline;
    else delete runtimeGlobal.readline;
  }

  const time = `${((Date.now() - started) / 1000).toFixed(2)}`;
  const base = {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    compileOutput: '',
    message: error ? error : '',
    time,
    memory: null,
  } as const;

  if (error) {
    return { ...base, ok: false, statusText: '运行时错误', message: error };
  }
  return { ...base, ok: true, statusText: '运行成功' };
}

/**
 * 内置 Python 运行器：用本地 Pyodide（随插件打包，不联网）解释执行。
 * Node 环境（测试脚本）没有 Pyodide，退回 python3 子进程。
 */
export interface PyCompileOptions {
  code: string;
  stdin: string;
  signal?: AbortSignal;
}

/** 当前是否跑在 Node（测试脚本）：Node 里没有 Worker / offscreen，也没有 Pyodide */
function hasNodeRuntime(): boolean {
  const g = globalThis as { process?: { versions?: { node?: string } } };
  return !!g.process?.versions?.node;
}

export async function compileAndRunPython(options: PyCompileOptions): Promise<CompileResult> {
  const { code, stdin, signal } = options;

  // Node 环境：没有 Worker / offscreen，用 python3 子进程跑（仓库里的测试脚本走这条）
  if (hasNodeRuntime()) {
    return runPythonWithNode(code, stdin, signal);
  }

  // 浏览器环境：走内置引擎（Pyodide）
  let raw: EngineRunResult;
  try {
    raw = await runInEngine(code, stdin, signal, 'python');
  } catch (error) {
    // 超时 / 引擎不可用：给出带阶段的结构化结果，别把「等太久」变成一个异常字符串
    const failed = engineFailureResult(error);
    if (!failed) throw error;
    return failed;
  }

  if (raw.stage === 'engine-error') {
    return {
      ok: false,
      stage: 'engine-error',
      statusText: '内置 Python 运行时出错',
      stdout: raw.stdout,
      stderr: raw.stderr,
      compileOutput: raw.compileOutput,
      message: raw.message || '内置 Python 运行时内部错误',
      time: raw.elapsedMs > 0 ? `${(raw.elapsedMs / 1000).toFixed(2)}` : '',
      memory: null,
    };
  }

  const time = raw.elapsedMs > 0 ? `${(raw.elapsedMs / 1000).toFixed(2)}` : '';
  const base = { stdout: raw.stdout, stderr: raw.stderr, compileOutput: '', message: '', time, memory: null } as const;

  if (raw.stage === 'ok') return { ...base, ok: true, statusText: '运行成功' };
  if (raw.stage === 'run-trap') {
    return { ...base, ok: false, statusText: '运行时错误（程序崩溃）', message: (raw.trap ?? '').split('\n')[0] };
  }
  return {
    ...base,
    ok: false,
    statusText: '运行时错误',
    message: raw.message || raw.stderr || 'Python 程序运行失败',
  };
}

/** Node 环境的 Python：起一个 python3 子进程 */
async function runPythonWithNode(code: string, stdin: string, signal?: AbortSignal): Promise<CompileResult> {
  const started = Date.now();
  const modName = 'node:child_process';
  const { spawn } = await import(modName);
  return new Promise<CompileResult>((resolve) => {
    const child = spawn('python3', ['-u', '-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: unknown) => { stdout += String(d); });
    child.stderr.on('data', (d: unknown) => { stderr += String(d); });
    child.on('close', (codeNum: number) => {
      const time = `${((Date.now() - started) / 1000).toFixed(2)}`;
      const ok = codeNum === 0;
      resolve({
        ok,
        statusText: ok ? '运行成功' : `运行时错误（退出码 ${codeNum}）`,
        stdout,
        stderr,
        compileOutput: '',
        message: '',
        time,
        memory: null,
      });
    });
    child.on('error', (err: { message: string }) => {
      resolve({
        ok: false,
        statusText: '运行时错误',
        stdout: '',
        stderr: '',
        compileOutput: '',
        message: err.message,
        time: '',
        memory: null,
      });
    });
    if (signal) {
      signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
    }
    try { child.stdin.write(stdin || ''); child.stdin.end(); } catch {}
  });
}

/** Node 侧 Python 检查脚本回给 JS 的 JSON（error 为 null 表示语法没问题） */
interface PythonCheckPayload {
  error?: { line?: unknown; column?: unknown; message?: unknown } | null;
}

/**
 * Node 环境的 Python 语法检查：起 python3 只做 compile(source, '<pta>', 'exec')，不执行代码。
 *
 * 浏览器里走 compile-worker.js 的 Pyodide 分支；两边给出同一种结构化输出
 * `<pta>:行:列: error: 说明`，checkCode 的解析与测试才能共用一条路。
 * 导出给 scripts/test-compile.mjs 直接验证「只编译不执行」。
 */
export async function checkPythonWithNode(source: string, signal?: AbortSignal): Promise<EngineRunResult> {
  const started = Date.now();
  // 平台相关模块：静态 import 会把 node:child_process 带进浏览器构建，只能运行期加载
  const modName = 'node:child_process';
  const { spawn } = await import(modName);
  // 与 compile-worker.js 里的 __pta_compile_check 保持一致：
  // compile 只检查语法；行号从 1 开始，列号换算成 UTF-8 字节（offsetOfPosition 按字节解释）
  const script = [
    'import json, sys',
    'source = sys.stdin.buffer.read().decode("utf-8")',
    'payload = None',
    'try:',
    '    compile(source, "<pta>", "exec")',
    'except (SyntaxError, IndentationError, TabError) as error:',
    '    message = getattr(error, "msg", "") or str(error)',
    '    line = getattr(error, "lineno", None) or 1',
    '    text = getattr(error, "text", None) or ""',
    '    offset = getattr(error, "offset", None) or 1',
    '    indent = len(text) - len(text.lstrip(" \\t"))',
    '    if indent:',
    '        offset = max(offset, indent + 1)',
    '    prefix = text[:max(0, offset - 1)]',
    '    payload = {"line": line, "column": len(prefix.encode("utf-8")) + 1, "message": message}',
    'except ValueError as error:',
    '    payload = {"line": 1, "column": 1, "message": str(error)}',
    'print(json.dumps({"error": payload}))',
  ].join('\n');

  return new Promise<EngineRunResult>((resolve) => {
    const child = spawn('python3', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: unknown) => { stdout += String(d); });
    child.stderr.on('data', (d: unknown) => { stderr += String(d); });

    const finish = (result: Partial<EngineRunResult> & { stage: EngineRunResult['stage'] }): void => {
      resolve({
        stdout: '',
        stderr: '',
        compileOutput: '',
        exitCode: 0,
        trap: null,
        message: '',
        elapsedMs: Date.now() - started,
        ...result,
      });
    };

    child.on('error', (error: { message: string }) => {
      finish({ stage: 'engine-error', message: `Python 语法检查起不来：${error.message}` });
    });
    child.on('close', () => {
      // 只认最后一行：解释器启动时的杂音（sitecustomize 之类）不该把结果搅坏
      const lastLine = stdout.trim().split('\n').at(-1) ?? '';
      let parsed: PythonCheckPayload | null = null;
      try {
        parsed = JSON.parse(lastLine || 'null') as PythonCheckPayload | null;
      } catch {
        parsed = null;
      }
      if (!parsed || !('error' in parsed)) {
        finish({ stage: 'engine-error', message: stderr.trim() || 'python3 没有返回检查结果' });
        return;
      }
      const detail = parsed.error;
      if (!detail) {
        finish({ stage: 'ok' });
        return;
      }
      const line = Number(detail.line) || 1;
      const column = Number(detail.column) || 1;
      const message = String(detail.message ?? '语法错误');
      finish({
        stage: 'compile-error',
        exitCode: 1,
        compileOutput: `<pta>:${line}:${column}: error: ${message}\n`,
      });
    });
    if (signal) {
      signal.addEventListener('abort', () => { try { child.kill(); } catch {} }, { once: true });
    }
    try { child.stdin.write(source); child.stdin.end(); } catch {}
  });
}

/**
 * 编译并运行 C 代码——内置编译器（Clang 22 编译成 WebAssembly）在本地完成，
 * 不联网、代码不出本机。之前版本走 Judge0 在线服务，v0.9 起换成了内置。
 */
export interface CompileOptions {
  code: string;
  stdin: string;
  signal?: AbortSignal;
}

/**
 * 失败发生在哪一步。页面和模型据此区分「编译器忙」「加载太慢」「编译太慢」「程序死循环」：
 *   queue / prepare / compile / check / run 是超时阶段（来自宿主的 EngineTimeout）
 *   engine-error 是引擎自己出错
 */
export type CompileStage = EngineStage | 'engine-error';

export interface CompileResult {
  /** 编译并运行成功（退出码 0） */
  ok: boolean;
  statusText: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  message: string;
  time: string;
  /** 内置引擎不统计内存，恒为 null（保留字段是为了不惊动老调用方） */
  memory: null;
  /** 失败时停在哪一步；成功时不带这个字段 */
  stage?: CompileStage;
}

const COMPILE_STAGES: readonly CompileStage[] = ['queue', 'prepare', 'compile', 'check', 'run', 'engine-error'];

/** 引擎超时错误上的 stage（Error 没这个字段，先查再取，别硬转） */
function errorStage(error: Error): CompileStage | undefined {
  if (!('stage' in error)) return undefined;
  return COMPILE_STAGES.find((item) => item === error.stage);
}

/** 超时的一句话状态：界面上先看这句就知道卡在哪一步 */
function timeoutStatusText(stage: CompileStage | undefined): string {
  if (stage === 'run') return '运行超时';
  if (stage === 'check') return '检查超时';
  if (stage === 'queue') return '内置引擎忙（排队超时）';
  if (stage === 'prepare') return '引擎加载超时';
  return '编译超时';
}

/**
 * 引擎层的失败（超时 / 请求发不出去 / 没有 Worker）换成结构化结果。
 * 抛异常只会剩下一个字符串，把「等了多久、卡在哪一步」全丢掉，模型和页面都读不出信息。
 * 返回 null 表示这不是引擎失败（例如用户按了停止），调用方原样抛出。
 * 导出给 scripts/test-compile.mjs 直接验证，不需要真机。
 */
export function engineFailureResult(error: unknown): CompileResult | null {
  if (!(error instanceof Error)) return null;
  // 用户按「停止」不是编译器的问题，保持中止语义
  if (error.name === 'AbortError') return null;

  const base = { stdout: '', stderr: '', compileOutput: '', time: '', memory: null } as const;
  if (error.name === 'EngineTimeout') {
    const stage = errorStage(error);
    return { ...base, ok: false, stage: stage ?? 'compile', statusText: timeoutStatusText(stage), message: error.message };
  }

  return { ...base, ok: false, stage: 'engine-error', statusText: '内置编译器不可用', message: error.message };
}

/**
 * 引擎结果 → 给模型 / 页面看的结果。编译错误一律把 clang 原文（compileOutput）带上；
 * 引擎中途炸掉时，崩之前已经打出来的那截诊断也带回去，别只留一句「内部错误」。
 * 导出给 scripts/test-compile.mjs 直接验证。
 */
export function toCompileResult(raw: EngineRunResult): CompileResult {
  const time = raw.elapsedMs > 0 ? `${(raw.elapsedMs / 1000).toFixed(2)}` : '';
  const base = { stdout: raw.stdout, stderr: raw.stderr, compileOutput: '', message: '', time, memory: null } as const;

  switch (raw.stage) {
    case 'compile-error':
      return {
        ...base,
        ok: false,
        stage: 'compile',
        statusText: '编译错误',
        compileOutput: raw.compileOutput,
        // 诊断被日志上限截断时至少说清原因，别只回一句「编译错误」让模型猜
        message: raw.compileOutput ? '' : raw.message || '编译器报错退出，但没有给出诊断文本',
      };
    case 'link-error':
      return { ...base, ok: false, stage: 'compile', statusText: '链接错误', compileOutput: raw.compileOutput };
    case 'run-exit':
      return { ...base, ok: false, stage: 'run', statusText: `运行时错误（退出码 ${raw.exitCode}）` };
    case 'run-trap':
      return { ...base, ok: false, stage: 'run', statusText: '运行时错误（程序崩溃）', message: (raw.trap ?? '').split('\n')[0] };
    case 'engine-error':
      return {
        ...base,
        ok: false,
        stage: 'engine-error',
        statusText: '内置编译器错误',
        compileOutput: raw.compileOutput,
        message: raw.message || '内置编译器内部错误',
      };
    case 'ok':
      return { ...base, ok: true, statusText: '运行成功' };
  }
}

export async function compileAndRun(options: CompileOptions): Promise<CompileResult> {
  return runCWithEngine(options, 'c');
}

/**
 * 编译并运行 C++ 代码——同一套 Clang 22 + libc++，`-x c++ -std=c++17`。
 * 与 C 共用一个 wasm 引擎（sysroot 里已经带 libc++ 头与静态库）。
 */
export async function compileAndRunCpp(options: CompileOptions): Promise<CompileResult> {
  return runCWithEngine(options, 'cpp');
}

/** C / C++ 共用的引擎调用与结果归一化 */
async function runCWithEngine(options: CompileOptions, lang: 'c' | 'cpp'): Promise<CompileResult> {
  const { code, stdin, signal } = options;

  let raw: EngineRunResult;
  try {
    raw = await runInEngine(code, stdin, signal, lang);
  } catch (error) {
    // 超时 / 引擎不可用 → 带 stage 的结构化结果；用户按停止仍然是异常
    const failed = engineFailureResult(error);
    if (!failed) throw error;
    return failed;
  }

  return toCompileResult(raw);
}

/** 实时检查的结果：给页面脚本直接画波浪线用 */
export interface CodeCheckResult {
  ok: boolean;
  /** 非空表示这次没检查（比如语言不是 C），只更新一行提示文案 */
  note: string;
  diagnostics: DiagnosticBox[];
  errorCount: number;
  message: string;
  /** 失败时停在哪一步（超时阶段 / 引擎出错）；正常检查不带这个字段 */
  stage?: CompileStage;
}

/**
 * 实时检查的语言：
 *   · C / C++ 走内置 clang（-x c / -x c++）
 *   · Python 走内置 Pyodide 的 compile()，只检查语法、不执行
 *   · Java 没有内置编译器，只做括号 / 分号这类规则检查
 */
export type CheckLanguage = 'c' | 'cpp' | 'python' | 'java';

export function checkLanguage(language: string): CheckLanguage | null {
  const lang = String(language ?? '').trim().toLowerCase();
  // Python 的题面语言标记常见 `Python (python3)` / `python3` / `py3`
  if (/python/.test(lang) || /^py3?\b/.test(lang)) return 'python';
  // Java 常见 `Java` / `Java (javac 17)`；`javascript` 不算（java 后面没有词边界）
  if (/^java\b/.test(lang) || /\bjavac\b/.test(lang)) return 'java';
  // C++ 必须先判：'c++' 也会被 /^c\b/ 命中（c 与 + 之间是词边界）
  if (/^(c\+\+|cpp|cxx)\b/.test(lang) || /\bc\+\+/.test(lang)) return 'cpp';
  if (/^c\b/.test(lang) || /gcc|clang/.test(lang)) return 'c';
  return null;
}

export function isCheckableLanguage(language: string): boolean {
  return checkLanguage(language) !== null;
}

/**
 * 诊断指向的那一段字符：用来画波浪线。
 *
 * clang 说「这一行少了分号」时把位置指在**行尾**，落点其实是换行符——直接当字符下标用，
 * 区间会跨到下一行，页面那边「跨行不画」的判断会把整条诊断吃掉（实测就是这样：
 * 底部报了错，代码里一条波浪线都没有）。所以落点先往回退到本行最后一个非空白字符。
 *
 * 往前退不能跨过行首：缩进错误报在第 2 行的空格上时，退过头会把波浪线画到第 1 行末尾。
 *
 * 落在标识符/数字上就一直取到标识符结束，否则取到行尾的空白或分隔符之前（最多 40 字符）。
 */
export function diagnosticRange(code: string, from: number): { from: number; to: number } {
  const source = String(code ?? '');
  if (source.length === 0) return { from: 0, to: 0 };
  let start = Math.max(0, Math.min(from, source.length - 1));
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  while (start > lineStart && /[\s]/.test(source[start])) start -= 1;
  const lineEnd = source.indexOf('\n', start) < 0 ? source.length : source.indexOf('\n', start);
  const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(start, lineEnd));
  if (word) return { from: start, to: start + word[0].length };
  let to = start;
  while (to < lineEnd && to - start < 40 && !/[\s;,)}]/.test(source[to])) to += 1;
  return { from: start, to: to > start ? to : Math.min(start + 1, source.length) };
}

/** clang 原文里的第一句诊断：用来在角落提示里说清「哪里错了」，别只留一句「检查失败」 */
function firstDiagnosticLine(output: string): string {
  const lines = String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^Error: process exited with code \d+\.$/.test(line));
  const first = lines.find((line) => line.includes('error:')) ?? lines[0] ?? '';
  return first.slice(0, 300);
}

/** Python 片段插进裁判程序后的缩进层级未知，这类报错在片段模式下不算学生的错 */
const PYTHON_INDENT_DIAGNOSTIC =
  /unexpected indent|expected an indented block|unindent does not match|inconsistent use of tabs/i;

/**
 * 引擎结果 → 前端诊断。C/C++ 与 Python 共用：
 * 两边给的都是 `<文件>:行:列: 级别: 正文`，列号按 UTF-8 字节算。
 */
function engineCheckResult(
  source: string,
  raw: EngineRunResult,
  skip: (item: CodeDiagnostic) => boolean,
): CodeCheckResult {
  // clang 的原文可能一条都解析不出来（位置越界、日志被截断），那时才用「第一句原文」兜底；
  // 解析出来但被 fragment 过滤掉的假「未声明」不能以此为由再露出来
  const parsed = parseClangDiagnostics(raw.compileOutput);
  const diagnostics: DiagnosticBox[] = [];
  for (const item of parsed) {
    // note 是编译器跟在报错后面、指在同一位置的补充说明（「include 这个头文件」之类），
    // 它和那条报错算同一件事，单独算一条只会让「N 个错误」翻倍
    if (item.severity === 'note') continue;
    if (skip(item)) continue;
    // 列号是 UTF-8 字节偏移，offsetOfPosition 负责换算成字符下标
    const offset = offsetOfPosition(source, item.line, item.column);
    if (offset < 0) continue;
    const range = diagnosticRange(source, offset);
    diagnostics.push({
      from: range.from,
      to: range.to,
      severity: item.severity,
      message: item.message,
      advice: item.advice,
    });
  }
  const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
  const empty: CodeCheckResult = { ok: true, note: '', diagnostics: [], errorCount: 0, message: '' };

  if (raw.stage === 'engine-error') {
    // 引擎崩之前往往已经打出了真诊断：先把能画线的画出来，再在提示里说明引擎出错
    return {
      ...empty,
      ok: false,
      stage: 'engine-error',
      diagnostics,
      errorCount,
      message: raw.message || '内置编译器内部错误',
    };
  }
  // 报错了却一条诊断都解析不出来（日志被截断 / 原文格式不认识）：
  // 把原文第一句带到提示里，界面不能安安静静什么都不说
  if (raw.stage === 'compile-error' && parsed.length === 0) {
    return {
      ...empty,
      stage: 'compile',
      diagnostics,
      errorCount,
      message: firstDiagnosticLine(raw.compileOutput) || '编译失败，但没有可解析的诊断',
    };
  }
  return { ok: true, note: '', diagnostics, errorCount, message: '' };
}

/**
 * 给作答区代码做一次「只检查不运行」的实时检查。
 *
 * C / C++ 用内置 clang；Python 用内置 Pyodide 的 compile(..., 'exec')；
 * Java 没有内置编译器，只返回规则检查（note 里写明）。
 * 别的语言返回 note 让界面如实显示。
 */
export async function checkCode(
  code: string,
  language: string,
  signal?: AbortSignal,
  fragment = false,
): Promise<CodeCheckResult> {
  const source = String(code ?? '');
  const empty: CodeCheckResult = { ok: true, note: '', diagnostics: [], errorCount: 0, message: '' };
  const lang = checkLanguage(language);
  if (!lang) {
    return { ...empty, note: '实时检查支持 C / C++ / Python / Java，其他语言不做检查' };
  }
  if (source.trim() === '') return empty;

  // Java：不调用引擎，规则检查是纯函数，失败也画得出线
  if (lang === 'java') {
    const diagnostics = checkJava(source);
    return {
      ok: true,
      note: 'Java 无内置编译器，仅规则检查',
      diagnostics,
      errorCount: diagnostics.filter((item) => item.severity === 'error').length,
      message: '',
    };
  }

  let raw: EngineRunResult;
  try {
    if (lang === 'python') {
      // 浏览器走 Pyodide（Worker 里只 compile 不执行）；Node 测试环境没有 Pyodide，退回 python3
      raw = hasNodeRuntime()
        ? await checkPythonWithNode(source, signal)
        : await checkInEngine(source, signal, 'python');
    } else {
      // 代码填空题的作答区只是题面裁判程序的一部分：printf/puts 这些头在裁判程序里，
      // 独立检查时强制带上常用头，避免报一屏假「未声明」。
      raw = await checkInEngine(source, signal, lang, fragment);
    }
  } catch (error) {
    // 超时 / 编译器忙 / 引擎不可用：带回 stage 和一句能看懂的说明，页面会把它显示在角落
    const failed = engineFailureResult(error);
    if (!failed) throw error;
    return { ...empty, ok: false, stage: failed.stage, message: failed.message };
  }

  return engineCheckResult(source, raw, (item) => {
    // 代码填空片段依赖题面/裁判提供的类型、常量、宏：独立编译的「未声明」是假报错，
    // 直接丢掉；真正的语法错误（少分号、括号不配对等）继续上报
    if ((lang === 'c' || lang === 'cpp') && fragment && item.severity === 'error') {
      return isFragmentContextDiagnostic(item.message);
    }
    // Python 片段：缩进取决于插入位置，unexpected indent 这类报错不算学生的错
    if (lang === 'python' && fragment) return PYTHON_INDENT_DIAGNOSTIC.test(item.message);
    return false;
  });
}

export function formatCompileResult(result: CompileResult): string {
  const parts: string[] = [];
  const cost = result.time ? `耗时 ${result.time}s` : '';
  parts.push(`内置编译器返回：${result.statusText}${cost ? `（${cost}）` : ''}`);

  if (result.message) parts.push(`说明：${result.message}`);

  if (result.compileOutput) {
    parts.push('', '编译错误：', '```', truncate(result.compileOutput, 2000), '```');
    return parts.join('\n');
  }

  // 编译阶段失败了却连一句诊断都没有：别让模型看到一片空白后自己猜
  if (!result.ok && !result.message && (result.stage === 'compile' || result.stage === 'engine-error')) {
    parts.push('', '编译器没有给出诊断文本（可能是引擎日志被截断）。');
  }

  if (result.stdout) {
    parts.push('', '运行输出：', '```', truncate(result.stdout, 4000), '```');
  }
  if (result.stderr) {
    parts.push('', '标准错误：', '```', truncate(result.stderr, 2000), '```');
  }
  if (!result.stdout && !result.stderr && result.ok) {
    parts.push('', '程序没有产生任何输出。');
  }
  return parts.join('\n');
}

/** 比对样例输出：尾部空白和末尾空行不算差异 */
export function compareOutput(expected: string, actual: string): { same: boolean; detail: string } {
  const normalize = (value: string): string[] => {
    const lines = value
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''));
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    return lines;
  };

  const want = normalize(expected);
  const got = normalize(actual);
  const mismatch = want.findIndex((line, index) => line !== (got[index] ?? '\u0000'));

  if (mismatch === -1 && want.length === got.length) return { same: true, detail: '' };

  const at = mismatch === -1 ? Math.min(want.length, got.length) : mismatch;
  const brief = (line: string | undefined) =>
    line === undefined ? '（没有这一行）' : line.length > 60 ? `${line.slice(0, 60)}…` : line;
  return {
    same: false,
    detail: `第 ${at + 1} 行不同：期望「${brief(want[at])}」，实际「${brief(got[at])}」`,
  };
}
