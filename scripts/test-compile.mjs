// 内置 C 编译器：用真实引擎（clang22-noeh + lld22-noeh + sysroot22.tar）跑几段 C，
// 顺带校验样例比对（尾部空白、末尾空行不算差异）。
// 大资源缺失时（没跑过 npm run build）跳过真实编译并提示。
// 用法：node scripts/test-compile.mjs
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { compareOutput, formatCompileResult } from '../src/background/compile.ts';
import { createCEngine, runOnEngine } from '../public/engine/engine-core.js';

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

console.log('\n内置 C 编译器校验通过');
