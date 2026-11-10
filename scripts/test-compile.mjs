// 内置 C 编译器：用真实引擎（clang22-noeh + lld22-noeh + sysroot22.tar）跑几段 C，
// 顺带校验样例比对（尾部空白、末尾空行不算差异）。
// 宿主队列（阶段化超时 / 排队 / 中止）和编译错误的结构化返回用假回复验证，不需要真机。
// 大资源缺失时（没跑过 npm run build）跳过真实编译并提示。
// 用法：node scripts/test-compile.mjs
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  compareOutput,
  formatCompileResult,
  checkLanguage,
  isCheckableLanguage,
  compileAndRunJs,
  compileAndRunCpp,
  checkCode,
  engineFailureResult,
  toCompileResult,
} from '../src/background/compile.ts';
import { createEngineQueue } from '../src/background/compiler-host.ts';
import { createCEngine, runOnEngine, checkOnEngine } from '../public/engine/engine-core.js';
import { makeStdinReader } from '../public/engine/worker-utils.js';

const ENGINE_DIR = 'public/engine';
const ASSETS = ['clang22-noeh', 'lld22-noeh', 'sysroot22.tar', 'memfs'];
const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const hasAssets = async () =>
  (await Promise.all(
    ASSETS.map(async (name) => (await stat(path.join(ENGINE_DIR, name)).catch(() => null))?.size ?? 0),
  )).every((size) => size > 0);

/* ---------- Python stdin：EOF 必须是 null ---------- */

// 回归：Pyodide 只把 null/undefined 当 EOF；返回 '' 会让 sys.stdin.read() 死循环。
const emptyReader = makeStdinReader('');
check('Python stdin 空输入立即 EOF（不能返回空串死循环）', emptyReader() === null);

const trailingReader = makeStdinReader('7 8\n');
check('Python stdin 末尾换行不额外产生空行', trailingReader() === '7 8\n' && trailingReader() === null);

const blankReader = makeStdinReader('a\n\nb\n');
check(
  'Python stdin 保留中间空行，耗尽后 EOF',
  blankReader() === 'a\n' && blankReader() === '\n' && blankReader() === 'b\n' && blankReader() === null,
);

const noTrailingReader = makeStdinReader('1 2');
check('Python stdin 没有末尾换行也能读到最后一行', noTrailingReader() === '1 2\n' && noTrailingReader() === null);

/* ---------- 宿主队列：阶段化超时 / 排队 / 中止（不依赖真机） ---------- */

// 预算压到几十毫秒：真机上 60 秒的编译超时在这里 40 毫秒就能验完
const fastTimeouts = (extra = {}) => ({
  queueCheck: 5_000,
  queueRun: 5_000,
  prepare: 5_000,
  compile: 5_000,
  check: 5_000,
  run: 5_000,
  ...extra,
});

// 1) 编译阶段超时：必须在预算附近就返回，并且带上 stage
let restarts = 0;
const compileTimeoutQueue = createEngineQueue({
  send: (request) => {
    // Worker 说「开始编译」之后就再也没消息：模拟引擎被卡住
    compileTimeoutQueue.handleMessage({ id: request.id, type: 'stage', stage: 'compile' });
  },
  restart: () => { restarts += 1; },
  timeouts: fastTimeouts({ compile: 40 }),
});
const compileTimeoutStart = Date.now();
const compileTimeout = await compileTimeoutQueue
  .enqueue({ code: 'int main(void) { return 0 }', stdin: '', lang: 'cpp' })
  .then(() => null, (error) => error);
const compileTimeoutMs = Date.now() - compileTimeoutStart;
check(
  '编译超时：EngineTimeout + stage=compile，说明里点出编译',
  compileTimeout?.name === 'EngineTimeout'
    && compileTimeout.stage === 'compile'
    && /编译/.test(compileTimeout.message),
  compileTimeout,
);
check('编译超时按阶段预算返回（不会一直等到长超时）', compileTimeoutMs < 1_500, `${compileTimeoutMs}ms`);
check('在跑的请求超时后才重启引擎', restarts === 1);

// 超时错误 → 结构化结果（compile.ts 的归一化）
const timeoutAsResult = engineFailureResult(compileTimeout);
check(
  '超时映射成「编译超时」并保留 stage/说明',
  timeoutAsResult?.ok === false
    && timeoutAsResult.statusText === '编译超时'
    && timeoutAsResult.stage === 'compile'
    && timeoutAsResult.message === compileTimeout.message,
  timeoutAsResult,
);

// 2) 引擎加载阶段
let prepareQueue;
prepareQueue = createEngineQueue({
  send: (request) => {
    prepareQueue.handleMessage({ id: request.id, type: 'stage', stage: 'prepare' });
  },
  restart: () => {},
  timeouts: fastTimeouts({ prepare: 40 }),
});
const prepareTimeout = await prepareQueue
  .enqueue({ code: 'int main(void) {}', stdin: '', check: true })
  .then(() => null, (error) => error);
check(
  '引擎加载超时：stage=prepare，说清是加载慢',
  prepareTimeout?.stage === 'prepare' && /加载/.test(prepareTimeout.message) && !/编译超过/.test(prepareTimeout.message),
  prepareTimeout,
);
check('加载超时映射成「引擎加载超时」', engineFailureResult(prepareTimeout)?.statusText === '引擎加载超时');

// 3) 实时检查阶段
let checkQueue;
checkQueue = createEngineQueue({
  send: (request) => {
    checkQueue.handleMessage({ id: request.id, type: 'stage', stage: 'prepare' });
    checkQueue.handleMessage({ id: request.id, type: 'stage', stage: 'check' });
  },
  restart: () => {},
  timeouts: fastTimeouts({ check: 40 }),
});
const checkTimeout = await checkQueue
  .enqueue({ code: 'int main(void) { int x = ; }', stdin: '', check: true })
  .then(() => null, (error) => error);
check(
  '实时检查超时：stage=check，提示是语法检查',
  checkTimeout?.stage === 'check' && /语法检查/.test(checkTimeout.message),
  checkTimeout,
);
check('检查超时映射成「检查超时」', engineFailureResult(checkTimeout)?.statusText === '检查超时');

// 4) 编译错误应当立刻带回，而不是等到超时
let compileErrorRestarts = 0;
let fastQueue;
fastQueue = createEngineQueue({
  send: (request) => {
    fastQueue.handleMessage({ id: request.id, type: 'stage', stage: 'prepare' });
    fastQueue.handleMessage({ id: request.id, type: 'stage', stage: 'compile' });
    fastQueue.handleMessage({
      id: request.id,
      type: 'done',
      result: {
        stage: 'compile-error',
        compileOutput: 'check.cpp:1:12: error: expected \';\' after expression',
        exitCode: 1,
      },
    });
  },
  restart: () => { compileErrorRestarts += 1; },
  timeouts: fastTimeouts({ compile: 30 }),
});
const fastStart = Date.now();
const fastError = await fastQueue.enqueue({ code: 'int main() { return 0 }', stdin: '', lang: 'cpp' });
check(
  '编译错误立刻返回，不用等到超时',
  fastError.stage === 'compile-error'
    && /error:/.test(fastError.compileOutput)
    && Date.now() - fastStart < 1_000
    && compileErrorRestarts === 0,
  fastError,
);
check('编译错误不带引擎退出尾巴', !/process exited with code/.test(fastError.compileOutput), fastError.compileOutput);

// 5) 排队超时：实时检查不该排在长编译后面死等，也不该顺手杀掉正在干活的引擎
let queueWaitRestarts = 0;
let busyQueue;
busyQueue = createEngineQueue({
  // 第一个请求占住引擎，永远不回话
  send: () => {},
  restart: () => { queueWaitRestarts += 1; },
  timeouts: fastTimeouts({ queueCheck: 40 }),
});
const busy = busyQueue.enqueue({ code: 'int main(void) {}', stdin: '' }).catch((error) => error);
const queueWaitStart = Date.now();
const queueWaitError = await busyQueue
  .enqueue({ code: 'int value;', stdin: '', check: true })
  .then(() => null, (error) => error);
check(
  '排队超时：stage=queue，快速返回',
  queueWaitError?.stage === 'queue' && Date.now() - queueWaitStart < 1_000,
  queueWaitError,
);
check('排队超时不会重启正在干活的引擎', queueWaitRestarts === 0);
check('排队超时映射成「内置引擎忙」', engineFailureResult(queueWaitError)?.statusText === '内置引擎忙（排队超时）');
busyQueue.handleMessage({ id: 1, type: 'done', result: { stage: 'ok' } });
await busy;

// 6) 中止：排队中撤销不动引擎，在跑的时候撤销才重启
let abortRestarts = 0;
let abortQueue;
abortQueue = createEngineQueue({
  send: () => {},
  restart: () => { abortRestarts += 1; },
  timeouts: fastTimeouts(),
});
const busyController = new AbortController();
const busyRequest = abortQueue
  .enqueue({ code: 'int main(void) {}', stdin: '' }, busyController.signal)
  .catch((error) => error);
const queuedController = new AbortController();
const queuedRequest = abortQueue
  .enqueue({ code: 'int value;', stdin: '', check: true }, queuedController.signal)
  .catch((error) => error);
queuedController.abort();
const queuedError = await queuedRequest;
check(
  '排队中撤销：AbortError，不重启引擎',
  queuedError?.name === 'AbortError' && abortRestarts === 0,
  queuedError,
);
busyController.abort();
const busyError = await busyRequest;
check(
  '在跑的请求被撤销：AbortError，并重启引擎',
  busyError?.name === 'AbortError' && abortRestarts === 1,
  { busyError, abortRestarts },
);

// 7) 陌生消息不能把宿主搞崩（后台重启 / 迟到的回复都会这样）
let strayThrew = false;
try {
  fastQueue.handleMessage(undefined);
  fastQueue.handleMessage({ id: 999, type: 'stage', stage: 'compile' });
  fastQueue.handleMessage({ id: 999, type: 'done', result: { stage: 'ok' } });
} catch {
  strayThrew = true;
}
check('陌生 id / 空消息被忽略', !strayThrew);

/* ---------- 失败归一化：超时 / 引擎错误 / 中止 ---------- */

const abortSample = Object.assign(new Error('用户停止了生成'), { name: 'AbortError' });
check('用户中止不算引擎失败（保持异常语义）', engineFailureResult(abortSample) === null);
check(
  '请求发不出去映射成「内置编译器不可用」',
  engineFailureResult(new Error('编译请求发不出去：没有 Worker'))?.statusText === '内置编译器不可用',
);
check(
  '引擎错误结果带 compileOutput（崩之前那截诊断不丢）',
  (() => {
    const mapped = toCompileResult({
      stage: 'engine-error',
      stdout: '',
      stderr: '',
      compileOutput: 'a.cpp:3:5: error: 模拟的半截诊断',
      exitCode: 0,
      trap: null,
      message: 'wasm trap: unreachable',
      elapsedMs: 1200,
    });
    return mapped.ok === false
      && mapped.statusText === '内置编译器错误'
      && mapped.stage === 'engine-error'
      && /error:/.test(mapped.compileOutput)
      && mapped.message === 'wasm trap: unreachable'
      && mapped.time === '1.20';
  })(),
);
check(
  '编译错误没有诊断文本时给出说明，不留空白',
  (() => {
    const mapped = toCompileResult({
      stage: 'compile-error',
      stdout: '',
      stderr: '',
      compileOutput: '',
      exitCode: 1,
      trap: null,
      message: '',
      elapsedMs: 10,
    });
    return mapped.statusText === '编译错误' && mapped.message !== '';
  })(),
);
check(
  '运行崩溃/退出码映射到 run 阶段',
  toCompileResult({
    stage: 'run-trap', stdout: '', stderr: '', compileOutput: '', exitCode: 0,
    trap: 'unreachable\n  at foo', message: '', elapsedMs: 5,
  }).stage === 'run',
);

// Node 里没有 Worker / offscreen：要返回结构化结果，而不是抛一个字符串出来
const unavailable = await compileAndRunCpp({ code: 'int main() { return 0; }', stdin: '' });
check(
  '没有 Worker 时返回「内置编译器不可用」而不是抛异常',
  unavailable.ok === false
    && unavailable.statusText === '内置编译器不可用'
    && /不可用/.test(unavailable.message),
  unavailable,
);

// 实时检查走同一套归一化：页面拿到的是带 stage 的结果，不是一次异常
const offlineCheck = await checkCode('int main(void) { return 0; }', 'C++');
check(
  '实时检查不可用时不抛异常，带 stage=engine-error',
  offlineCheck.ok === false
    && offlineCheck.stage === 'engine-error'
    && /不可用/.test(offlineCheck.message),
  offlineCheck,
);
const pythonCheck = await checkCode('print(1)', 'Python');
check('Python 不做实时检查，只回一句 note', pythonCheck.ok === true && pythonCheck.note !== '' && pythonCheck.diagnostics.length === 0);

/* ---------- 真实引擎 ---------- */

if (!(await hasAssets())) {
  console.log(`· 没找到编译器资源，跳过真实编译（先跑 npm run build，它会下载 ${ENGINE_DIR} 里的大文件）`);
} else {
  const readBuffer = async (name) => {
    const buffer = await readFile(path.join(ENGINE_DIR, name));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  };
  const compileStreaming = async (name) => WebAssembly.compile(await readBuffer(name));

  console.log('· 正在初始化引擎（首次要把 sysroot 解进内存，十几秒）');
  const engine = createCEngine({ readBuffer, compileStreaming });
  await engine.api.ready;

  const sum = await runOnEngine(engine, {
    code: '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);}',
    stdin: '3 4',
  });
  check('带标准输入能编译运行，输出与本地 clang 一致', sum.stage === 'ok' && sum.stdout.trim() === '7');

  const libs = await runOnEngine(engine, {
    code: `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
static int cmp(const void *a, const void *b) { return *(int *)a - *(int *)b; }
int main(void) {
  int nums[] = {5, 2, 9, 1};
  qsort(nums, 4, sizeof(int), cmp);
  char *dup = strdup("abc");
  printf("%d %s %d %.0f\\n", nums[0], dup, (int)strlen(dup), sqrt(16.0));
  free(dup);
  return 0;
}`,
  });
  check('stdlib / string / math 的头文件与库都能用', libs.stage === 'ok' && libs.stdout.trim() === '1 abc 3 4');

  const streams = await runOnEngine(engine, {
    code: '#include <stdio.h>\nint main(void){fprintf(stderr,"warn\\n");printf("out 3\\n");return 0;}',
  });
  check('stderr 不混进 stdout，单独带回来', streams.stdout.trim() === 'out 3' && streams.stderr.trim() === 'warn');

  const broken = await runOnEngine(engine, { code: '#include <stdio.h>\nint main(void){printf("hi" return 0;}' });
  check('编译错误返回 clang 诊断而不是抛异常', broken.stage === 'compile-error' && broken.compileOutput.includes('error'));

  const crash = await runOnEngine(engine, { code: 'int main(void){*(int *)0 = 1; return 0;}' });
  check('野指针崩釜报 run-trap 而不是卡死', crash.stage === 'run-trap');

  const nonzero = await runOnEngine(engine, { code: 'int main(void){return 3;}' });
  check('非零退出码如实带回', nonzero.stage === 'run-exit' && nonzero.exitCode === 3);

  /* ---------- C++：同一套 clang + libc++ ---------- */

  const cpp = await runOnEngine(engine, {
    lang: 'cpp',
    stdin: '3\n3 1 2\n',
    code: `#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;
int main() {
  int n;
  if (!(cin >> n)) return 1;
  vector<int> values(n);
  for (int &value : values) cin >> value;
  sort(values.begin(), values.end());
  cout << "ok";
  for (int value : values) cout << ' ' << value;
  cout << '\\n';
  return 0;
}`,
  });
  check(
    'C++ 用 iostream/vector/algorithm 能编译运行',
    cpp.stage === 'ok' && cpp.stdout.trim() === 'ok 1 2 3',
    cpp,
  );
  check('C++ 编译成功时不带 LLVM 断言噪音', cpp.compileOutput === '', cpp.compileOutput);

  const stdc = await runOnEngine(engine, {
    lang: 'cpp',
    stdin: '4\n4 2 3 1\n',
    code: `#include <bits/stdc++.h>
using namespace std;
int main() {
  int n;
  cin >> n;
  vector<int> values(n);
  for (int &value : values) cin >> value;
  sort(values.begin(), values.end());
  for (int value : values) cout << value << ' ';
  cout << '\\n';
}`,
  });
  check(
    '#include <bits/stdc++.h> 能本地编译运行',
    stdc.stage === 'ok' && stdc.stdout.trim() === '1 2 3 4',
    stdc,
  );

  const cppCheckStart = Date.now();
  const cppCheck = await checkOnEngine(engine, {
    lang: 'cpp',
    code: '#include <vector>\nint main() { std::vector<int> values; values.push_back(1) }',
  });
  const cppCheckMs = Date.now() - cppCheckStart;
  check(
    'C++ 语法检查能报出缺少分号',
    cppCheck.stage === 'compile-error'
      && cppCheck.compileOutput.includes('error')
      && !cppCheck.compileOutput.includes('Assertion failed'),
    cppCheck,
  );
  check('C++ 语法检查在 10 秒内给出结论（不等长超时）', cppCheckMs < 10_000, `${cppCheckMs}ms`);

  // 编译并运行这条路上，缺分号也必须是「编译错误」，而且带着 clang 原文马上回来
  const cppRunStart = Date.now();
  const cppMissingSemicolon = await runOnEngine(engine, {
    lang: 'cpp',
    code: '#include <vector>\nint main() { std::vector<int> values; values.push_back(1) return 0; }',
  });
  const cppRunMs = Date.now() - cppRunStart;
  check(
    'C++ 缺分号：编译错误在 20 秒内返回且带 error:',
    cppMissingSemicolon.stage === 'compile-error'
      && /error:/.test(cppMissingSemicolon.compileOutput)
      && cppRunMs < 20_000,
    { cppMissingSemicolon, cppRunMs },
  );
  check(
    '编译诊断里不带引擎的 Exit 说明',
    !/process exited with code/.test(cppMissingSemicolon.compileOutput),
    cppMissingSemicolon.compileOutput,
  );
  check(
    '编译诊断里不带引擎命令回显（第一行就是报错）',
    !/(^|\n)> /.test(cppMissingSemicolon.compileOutput)
      && /error:/.test(cppMissingSemicolon.compileOutput.split('\n')[0]),
    cppMissingSemicolon.compileOutput,
  );
  const mappedCppError = toCompileResult(cppMissingSemicolon);
  check(
    '真实编译错误映射成「编译错误」并保留 stage=compile',
    mappedCppError.ok === false
      && mappedCppError.statusText === '编译错误'
      && mappedCppError.stage === 'compile'
      && /error:/.test(mappedCppError.compileOutput),
    mappedCppError,
  );
  check(
    '编译错误会连成消息给模型（formatCompileResult 带原文）',
    formatCompileResult(mappedCppError).includes('error:'),
    formatCompileResult(mappedCppError),
  );

  // 回归：日志写满后 hostWrite 不再追加；旧实现会让之后的编译错误永远没有诊断
  engine.log.text = 'x'.repeat(2 * 1024 * 1024);
  engine.log.truncated = true;
  const afterTruncatedLog = await checkOnEngine(engine, {
    lang: 'c',
    code: 'int main(void) { int value = ; }',
  });
  check(
    '引擎日志被截断后仍能拿回诊断',
    afterTruncatedLog.stage === 'compile-error' && /error:/.test(afterTruncatedLog.compileOutput),
    afterTruncatedLog,
  );

  // 引擎在编译途中崩掉：崩之前打出来的那截诊断必须一起带回（不能只剩「内部错误」）
  const crashingEngine = {
    runs: 0,
    log: { text: '', truncated: false },
    api: {
      compile: async () => {
        crashingEngine.log.text += 'pta1.cpp:2:3: error: 模拟的半截诊断\n';
        throw new Error('wasm trap: unreachable');
      },
    },
  };
  const crashed = await runOnEngine(crashingEngine, { lang: 'cpp', code: 'int main(){}' });
  check(
    '引擎崩溃前的半截诊断随结果带回',
    crashed.stage === 'engine-error'
      && /error:/.test(crashed.compileOutput)
      && crashed.message.includes('unreachable'),
    crashed,
  );

  const cppClean = await checkOnEngine(engine, {
    lang: 'cpp',
    code: '#include <vector>\nint main() { std::vector<int> values; values.push_back(1); return 0; }',
  });
  check(
    'C++ 正确代码的语法检查没有诊断',
    cppClean.stage === 'ok'
      && !/\berror:/.test(cppClean.compileOutput)
      && !cppClean.compileOutput.includes('Assertion failed'),
    cppClean,
  );

  const cCheck = await checkOnEngine(engine, {
    lang: 'c',
    code: 'int main(void) { int value = ; }',
  });
  check(
    'C 语法检查仍按 C 前端工作',
    cCheck.stage === 'compile-error' && cCheck.compileOutput.includes('error'),
    cCheck,
  );

  // 代码填空题：作答区只是裁判程序的一段，printf 的头文件在裁判程序里。
  // 带 prelude 时不应报假「未声明」，不带时才报。
  const fragmentCode = 'void Print_Factorial(const int N)\n{\n    printf("%d", N);\n    putchar(10);\n}';
  const fragmentChecked = await checkOnEngine(engine, { lang: 'c', code: fragmentCode, prelude: true });
  check(
    '代码填空片段带 prelude 不报未声明',
    fragmentChecked.stage === 'ok' && !/\berror:/.test(fragmentChecked.compileOutput),
    fragmentChecked,
  );
  const fragmentRaw = await checkOnEngine(engine, { lang: 'c', code: fragmentCode });
  check(
    '不带 prelude 时独立检查会报未声明（说明 prelude 真的生效）',
    fragmentRaw.stage === 'compile-error' && fragmentRaw.compileOutput.includes('error'),
    fragmentRaw,
  );

  const cppFragment = await checkOnEngine(engine, {
    lang: 'cpp',
    code: 'void solve() { std::vector<int> values; values.push_back(1); }',
    prelude: true,
  });
  check('C++ 代码填空片段带 prelude 不报未声明', cppFragment.stage === 'ok' && !/\berror:/.test(cppFragment.compileOutput), cppFragment);
}

/* ---------- 汇报文本与样例比对 ---------- */

const run = formatCompileResult({
  ok: true, statusText: '运行成功', stdout: '7\n', stderr: '',
  compileOutput: '', message: '', time: '1.25', memory: null,
});
check('结果会带上状态、耗时与输出', run.includes('内置编译器返回：运行成功') && run.includes('耗时 1.25s') && run.includes('7'));
check('超长输出会截断', formatCompileResult({ ...run, stdout: 'a'.repeat(9000) }).includes('已截断'));
check('样例输出一致（忽略尾部空白与末尾空行）', compareOutput('7\n', '7').same === true);
const diff = compareOutput('7\n3\n', '7\n4');
check('样例不一致时指出第几行与期望/实际', diff.same === false && diff.detail.includes('第 2 行') && diff.detail.includes('4'));

// 语言分类：C++ 必须排在 C 前面，否则 'C++ (g++)' 会被 /^c\b/ 判成 C
check('C++ 语言标记识别为 cpp', checkLanguage('C++ (g++)') === 'cpp' && checkLanguage('cpp') === 'cpp' && checkLanguage('CXX') === 'cpp');
check('C 语言标记仍识别为 c', checkLanguage('C') === 'c' && checkLanguage('C (gcc 9.2)') === 'c');
check('Python/Java 不走内置实时检查', checkLanguage('Python') === null && checkLanguage('Java') === null);
check('isCheckableLanguage 覆盖 C 与 C++', isCheckableLanguage('C') && isCheckableLanguage('C++'));

/* ---------- 内置 JavaScript 运行器：Node 风格垫片 ---------- */

const jsConsole = await compileAndRunJs({
  code: 'console.log("sum", 1 + 2); process.stdout.write("tail");',
  stdin: '',
});
check('JS console.log 与 process.stdout.write 都能输出', jsConsole.ok && jsConsole.stdout === 'sum 3\ntail', jsConsole);

const jsReadline = await compileAndRunJs({
  code: `const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let total = 0;
rl.on('line', (line) => {
  for (const value of line.trim().split(/\\s+/)) total += Number(value || 0);
});
rl.on('close', () => console.log(total));`,
  stdin: '1 2 3\n4\n',
});
check('JS require("readline") 能按行读入并输出', jsReadline.ok && jsReadline.stdout.trim() === '10', jsReadline);

const jsStdin = await compileAndRunJs({
  code: `let text = '';
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => console.log(text.toUpperCase()));`,
  stdin: 'abc\n',
});
check('JS process.stdin data/end 事件可用', jsStdin.ok && jsStdin.stdout.trim() === 'ABC', jsStdin);

const jsAwait = await compileAndRunJs({
  code: 'const value = await Promise.resolve(7); console.log(value);',
  stdin: '',
});
check('JS 支持顶层 await', jsAwait.ok && jsAwait.stdout.trim() === '7', jsAwait);

console.log('\n内置 C / C++ 编译器校验通过');
