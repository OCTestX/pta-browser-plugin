// 内置编译器的宿主端（background 侧）：把「编译 + 运行」请求送进跑在 Worker 里的 wasm 引擎。
//
// - Chrome：MV3 service worker 建不了 Worker，用 offscreen 文档承载（chrome.offscreen）
// - Firefox：background 是 event page，直接 new Worker
// - 都没有（比如 Node 测试环境）：抛错，由调用方降级
//
// 超时是硬杀：死循环的程序没有任何协作式检查点，只能 terminate 整个 Worker 再重建。
// 但**还在排队**的请求从没进过引擎，超时 / 中止只把它从队列里摘掉，不去动正在干活的 Worker——
// 否则实时检查每撤销一次都要重新解包 38MB 的 sysroot，界面反而更慢。

import { abortError } from '../shared/abort.ts';
import { ext } from '../shared/browser.ts';

/**
 * 请求走到哪一步了。宿主按阶段给预算，超时错误里也带着阶段，
 * 界面和模型才分得清「编译器忙」「加载太慢」「编译太慢」「程序死循环」。
 *
 * queue   排队等引擎空出来（引擎单线程，一次只跑一个请求）
 * prepare 加载引擎（首次要把 38MB sysroot 解进 memfs）
 * compile 编译 + 链接
 * check   只做语法检查（-fsyntax-only）
 * run     跑程序
 */
export type EngineStage = 'queue' | 'prepare' | 'compile' | 'check' | 'run';

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

/** 各阶段的预算（毫秒）。测试可以整张表压短，真机用默认值。 */
export interface EngineTimeouts {
  /** 实时检查在队列里最多等多久：不能陪着长编译一起干等 */
  queueCheck: number;
  queueRun: number;
  prepare: number;
  compile: number;
  check: number;
  run: number;
}

const DEFAULT_TIMEOUTS: EngineTimeouts = {
  // 一次检查排队 12 秒还没轮到，就该如实说「编译器忙」，而不是让页面一直空等
  queueCheck: 12_000,
  // 编译运行请求正常不排队，这里只是兜底（一个最慢的请求也就 prepare + compile + run）
  queueRun: 120_000,
  /** 引擎加载 + sysroot 解包：慢机器上十几秒很常见 */
  prepare: 40_000,
  /** 编译 + 链接（最慢的是 C++ 的 bits/stdc++.h） */
  compile: 60_000,
  /** 只做语法检查：正常几十毫秒，给足余量但不陪着长编译一起等 */
  check: 20_000,
  /** 程序运行的预算：PTA 的题面常规限制也是几秒 */
  run: 10_000,
};

type EngineRequestKind = 'run' | 'check';

/**
 * 超时错误：name 固定 EngineTimeout，出事阶段写在 stage 上。
 * 调用方据此决定说「编译超时」还是「运行超时」，也能原样把 stage 交给页面。
 */
export interface EngineTimeoutError extends Error {
  name: 'EngineTimeout';
  stage: EngineStage;
}

interface PendingRequest {
  kind: EngineRequestKind;
  /** 当前阶段的预算正在跑：收到 stage 消息就换成新阶段的预算 */
  stage: EngineStage;
  resolve: (result: EngineRunResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 请求已经发给 Worker：只有这种请求超时 / 中止才值得重启引擎 */
  sent: boolean;
  /** 已经结算（超时 / 中止 / 收到结果）：排队轮到时直接跳过 */
  settled: boolean;
  /** 摘掉 AbortSignal 的监听 */
  detach: () => void;
  stopKeepAlive: (() => void) | null;
}

export interface EngineRequest {
  id: number;
  code: string;
  stdin: string;
  lang?: string;
  check?: boolean;
  prelude?: boolean;
}

export interface EngineQueueOptions {
  /** 把请求送进 Worker（Chrome 走 offscreen，Firefox 直接 postMessage） */
  send: (request: EngineRequest) => Promise<void> | void;
  /** 超时 / 中止之后换掉引擎（terminate Worker 重建） */
  restart: () => void;
  /** 长编译期间让 service worker 别被浏览器回收；测试不传 */
  keepAlive?: (isPending: () => boolean) => () => void;
  /** 阶段预算，测试可以压到几十毫秒 */
  timeouts?: Partial<EngineTimeouts>;
}

let firefoxWorker: Worker | null = null;
let offscreenReady = false;
let listenerInstalled = false;

/** Node 测试环境里这些全局都不存在，全都安全退化为「不可用」 */
const canOffscreen = typeof ext?.offscreen?.createDocument === 'function';
const canWorker = typeof Worker === 'function';

function budgetOf(timeouts: EngineTimeouts, stage: EngineStage, kind: EngineRequestKind): number {
  switch (stage) {
    case 'queue':
      return kind === 'check' ? timeouts.queueCheck : timeouts.queueRun;
    case 'prepare':
      return timeouts.prepare;
    case 'compile':
      return timeouts.compile;
    case 'check':
      return timeouts.check;
    case 'run':
      return timeouts.run;
  }
}

function makeTimeoutError(stage: EngineStage, seconds: number): EngineTimeoutError {
  let text: string;
  switch (stage) {
    case 'queue':
      text = `内置引擎正忙（上一个请求还没跑完），这次请求排队 ${seconds} 秒后放弃`;
      break;
    case 'prepare':
      text = `内置引擎加载超过 ${seconds} 秒（首次要解包运行环境），已重置`;
      break;
    case 'check':
      text = `语法检查超过 ${seconds} 秒没有结果，已重置内置编译器`;
      break;
    case 'run':
      text = `程序运行超过 ${seconds} 秒被强制停止（多半是死循环）`;
      break;
    default:
      text = `编译超过 ${seconds} 秒没有完成（引擎无响应），已重置内置编译器`;
      break;
  }
  const error = new Error(text) as EngineTimeoutError;
  error.name = 'EngineTimeout';
  error.stage = stage;
  return error;
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

/** 队列本身的接口：宿主调 enqueue，Worker 回复交给 handleMessage */
export interface EngineQueue {
  enqueue: (payload: EnginePayload, signal?: AbortSignal) => Promise<EngineRunResult>;
  handleMessage: (message: EngineMessage | undefined) => void;
}

/**
 * 请求队列 + 阶段化超时。
 *
 * 引擎单线程，两路请求（编译运行 / 只检查）必须共用一条队列。
 * 抽成工厂是为了让 scripts/test-compile.mjs 在 Node 里喂假回复、把预算压到几十毫秒，
 * 真环境固定用下面那个实例。
 */
export function createEngineQueue(options: EngineQueueOptions): EngineQueue {
  const timeouts: EngineTimeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  /** 引擎一次只能跑一个请求，排队防并发 */
  let queue: Promise<unknown> = Promise.resolve();

  function settle(id: number, entry: PendingRequest): void {
    clearTimeout(entry.timer);
    entry.settled = true;
    entry.detach();
    entry.stopKeepAlive?.();
    pending.delete(id);
  }

  function armTimer(id: number, entry: PendingRequest, stage: EngineStage): void {
    clearTimeout(entry.timer);
    entry.stage = stage;
    const budget = budgetOf(timeouts, stage, entry.kind);
    entry.timer = setTimeout(() => {
      if (entry.settled) return;
      const wasSent = entry.sent;
      settle(id, entry);
      // 排队中就到点的请求从没进过引擎：只摘掉它，别把正在干活的 Worker 一起杀掉
      if (wasSent) options.restart();
      entry.reject(makeTimeoutError(stage, Math.max(1, Math.round(budget / 1000))));
    }, budget);
  }

  /** 处理 Worker 的回复：stage 推进阶段（顺带重置预算），done 结算请求 */
  function handleMessage(message: EngineMessage | undefined): void {
    if (!message || typeof message.id !== 'number') return;
    const entry = pending.get(message.id);
    if (!entry) return;

    if (message.type === 'stage') {
      armTimer(message.id, entry, message.stage);
      return;
    }

    settle(message.id, entry);
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

  function enqueue(payload: EnginePayload, signal?: AbortSignal): Promise<EngineRunResult> {
    let resolveRequest!: (result: EngineRunResult) => void;
    let rejectRequest!: (error: Error) => void;
    const request = new Promise<EngineRunResult>((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    // 排队期间就可能超时 / 中止，而这时队列链条还没接上它：
    // 先挂一个空的失败处理，免得 Node / 浏览器把它当成未处理的 rejection
    request.catch(() => undefined);

    if (signal?.aborted) {
      rejectRequest(abortError());
      return request;
    }

    const id = nextId++;
    const entry: PendingRequest = {
      kind: payload.check ? 'check' : 'run',
      stage: 'queue',
      resolve: resolveRequest,
      reject: rejectRequest,
      timer: 0 as never,
      sent: false,
      settled: false,
      detach: () => {},
      stopKeepAlive: null,
    };

    const onAbort = () => {
      if (entry.settled) return;
      const wasSent = entry.sent;
      settle(id, entry);
      // 同上：没发出去的请求不值得为它重启引擎
      if (wasSent) options.restart();
      entry.reject(abortError());
    };

    entry.detach = () => signal?.removeEventListener('abort', onAbort);
    pending.set(id, entry);
    // 排队也计时：一个请求不该在队列里无限等下去
    armTimer(id, entry, 'queue');
    signal?.addEventListener('abort', onAbort, { once: true });
    entry.stopKeepAlive = options.keepAlive?.(() => pending.has(id)) ?? null;

    /** 轮到这个请求了：真正发给 Worker，并把预算换成「加载引擎」 */
    const attempt = (): Promise<EngineRunResult> => {
      if (entry.settled) return request; // 排队期间已经超时 / 被中止
      entry.sent = true;
      armTimer(id, entry, 'prepare');
      void Promise.resolve()
        .then(() => options.send({ id, ...payload }))
        .catch((error: unknown) => {
          if (entry.settled) return;
          settle(id, entry);
          entry.reject(new Error(`编译请求发不出去：${error instanceof Error ? error.message : String(error)}`));
        });
      return request;
    };

    const chained = queue.then(attempt, attempt);
    queue = chained.catch(() => undefined);
    // 交还给调用方的是 request 本身：排队超时 / 中止要能立刻返回，
    // 不能等队列轮到它才把「我早就超时了」告诉它
    return request;
  }

  return { enqueue, handleMessage };
}

let engineQueue: EngineQueue | null = null;

function getQueue(): EngineQueue {
  if (!engineQueue) {
    engineQueue = createEngineQueue({
      send: sendToEngine,
      restart: restartEngine,
      keepAlive: (isPending) => keepAliveWhile(isPending),
    });
  }
  return engineQueue;
}

/** 扩展消息的边界：只认「引擎回话」这一种，别的原样放过 */
function isEngineEnvelope(value: unknown): value is { type: 'engine-message'; data: EngineMessage } {
  return !!value && typeof value === 'object' && 'type' in value && value.type === 'engine-message' && 'data' in value;
}

function installListener(): void {
  if (listenerInstalled || typeof ext?.runtime?.onMessage?.addListener !== 'function') return;
  listenerInstalled = true;
  ext.runtime.onMessage.addListener((message: unknown) => {
    if (isEngineEnvelope(message)) getQueue().handleMessage(message.data);
    return undefined; // 不归我们处理的消息原样放过
  });
}

/**
 * 确保承载 Worker 的 offscreen 文档存在。剪贴板兜底也复用这一页（Chrome 只允许一个 offscreen 文档），
 * 所以创建时把 CLIPBOARD 一起声明上。
 */
export async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return;
  try {
    await ext.offscreen.createDocument({
      url: 'engine/compiler-host.html',
      reasons: ['WORKERS' as chrome.offscreen.Reason, 'CLIPBOARD' as chrome.offscreen.Reason],
      justification:
        '在本地 WebAssembly 里编译并运行代码（Worker），以及读取剪贴板给 PTA 作答区做内置粘贴',
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
      getQueue().handleMessage(event.data as EngineMessage);
    };
  }
  return firefoxWorker;
}

/** Chrome 的 offscreen 页刚建好时脚本可能还没挂上监听：这条错误重发一次就好 */
const RECEIVER_MISSING_RE = /Receiving end does not exist|Could not establish connection/i;

async function sendToEngine(data: EngineRequest): Promise<void> {
  if (canOffscreen) {
    await ensureOffscreenDocument();
    try {
      await ext.runtime.sendMessage({ type: 'engine-request', data });
    } catch (error) {
      if (!RECEIVER_MISSING_RE.test(String(error))) throw error;
      // 给 offscreen 页一帧时间把 onMessage 挂上再发一次；还是不行才当「不可用」上报
      await new Promise<void>((resolve) => { setTimeout(resolve, 120); });
      await ext.runtime.sendMessage({ type: 'engine-request', data });
    }
  } else if (canWorker) {
    getFirefoxWorker().postMessage(data);
  } else {
    throw new Error('内置编译器在当前环境不可用（没有 Worker / offscreen 支持）');
  }
}

/** 让 service worker 在漫长的编译期间别被浏览器按空闲回收（每 20 秒戳一次扩展 API） */
function keepAliveWhile(isPending: () => boolean): () => void {
  const interval = setInterval(() => {
    if (!isPending()) {
      clearInterval(interval);
      return;
    }
    // 任何扩展 API 调用都会重置 service worker 的空闲计时器
    try {
      void ext.runtime.getPlatformInfo?.().catch?.(() => undefined);
    } catch {
      // Node 测试环境没有 chrome.runtime：保活本来就用不上
    }
  }, 20_000);
  return () => clearInterval(interval);
}

export type EngineLanguage = 'c' | 'cpp' | 'python';

interface EnginePayload {
  code: string;
  stdin: string;
  lang?: EngineLanguage;
  check?: boolean;
  /** 代码填空题：强制带上 C/C++ 常用头再做语法检查 */
  prelude?: boolean;
}

/**
 * 在内置引擎里编译并运行一段 C 代码（排队执行，阶段化超时）。
 * 传了 signal 就能被「停止」打断：中止会直接把引擎换掉（死循环的程序没有检查点，
 * 留着它会把后面的编译一起堵住），然后以 AbortError 收场。
 */
export function runInEngine(
  code: string,
  stdin: string,
  signal?: AbortSignal,
  lang?: EngineLanguage,
): Promise<EngineRunResult> {
  installListener();
  return getQueue().enqueue({ code, stdin, lang }, signal);
}

/**
 * 只做语法检查（不运行）：作答区实时检查用。
 * 预算按「检查」阶段算（20 秒），排队超过 12 秒就直接说编译器忙。
 */
export function checkInEngine(
  code: string,
  signal?: AbortSignal,
  lang: EngineLanguage = 'c',
  prelude = false,
): Promise<EngineRunResult> {
  installListener();
  return getQueue().enqueue({ code, stdin: '', lang, check: true, prelude }, signal);
}
