import { ext } from '../shared/browser';

export interface InjectResult {
  ok: boolean;
  output: string;
  world: 'MAIN' | 'ISOLATED';
}

const EXECUTE_TIMEOUT_MS = 15_000;
/** 等判题的脚本要在页面里跑很久，允许调用方放宽 */
const MAX_EXECUTE_TIMEOUT_MS = 180_000;

/**
 * 页面侧的取消标记：每次注入前清零，用户点「停止」时置 true。
 * executeScript 一旦发出去就没法撤回，页面里那些轮询循环只能靠这个标记自己退出。
 */
const ABORT_FLAG = '__ptaAborted';

const ABORTED = { aborted: true } as const;

/** 通知页面里正在跑的脚本收工（两个世界都置上，主世界失败时还有隔离世界兜底） */
async function raiseAbortFlag(tabId: number): Promise<void> {
  for (const world of ['MAIN', 'ISOLATED'] as const) {
    try {
      await ext.scripting.executeScript({
        target: { tabId },
        world,
        func: (flag: string) => { (globalThis as unknown as Record<string, unknown>)[flag] = true; },
        args: [ABORT_FLAG],
      });
    } catch {
      // 页面已经关掉 / 注入不了：后台这边照样放弃等待
    }
  }
}

/** 与 abort 赛跑：中止时先给页面发取消标记，再立刻把等待结果交还给调用方 */
async function raceAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
  tabId: number,
): Promise<T | typeof ABORTED> {
  // 这里只能 new Promise：工程的 lib 是 ES2022，没有 Promise.withResolvers
  let detach: () => void = () => {};
  const abortPromise = new Promise<typeof ABORTED>((resolve) => {
    const onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => signal.removeEventListener('abort', onAbort);
    }
  });
  try {
    return await Promise.race([
      execution,
      abortPromise.then(() => {
        void raiseAbortFlag(tabId);
        return ABORTED;
      }),
    ]);
  } finally {
    detach();
    // 中止后 executeScript 仍会自己结算，别让它变成 unhandled rejection
    void execution.catch(() => undefined);
  }
}

/**
 * 注入到页面里执行的函数。会被序列化后送进页面，所以不能引用外部作用域的任何东西。
 * 用户代码可能写到一半就卡住，所以这里用 Promise.race 加了超时。
 */
function runInPage(source: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  const describe = (value: unknown): string => {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    body: string,
  ) => () => Promise<unknown>;

  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(`执行超过 ${Math.round(timeoutMs / 1000)} 秒，已中断`)), timeoutMs);
  });

  const run = (async () => {
    // 包成 async 函数，模型写的顶层 await / return 都能用
    const value = await new AsyncFunction(source)();
    return { ok: true, output: describe(value) };
  })();

  return Promise.race([run, timeout]).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/unsafe-eval|Content Security Policy/i.test(message)) {
      return { ok: false, output: `当前页面的 CSP 不允许执行动态脚本：${message}` };
    }
    return { ok: false, output: message };
  });
}

/**
 * 在页面主世界执行代码：能拿到页面自己的 JS 对象（页面里 React 组件、编辑器实例之类）。
 * 主世界不可用（旧版 Firefox）时退回隔离世界——DOM 操作照常，只是拿不到页面对象。
 *
 * 传了 signal 就能被「停止」打断：先在页面里清一次取消标记，中止时置上它，
 * 后台这一侧不等页面返回，直接交还「已停止」。
 */
export async function injectScript(
  tabId: number,
  source: string,
  args?: unknown,
  timeoutMs = EXECUTE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<InjectResult> {
  if (signal?.aborted) return { ok: false, output: '已停止', world: 'ISOLATED' };

  const timeout = Math.min(Math.max(timeoutMs, 1000), MAX_EXECUTE_TIMEOUT_MS);
  let lastError = '';
  // 参数以 __args 的形式注入，脚本里直接用；开头顺手清掉上一次留下的取消标记
  const withArgs = `globalThis.${ABORT_FLAG} = false;\n${
    args === undefined ? source : `const __args = ${JSON.stringify(args)};\n${source}`
  }`;

  for (const world of ['MAIN', 'ISOLATED'] as const) {
    try {
      const execution = ext.scripting.executeScript({
        target: { tabId },
        world,
        func: runInPage,
        args: [withArgs, timeout],
      });
      const settled = signal
        ? await raceAbort(execution, signal, tabId)
        : await execution;
      // executeScript 的结果一定是数组，ABORTED 不是
      if (!Array.isArray(settled)) return { ok: false, output: '已停止', world };
      const value = settled[0]?.result;
      if (value === undefined || value === null) {
        return { ok: false, output: '页面没有返回结果', world };
      }
      // js_inject 的包装返回 {ok, output}；PTA 脚本直接返回字符串或对象（describe 会 JSON 化）
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof (value as { ok?: unknown }).ok === 'boolean' &&
        typeof (value as { output?: unknown }).output === 'string'
      ) {
        const shaped = value as { ok: boolean; output: string };
        return { ok: shaped.ok, output: shaped.output, world };
      }
      return {
        ok: true,
        output: typeof value === 'string' ? value : JSON.stringify(value),
        world,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return { ok: false, output: `无法在页面里执行代码：${lastError}`, world: 'ISOLATED' };
}
