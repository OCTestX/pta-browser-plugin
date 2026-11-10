// 内置 C 编译器：用真实引擎（clang22-noeh + lld22-noeh + sysroot22.tar）跑几段 C，
// 顺带校验样例比对（尾部空白、末尾空行不算差异）。
// 大资源缺失时（没跑过 npm run build）跳过真实编译并提示。
// 用法：node scripts/test-compile.mjs
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareOutput, formatCompileResult, checkLanguage, isCheckableLanguage, compileAndRunJs } from '../src/background/compile.ts';
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

  const cppCheck = await checkOnEngine(engine, {
    lang: 'cpp',
    code: '#include <vector>\nint main() { std::vector<int> values; values.push_back(1) }',
  });
  check(
    'C++ 语法检查能报出缺少分号',
    cppCheck.stage === 'compile-error'
      && cppCheck.compileOutput.includes('error')
      && !cppCheck.compileOutput.includes('Assertion failed'),
    cppCheck,
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
