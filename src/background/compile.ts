// 带上 .ts 后缀：这个模块会被 scripts/test-compile.mjs 直接用 Node 导入（Node 不做省略后缀解析）
import { truncate } from '../shared/tools.ts';
import { parseClangDiagnostics, offsetOfPosition } from '../shared/code-diagnostics.ts';
import type { DiagnosticBox } from '../shared/editor-assist-protocol.ts';
import { runInEngine, checkInEngine, type EngineRunResult } from './compiler-host.ts';

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
  const consoleObj = {
    log: (...a: unknown[]) => stdout.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => stderr.push(a.map(String).join(' ')),
    warn: (...a: unknown[]) => stderr.push(a.map(String).join(' ')),
  };

  if (signal?.aborted) throw new Error('已停止');
  let error: string | null = null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('console', 'readline', 'stdin', code);
    const r = fn(consoleObj, readline, stdin || '');
    if (r !== undefined) stdout.push(String(r));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const time = `${((Date.now() - started) / 1000).toFixed(2)}`;
  const base = {
    stdout: stdout.join('\n') + (stdout.length ? '\n' : ''),
    stderr: stderr.join('\n') + (stderr.length ? '\n' : ''),
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

export async function compileAndRunPython(options: PyCompileOptions): Promise<CompileResult> {
  const { code, stdin, signal } = options;

  // Node 环境：没有 Worker / offscreen，用 python3 子进程跑（仓库里的测试脚本走这条）
  const g = globalThis as { process?: { versions?: { node?: string } } };
  const hasNode = !!g.process?.versions?.node;
  if (hasNode) {
    return runPythonWithNode(code, stdin, signal);
  }

  // 浏览器环境：走内置引擎（Pyodide）
  let raw: EngineRunResult;
  try {
    raw = await runInEngine(code, stdin, signal, 'python');
  } catch (error) {
    if (error instanceof Error && error.name === 'EngineTimeout') {
      return {
        ok: false,
        statusText: '运行超时',
        stdout: '',
        stderr: '',
        compileOutput: '',
        message: error.message,
        time: '',
        memory: null,
      };
    }
    throw error;
  }

  if (raw.stage === 'engine-error') {
    throw new Error(raw.message || '内置 Python 运行时内部错误');
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

/**
 * 编译并运行 C 代码——内置编译器（Clang 22 编译成 WebAssembly）在本地完成，
 * 不联网、代码不出本机。之前版本走 Judge0 在线服务，v0.9 起换成了内置。
 */
export interface CompileOptions {
  code: string;
  stdin: string;
  signal?: AbortSignal;
}

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
}

export async function compileAndRun(options: CompileOptions): Promise<CompileResult> {
  const { code, stdin, signal } = options;

  let raw: EngineRunResult;
  try {
    raw = await runInEngine(code, stdin, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'EngineTimeout') {
      return {
        ok: false,
        statusText: '运行超时',
        stdout: '',
        stderr: '',
        compileOutput: '',
        message: error.message,
        time: '',
        memory: null,
      };
    }
    throw error;
  }

  if (raw.stage === 'engine-error') {
    throw new Error(raw.message || '内置编译器内部错误');
  }

  const time = raw.elapsedMs > 0 ? `${(raw.elapsedMs / 1000).toFixed(2)}` : '';
  const base = { stdout: raw.stdout, stderr: raw.stderr, compileOutput: '', message: '', time, memory: null } as const;

  switch (raw.stage) {
    case 'compile-error':
      return { ...base, ok: false, statusText: '编译错误', compileOutput: raw.compileOutput };
    case 'link-error':
      return { ...base, ok: false, statusText: '链接错误', compileOutput: raw.compileOutput };
    case 'run-exit':
      return { ...base, ok: false, statusText: `运行时错误（退出码 ${raw.exitCode}）` };
    case 'run-trap':
      return { ...base, ok: false, statusText: '运行时错误（程序崩溃）', message: (raw.trap ?? '').split('\n')[0] };
    case 'ok':
      return { ...base, ok: true, statusText: '运行成功' };
  }
}

/** 实时检查的结果：给页面脚本直接画波浪线用 */
export interface CodeCheckResult {
  ok: boolean;
  /** 非空表示这次没检查（比如语言不是 C），只更新一行提示文案 */
  note: string;
  diagnostics: DiagnosticBox[];
  errorCount: number;
  message: string;
}

/** 内置编译器只有 C 的驱动配置，别的语言不做实时检查，如实说明 */
export function isCheckableLanguage(language: string): boolean {
  const lang = String(language ?? '').toLowerCase();
  // 'c' / 'C (gcc)' / 'gcc' / 'clang' 算 C；'cpp' 'c++' 'python' 'java' 都不算
  return /^c\b/.test(lang) || /gcc|clang/.test(lang);
}

/**
 * 诊断指向的那一段字符：用来画波浪线。
 *
 * clang 说「这一行少了分号」时把位置指在**行尾**，落点其实是换行符——直接当字符下标用，
 * 区间会跨到下一行，页面那边「跨行不画」的判断会把整条诊断吃掉（实测就是这样：
 * 底部报了错，代码里一条波浪线都没有）。所以落点先往回退到本行最后一个非空白字符。
 *
 * 落在标识符/数字上就一直取到标识符结束，否则取到行尾的空白或分隔符之前（最多 40 字符）。
 */
export function diagnosticRange(code: string, from: number): { from: number; to: number } {
  const source = String(code ?? '');
  if (source.length === 0) return { from: 0, to: 0 };
  let start = Math.max(0, Math.min(from, source.length - 1));
  while (start > 0 && /[\s]/.test(source[start])) start -= 1;
  const lineEnd = source.indexOf('\n', start) < 0 ? source.length : source.indexOf('\n', start);
  const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(start, lineEnd));
  if (word) return { from: start, to: start + word[0].length };
  let to = start;
  while (to < lineEnd && to - start < 40 && !/[\s;,)}]/.test(source[to])) to += 1;
  return { from: start, to: to > start ? to : Math.min(start + 1, source.length) };
}

/**
 * 用内置编译器给作答区代码做一次「只编译不运行」的检查。
 * 只支持 C（引擎的 clang 驱动硬编码 -x c），别的语言返回 note 让界面如实显示。
 */
export async function checkCode(code: string, language: string, signal?: AbortSignal): Promise<CodeCheckResult> {
  const source = String(code ?? '');
  const empty: CodeCheckResult = { ok: true, note: '', diagnostics: [], errorCount: 0, message: '' };
  if (!isCheckableLanguage(language)) {
    return { ...empty, note: '内置编译器只支持 C，其他语言不做实时检查' };
  }
  if (source.trim() === '') return empty;

  let raw: EngineRunResult;
  try {
    raw = await checkInEngine(source, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'EngineTimeout') return { ...empty, ok: false, message: error.message };
    throw error;
  }
  if (raw.stage === 'engine-error') {
    return { ...empty, ok: false, message: raw.message || '内置编译器内部错误' };
  }

  const diagnostics: DiagnosticBox[] = [];
  for (const item of parseClangDiagnostics(raw.compileOutput)) {
    // note 是 clang 跟在报错后面、指在同一位置的补充说明（「include 这个头文件」之类），
    // 它和那条报错算同一件事，单独算一条只会让「N 个错误」翻倍
    if (item.severity === 'note') continue;
    // clang 的列号是 UTF-8 字节偏移，offsetOfPosition 负责换算成字符下标
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
  return {
    ok: true,
    note: '',
    diagnostics,
    errorCount: diagnostics.filter((item) => item.severity === 'error').length,
    message: '',
  };
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
