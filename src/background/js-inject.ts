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
 */
export async function injectScript(
  tabId: number,
  source: string,
  args?: unknown,
  timeoutMs = EXECUTE_TIMEOUT_MS,
): Promise<InjectResult> {
  const timeout = Math.min(Math.max(timeoutMs, 1000), MAX_EXECUTE_TIMEOUT_MS);
  let lastError = '';
  // 参数以 __args 的形式注入，脚本里直接用
  const withArgs =
    args === undefined ? source : `const __args = ${JSON.stringify(args)};\n${source}`;

  for (const world of ['MAIN', 'ISOLATED'] as const) {
    try {
      const results = await ext.scripting.executeScript({
        target: { tabId },
        world,
        func: runInPage,
        args: [withArgs, timeout],
      });
      const value = results[0]?.result;
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
