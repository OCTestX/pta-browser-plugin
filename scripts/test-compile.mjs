// 内置 C 编译器：用真实引擎（clang22-noeh + lld22-noeh + sysroot22.tar）跑几段 C，
// 顺带校验样例比对（尾部空白、末尾空行不算差异）与 Python 语法检查
// （浏览器里走 Pyodide；Node 里用 python3 只 compile + AST，不执行）。
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
  asStdin,
  compileAndRunJs,
  compileAndRunCpp,
  compileAndRunPython,
  checkCode,
  checkPythonWithNode,
  engineFailureResult,
  toCompileResult,
} from '../src/background/compile.ts';
import { createEngineQueue } from '../src/background/compiler-host.ts';
import { adviceForMessage } from '../src/shared/code-diagnostics.ts';
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

/* ---------- Python worker：检查结果必须是 JSON 字符串 ---------- */

// 浏览器端 checkPython 只解析字符串；如果 Python 函数直接 return list，
// payload 是 PyProxy，宿主会当成空数组，所有 Python 诊断都会消失。Node 路径
// 外面裹了 json.dumps，所以单测覆盖不到，这里直接盯 worker 源码。
const compileWorkerSource = await readFile(path.join(ENGINE_DIR, 'compile-worker.js'), 'utf8');
check(
  'Python worker 检查器把诊断序列化成 JSON 字符串',
  compileWorkerSource.includes('return __pta_json.dumps(__pta_undefined_names') &&
    compileWorkerSource.includes('return __pta_json.dumps([{'),
);
check(
  'Python worker 冲掉没有换行的尾段输出',
  compileWorkerSource.includes('sys.stdout.write') &&
    compileWorkerSource.includes("replace(/\\n$/, '')"),
);

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

/* ---------- stdin 类型归一化（模型常把样例输入写成数字） ---------- */

// 回归：模型传 stdin: 2（JSON number）时，旧实现只认 string，静默变成空串
check(
  'asStdin：数字/布尔转成字符串，undefined/null 是空串，字符串原样',
  asStdin(2) === '2'
    && asStdin(0) === '0'
    && asStdin(false) === 'false'
    && asStdin('7 8\n') === '7 8\n'
    && asStdin([[1, 2], [3, 4]]) === '[[1,2],[3,4]]'
    && asStdin(undefined) === ''
    && asStdin(null) === '',
  [asStdin(2), asStdin(0), asStdin(false), asStdin([[1, 2], [3, 4]]), asStdin(undefined), asStdin(null)],
);

// 真的喂进 Python 运行器：input() 必须读到归一化后的 '2'，而不是 EOF
const pyStdinNumber = await compileAndRunPython({ code: 'print(input())\n', stdin: asStdin(2) });
check(
  'stdin 传数字 2 也能当 "2" 进 Python 运行器',
  pyStdinNumber.ok === true && pyStdinNumber.stdout.trim() === '2',
  pyStdinNumber,
);

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
/* ---------- Python 语法检查（compile + AST，不执行） ---------- */

/** 诊断盒子里的字符下标 → 「第几行第几列」（列按字符算，只用于断言定位） */
const positionOf = (text, offset) => {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before[before.length - 1].length + 1 };
};

const pyCleanSource = 'n = int(input())\nprint(n + 1)\n';
const pyClean = await checkCode(pyCleanSource, 'Python (python3)');
check(
  'Python 正确代码 0 诊断',
  pyClean.ok === true && pyClean.errorCount === 0 && pyClean.diagnostics.length === 0 && pyClean.note === '',
  pyClean,
);

const pyColonSource = 'x = 1\nif x == 1\n    print(x)\n';
const pyColon = await checkCode(pyColonSource, 'python3');
const pyColonBox = pyColon.diagnostics[0];
check(
  'Python 缺冒号：报在 if 行，带英文原文和中文建议',
  pyColon.errorCount === 1
    && positionOf(pyColonSource, pyColonBox.from).line === 2
    && /expected ':'/.test(pyColonBox.message)
    && /冒号/.test(pyColonBox.advice),
  pyColon,
);

const pyIndentSource = 'x = 1\n    y = 2\n';
const pyIndent = await checkCode(pyIndentSource, 'py3');
const pyIndentBox = pyIndent.diagnostics[0];
check(
  'Python 缩进错误：指向第 2 行，不越到上一行',
  pyIndent.errorCount === 1
    && positionOf(pyIndentSource, pyIndentBox.from).line === 2
    && pyIndentBox.from > pyIndentSource.indexOf('\n')
    && /unexpected indent/.test(pyIndentBox.message)
    && /缩进/.test(pyIndentBox.advice),
  pyIndent,
);

const pyUnclosedSource = 'print(1,\n';
const pyUnclosed = await checkCode(pyUnclosedSource, 'Python 3');
const pyUnclosedBox = pyUnclosed.diagnostics[0];
check(
  'Python 未闭合括号：带位置和括号建议',
  pyUnclosed.errorCount === 1
    && positionOf(pyUnclosedSource, pyUnclosedBox.from).line === 1
    && /never closed/.test(pyUnclosedBox.message)
    && /括号/.test(pyUnclosedBox.advice),
  pyUnclosed,
);

// 列号是 UTF-8 字节：同一行前面有中文时，换算成字符下标不能指偏
const pyChineseSource = '中文 = 1\nif 中文 == 1\n    pass\n';
const pyChinese = await checkCode(pyChineseSource, 'python3');
const pyChineseBox = pyChinese.diagnostics[0];
check(
  'Python 中文标识符后面的报错列号不偏',
  pyChinese.errorCount === 1
    && positionOf(pyChineseSource, pyChineseBox.from).line === 2
    && pyChineseBox.from === pyChineseSource.lastIndexOf('1'),
  pyChinese,
);

// 「只 compile 不执行」：运行期错误不算语法错误，检查过程也不会产生 stdout
const pyRuntimeOnly = await checkCode('raise SystemExit(1)\n1 / 0\n', 'Python');
check('Python 检查只编译不执行（运行期错误不报）', pyRuntimeOnly.ok === true && pyRuntimeOnly.errorCount === 0, pyRuntimeOnly);
const pyNoExecution = await checkPythonWithNode('print("这条不该执行")\n');
check('Python 检查不执行代码，stdout 为空', pyNoExecution.stage === 'ok' && pyNoExecution.stdout === '', pyNoExecution);
const pyDiagnosticText = await checkPythonWithNode('x = 1\nif x == 1\n    pass\n');
check(
  'Python 诊断原文是 <pta>:行:列: error: 说明',
  /^<pta>:2:\d+: error: expected ':'\n$/.test(pyDiagnosticText.compileOutput),
  pyDiagnosticText.compileOutput,
);

// AST 未定义名字：`returnsentence` 语法完全合法，compile() 不报，但运行时必然 NameError
const pyUndefinedSource = 'print(returnsentence)\n';
const pyUndefined = await checkCode(pyUndefinedSource, 'Python');
const pyUndefinedBox = pyUndefined.diagnostics[0];
check(
  'Python 未定义名字：报 undefined name、error，指向名字本身',
  pyUndefined.errorCount === 1
    && pyUndefined.diagnostics.length === 1
    && pyUndefinedBox?.severity === 'error'
    && /undefined name 'returnsentence'/.test(pyUndefinedBox.message)
    && /拼写|赋值|导入/.test(pyUndefinedBox.advice)
    && positionOf(pyUndefinedSource, pyUndefinedBox.from).line === 1
    && pyUndefinedBox.from === pyUndefinedSource.indexOf('returnsentence'),
  pyUndefined,
);

// 定义来源要认全：参数、import 别名、for/with 目标、comprehension 变量、函数/类名、dunder
const pyDefinedSource = `import math as m
from os import path

def area(radius, scale=2):
    values = [index * scale for index in range(radius)]
    total = 0
    for value in values:
        total += value
    return total * m.pi

class Box:
    pass

with open(path.join('.', 'data.txt')) as handle:
    pass

print(__name__, area(3), Box)
`;
const pyDefined = await checkCode(pyDefinedSource, 'Python');
check(
  'Python 参数/导入/循环/comprehension 等定义名都认得（0 诊断）',
  pyDefined.ok === true && pyDefined.errorCount === 0 && pyDefined.diagnostics.length === 0,
  pyDefined,
);

// 多个未定义名字：同名只报一次，按首次出现排序
const pyMultiSource = 'z = later + missing\nprint(missing, later)\n';
const pyMulti = await checkCode(pyMultiSource, 'Python');
const pyMultiNames = pyMulti.diagnostics.map((item) => /undefined name '([^']+)'/.exec(item.message)?.[1] ?? '');
check(
  '多个未定义名字按首次出现排序、同名只报一次',
  pyMulti.errorCount === 2
    && pyMultiNames.join(',') === 'later,missing'
    && positionOf(pyMultiSource, pyMulti.diagnostics[0].from).column === 5,
  pyMulti,
);

// from x import * 会带进未知名字：这时不该报未定义
const pyStarImport = await checkCode('from math import *\nprint(cos(0))\n', 'Python');
check('from x import * 时跳过未定义名字检查（不误报）', pyStarImport.diagnostics.length === 0, pyStarImport);

// 代码填空片段插进裁判程序后缩进层级未知：unexpected indent 不算学生的错
const pyFragment = await checkCode('    x = 1\n', 'Python', undefined, true);
check('Python 代码填空片段不报缩进假错', pyFragment.errorCount === 0 && pyFragment.diagnostics.length === 0, pyFragment);

// 片段里用到题面/裁判提供的名字很常见：未定义名字按 warning 报，不算错误
const pyFragmentUndefinedSource = '    result = answer * factor\n';
const pyFragmentUndefined = await checkCode(pyFragmentUndefinedSource, 'Python', undefined, true);
check(
  'Python 片段里的未定义名字按 warning 报（缩进也不误报）',
  pyFragmentUndefined.ok === true
    && pyFragmentUndefined.errorCount === 0
    && pyFragmentUndefined.diagnostics.length === 2
    && pyFragmentUndefined.diagnostics.every((item) => item.severity === 'warning'),
  pyFragmentUndefined,
);

// Python 的常见报错都要有能照着改的中文建议（不能落到默认的「对照英文说明」）
const pythonAdvice = [
  ['invalid syntax', '语法'],
  ['unexpected indent', '缩进'],
  ['unindent does not match any outer indentation level', '缩进'],
  ['unterminated string literal (detected at line 1)', '引号'],
  ['EOF while scanning triple-quoted string literal', '引号'],
  ["undefined name 'returnsentence'", '拼写'],
];
check(
  'Python 常见报错都有中文建议',
  pythonAdvice.every(([message, hint]) => adviceForMessage(message).includes(hint)),
  pythonAdvice.map(([message]) => [message, adviceForMessage(message)]),
);

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
check(
  'Python 语言标记识别为 python',
  checkLanguage('Python') === 'python'
    && checkLanguage('Python (python3)') === 'python'
    && checkLanguage('python3') === 'python'
    && checkLanguage('py3') === 'python',
);
check(
  'Java 语言标记识别为 java（JavaScript 不算）',
  checkLanguage('Java') === 'java'
    && checkLanguage('Java (javac 17)') === 'java'
    && checkLanguage('JavaScript') === null,
);
check(
  'isCheckableLanguage 覆盖 C / C++ / Python / Java',
  ['C', 'C++', 'Python', 'Java'].every((name) => isCheckableLanguage(name)),
);

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
