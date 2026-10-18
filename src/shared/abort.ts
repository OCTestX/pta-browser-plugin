/**
 * 「停止」的统一语义。
 *
 * 面板上那个「停止」按钮只有一处实现，但它要打断的东西分散在很多地方：
 * 请求模型的流、等用户作答、页面里跑的脚本、内置编译器、逐字敲键盘、整段写作答区。
 * 每一段都必须能立刻收工，否则就会出现「按了停止没反应、进度条一直转」。
 * 造 AbortError 与认 AbortError 都只在这里做，避免各处各写一套判断。
 */

export const ABORT_MESSAGE = '用户停止了生成';

export function abortError(message: string = ABORT_MESSAGE): DOMException {
  return new DOMException(message, 'AbortError');
}

/**
 * 判断某次失败是不是「用户按了停止」。
 * fetch 在部分实现里中止时抛的是 TypeError 而不是 DOMException，
 * 所以 signal 已经 aborted 也算——那次失败本来就是中止引起的。
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException) return error.name === 'AbortError';
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * 让任意一步都能被「停止」打断：中止时立刻抛 AbortError，不等它做完。
 * 已经开始的那一步仍然在后台跑完（executeScript、Worker 都撤不回来），
 * 但它的结算被接住，不会变成 unhandled rejection，也不会把 agent loop 挂住。
 */
export async function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);

  // 这里只能 new Promise：工程的 lib 是 ES2022，没有 Promise.withResolvers
  let detach = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    detach = () => signal.removeEventListener('abort', onAbort);
  });

  try {
    return await Promise.race([work, aborted]);
  } finally {
    detach();
    void work.catch(() => undefined);
  }
}
