// 带上 .ts 后缀：这个模块会被 scripts/test-compile.mjs 直接用 Node 导入（Node 不做省略后缀解析）
import { truncate } from '../shared/tools.ts';

/**
 * 编译并运行 C 代码。
 *
 * 浏览器插件里放不下真正的本地编译器：clang 的 wasm 加上 sysroot 上百 MB，
 * 而且 MV3 不允许从远端加载 wasm 代码。所以这里走「编译服务」：默认用 Judge0 的公共实例
 * （开源、可自建，协议也是事实标准），设置里可以把地址换成自建的或学校的内网服务。
 */
export interface CompileOptions {
  code: string;
  stdin: string;
  serviceURL: string;
  languageId: number;
  signal?: AbortSignal;
}

/** Judge0 的状态码 */
const STATUS = {
  1: '排队中',
  2: '运行中',
  3: '运行成功',
  4: '答案错误',
  5: '运行超时',
  6: '编译错误',
  7: '运行时错误（SIGSEGV 等信号）',
  8: '运行时错误（SIGXFSZ）',
  9: '运行时错误（SIGFPE）',
  10: '运行时错误（SIGABRT）',
  11: '运行时错误（NZEC）',
  12: '运行时错误（其它）',
  13: '服务内部错误',
  14: '可执行文件格式错误',
} as const;

interface Judge0Response {
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  memory?: number | null;
  status?: { id?: number; description?: string } | null;
}

export interface CompileResult {
  /** 编译并运行成功（Judge0 status 3） */
  ok: boolean;
  statusText: string;
  stdout: string;
  stderr: string;
  compileOutput: string;
  message: string;
  time: string;
  memory: number | null;
}

export async function compileAndRun(options: CompileOptions): Promise<CompileResult> {
  const { code, stdin, serviceURL, languageId, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${serviceURL}/submissions?base64_encoded=false&wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_code: code, language_id: languageId, stdin }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error(`连不上编译服务 ${serviceURL}，请检查网络或设置里的服务地址`);
  }

  const raw = await response.text().catch(() => '');
  if (!response.ok) {
    throw new Error(describeHttpError(response.status, raw));
  }

  let parsed: Judge0Response;
  try {
    parsed = JSON.parse(raw) as Judge0Response;
  } catch {
    throw new Error(`编译服务返回的不是 JSON（前 200 字）：${raw.slice(0, 200)}`);
  }

  return toResult(parsed);
}

function toResult(result: Judge0Response): CompileResult {
  const statusId = result.status?.id ?? 0;
  return {
    ok: statusId === 3,
    statusText: STATUS[statusId as keyof typeof STATUS] ?? result.status?.description ?? '未知状态',
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
    compileOutput: (result.compile_output ?? '').trim(),
    message: (result.message ?? '').trim(),
    time: result.time ?? '',
    memory: typeof result.memory === 'number' ? result.memory : null,
  };
}

export function formatCompileResult(result: CompileResult): string {
  const parts: string[] = [];
  const cost = [
    result.time ? `耗时 ${result.time}s` : '',
    result.memory === null ? '' : `内存 ${Math.round(result.memory / 1024)}KB`,
  ]
    .filter(Boolean)
    .join('，');
  parts.push(`编译服务返回：${result.statusText}${cost ? `（${cost}）` : ''}`);

  if (result.message) parts.push(`服务消息：${result.message}`);

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

function describeHttpError(status: number, detail: string): string {
  if (status === 401 || status === 403) return '编译服务拒绝了这个请求（401/403），可能需要令牌或换自建服务';
  if (status === 429) return '编译服务限流了（429），稍后再试，或在设置里换成自建服务';
  const brief = detail.slice(0, 200).replace(/\s+/g, ' ');
  return `编译服务返回 HTTP ${status}${brief ? `：${brief}` : ''}`;
}
