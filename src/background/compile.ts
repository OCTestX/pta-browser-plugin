// 带上 .ts 后缀：这个模块会被 scripts/test-compile.mjs 直接用 Node 导入（Node 不做省略后缀解析）
import { truncate } from '../shared/tools.ts';
import { runInEngine, type EngineRunResult } from './compiler-host.ts';

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
 * 内置 Python 运行器：Node 环境用 python3 子进程；浏览器环境回退到提示信息。
 */
export interface PyCompileOptions {
  code: string;
  stdin: string;
  signal?: AbortSignal;
}

export async function compileAndRunPython(options: PyCompileOptions): Promise<CompileResult> {
  const { code, stdin, signal } = options;

  // 浏览器环境：没有 python3，提示借用 PTA 模拟运行
  const g = globalThis as { process?: { versions?: { node?: string } } };
  const hasNode = !!g.process?.versions?.node;
  if (!hasNode) {
    return {
      ok: false,
      statusText: 'Python 运行时未内置',
      stdout: '',
      stderr: '',
      compileOutput: '',
      message: '当前环境没有内置 Python 运行时，请改用 read_pta_compile_result / simulate_pta_run 借用 PTA 的编译与模拟运行。',
      time: '',
      memory: null,
    };
  }

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
