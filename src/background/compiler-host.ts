// 内置编译器的宿主端（background 侧）：把「编译 + 运行」请求送进跑在 Worker 里的 wasm 引擎。
//
// - Chrome：MV3 service worker 建不了 Worker，用 offscreen 文档承载（chrome.offscreen）
// - Firefox：background 是 event page，直接 new Worker
// - 都没有（比如 Node 测试环境）：抛错，由调用方降级
//
// 超时是硬杀：死循环的程序没有任何协作式检查点，只能 terminate 整个 Worker 再重建。

import { ext } from '../shared/browser.ts';

export type EngineStage = 'compile' | 'run';

export interface EngineRunResult {
  stage: 'ok' | 'compile-error' | 'link-error' | 'run-exit' | 'run-trap' | 'engine-error';
  stdout: string;
  stderr: string;
  /** 编译 / 链接失败时的诊断输出 */
  compileOutput: string;
  exitCode: number;
  /** wasm trap（野指针、除零等）的报错 */
  trap: string | null;
  /** 引擎级错误说明（stage=engine-error 时有效） */
  message: string;
  elapsedMs: number;
}

type EngineMessage =
  | { id: number; type: 'stage'; stage: EngineStage }
  | { id: number; type: 'done'; result: Partial<EngineRunResult> & { stage: EngineRunResult['stage'] } };

/** 编译 + 链接（首次含引擎加载、sysroot 解包）的预算 */
const COMPILE_STAGE_TIMEOUT_MS = 60_000;
/** 程序运行的预算：PTA 的题面常规限制也是几秒 */
const RUN_STAGE_TIMEOUT_MS = 10_000;

interface PendingRequest {
  resolve: (result: EngineRunResult) => void;
  reject: (error: Error) => void;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<number, PendingRequest>();
let nextId = 1;
/** 引擎一次只能跑一个请求，排队防并发 */
let queue: Promise<unknown> = Promise.resolve();

let firefoxWorker: Worker | null = null;
let offscreenReady = false;
let listenerInstalled = false;

/** Node 测试环境里这些全局都不存在，全都安全退化为「不可用」 */
const canOffscreen = typeof ext?.offscreen?.createDocument === 'function';
const canWorker = typeof Worker === 'function';

function makeTimeoutError(stage: EngineStage): Error {
  const error = stage === 'run'
    ? new Error('程序运行超过 10 秒被强制停止（多半是死循环）')
    : new Error('编译超过 60 秒没有完成（引擎无响应），已重置内置编译器');
  error.name = 'EngineTimeout';
  return error;
}

function armTimer(id: number, entry: PendingRequest, stage: EngineStage): void {
  clearTimeout(entry.timer);
  const budget = stage === 'run' ? RUN_STAGE_TIMEOUT_MS : COMPILE_STAGE_TIMEOUT_MS;
  entry.deadline = Date.now() + budget;
  entry.timer = setTimeout(() => {
    pending.delete(id);
    restartEngine();
    entry.reject(makeTimeoutError(stage));
  }, budget);
}

function restartEngine(): void {
  if (canOffscreen) {
    // offscreen 页收到后会 terminate Worker 并重开
    void ext.runtime.sendMessage({ type: 'engine-restart' }).catch(() => undefined);
  } else if (firefoxWorker) {
    firefoxWorker.terminate();
    firefoxWorker = null;
  }
}

function handleEngineMessage(message: EngineMessage | undefined): void {
  if (!message || typeof message.id !== 'number') return;
  const entry = pending.get(message.id);
  if (!entry) return;

  if (message.type === 'stage') {
    armTimer(message.id, entry, message.stage);
    return;
  }

  clearTimeout(entry.timer);
  pending.delete(message.id);
  const raw = message.result;
  entry.resolve({
    stage: raw.stage,
    stdout: raw.stdout ?? '',
    stderr: raw.stderr ?? '',
    compileOutput: raw.compileOutput ?? '',
    exitCode: raw.exitCode ?? 0,
    trap: raw.trap ?? null,
    message: raw.message ?? '',
    elapsedMs: raw.elapsedMs ?? 0,
  });
}

function installListener(): void {
  if (listenerInstalled || typeof ext?.runtime?.onMessage?.addListener !== 'function') return;
  listenerInstalled = true;
  ext.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string } | null)?.type === 'engine-message') {
      handleEngineMessage((message as { data: EngineMessage }).data);
    }
    return undefined; // 不归我们处理的消息原样放过
  });
}

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return;
  try {
    await ext.offscreen.createDocument({
      url: 'engine/compiler-host.html',
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: '在本地 WebAssembly 里编译并运行 C 代码，用 Worker 承载以防死循环卡死',
    });
  } catch (error) {
    // service worker 重启后本地标记丢了，文档其实还开着——继续用
    if (!/single offscreen|already exists/i.test(String(error))) throw error;
  }
  offscreenReady = true;
}

function getFirefoxWorker(): Worker {
  if (!firefoxWorker) {
    firefoxWorker = new Worker(ext.runtime.getURL('engine/compile-worker.js'), { type: 'module' });
    firefoxWorker.onmessage = (event: MessageEvent) => {
      handleEngineMessage(event.data as EngineMessage);
    };
  }
  return firefoxWorker;
}

async function sendToEngine(data: { id: number; code: string; stdin: string }): Promise<void> {
  if (canOffscreen) {
    await ensureOffscreenDocument();
    await ext.runtime.sendMessage({ type: 'engine-request', data });
  } else if (canWorker) {
    getFirefoxWorker().postMessage(data);
  } else {
    throw new Error('内置编译器在当前环境不可用（没有 Worker / offscreen 支持）');
  }
}

/** 让 service worker 在漫长的编译期间别被浏览器按空闲回收（每 20 秒戳一次扩展 API） */
function keepAliveWhile(id: number): () => void {
  const interval = setInterval(() => {
    if (!pending.has(id)) {
      clearInterval(interval);
      return;
    }
    // 任何扩展 API 调用都会重置 service worker 的空闲计时器
    void ext.runtime.getPlatformInfo?.().catch?.(() => undefined);
  }, 20_000);
  return () => clearInterval(interval);
}

/** 在内置引擎里编译并运行一段 C 代码（排队执行，阶段化超时） */
export function runInEngine(code: string, stdin: string): Promise<EngineRunResult> {
  installListener();
  const attempt = () =>
    new Promise<EngineRunResult>((resolve, reject) => {
      const id = nextId++;
      const stopKeepAlive = keepAliveWhile(id);
      const entry: PendingRequest = {
        resolve: (value) => { stopKeepAlive(); resolve(value); },
        reject: (error) => { stopKeepAlive(); reject(error); },
        deadline: 0,
        timer: 0 as never,
      };
      pending.set(id, entry);
      armTimer(id, entry, 'compile');

      void sendToEngine({ id, code, stdin }).catch((error: unknown) => {
        pending.delete(id);
        clearTimeout(entry.timer);
        stopKeepAlive();
        reject(new Error(`编译请求发不出去：${error instanceof Error ? error.message : String(error)}`));
      });
    });

  const run = queue.then(attempt, attempt);
  queue = run.catch(() => undefined);
  return run;
}
