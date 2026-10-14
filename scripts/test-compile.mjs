// 编译并运行 C：用假 fetch 覆盖请求形状与各种返回（成功/编译错误/运行错误/超时/限流/非 JSON/截断）。
// 加 --live 会真的打一次默认编译服务，验证整条链路。
// 用法：node scripts/test-compile.mjs [--live]
import { compareOutput, compileAndRun, formatCompileResult } from '../src/background/compile.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const SERVICE = 'https://ce.judge0.com';
const realFetch = globalThis.fetch; // 桩测试会覆盖它，--live 前要还回来
let lastRequest = null;

function stubFetch(body, status = 200) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, body: JSON.parse(init.body) };
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(payload, { status, headers: { 'Content-Type': 'application/json' } });
  };
}

const runRaw = (options = {}) =>
  compileAndRun({
    code: '#include <stdio.h>\nint main(void){return 0;}',
    stdin: '3 4',
    serviceURL: SERVICE,
    languageId: 50,
    ...options,
  });

const run = async (options = {}) => formatCompileResult(await runRaw(options));

/* ---------- 成功 ---------- */

stubFetch({ stdout: '7\n', time: '0.002', memory: 876, status: { id: 3, description: 'Accepted' } });
const ok = await run();
check('请求打到 Judge0 的 submissions 接口并等待结果', lastRequest.url === `${SERVICE}/submissions?base64_encoded=false&wait=true`);
check('请求体带上源码、标准输入与语言 ID', lastRequest.body.source_code.includes('int main') && lastRequest.body.stdin === '3 4' && lastRequest.body.language_id === 50);
check('成功时汇报输出与耗时内存', ok.includes('运行成功') && ok.includes('7') && ok.includes('0.002s'));

/* ---------- 编译错误 ---------- */

stubFetch({ stdout: null, compile_output: "main.c:3:5: error: expected ';'", status: { id: 6, description: 'Compilation Error' } });
const compileError = await run();
check('编译错误时把编译器输出原样带回来', compileError.includes('编译错误') && compileError.includes("expected ';'"));

/* ---------- 运行错误 ---------- */

stubFetch({ stdout: '', stderr: 'Segmentation fault (core dumped)', status: { id: 11, description: 'Runtime Error (NZEC)' } });
const runtimeError = await run();
check('运行时错误时汇报状态与标准错误', runtimeError.includes('运行时错误') && runtimeError.includes('Segmentation fault'));

/* ---------- 超时 ---------- */

stubFetch({ stdout: '', status: { id: 5, description: 'Time Limit Exceeded' } });
check('超时会如实汇报', (await run()).includes('运行超时'));

/* ---------- 服务侧问题 ---------- */

stubFetch({ message: 'Too many requests' }, 429);
try {
  await run();
  throw new Error('✗ 限流没有抛错');
} catch (error) {
  check('限流有专门提示', error.message.includes('限流'));
}

stubFetch('<html>504 Gateway Timeout</html>');
try {
  await run();
  throw new Error('✗ 非 JSON 没有抛错');
} catch (error) {
  check('返回不是 JSON 时提示清楚', error.message.includes('不是 JSON'));
}

globalThis.fetch = async () => {
  throw new TypeError('fetch failed');
};
try {
  await run({ serviceURL: 'https://judge.example.com' });
  throw new Error('✗ 连不上没有抛错');
} catch (error) {
  check('连不上编译服务时提示检查地址', error.message.includes('连不上编译服务'));
}

/* ---------- 输出过长要截断 ---------- */

stubFetch({ stdout: 'a'.repeat(9000), status: { id: 3 } });
const longOutput = await run();
check('输出过长会截断并说明', longOutput.includes('已截断'));

/* ---------- 结构化结果与样例比对 ---------- */

stubFetch({ stdout: '7\n', status: { id: 3 } });
const structured = await runRaw();
check('结构化结果里带 stdout 与 ok', structured.ok === true && structured.stdout === '7\n');

check('样例输出一致（忽略尾部空白与末尾空行）', compareOutput('7\n', '7').same === true);
const diff = compareOutput('7\n3\n', '7\n4');
check('样例输出不一致时指出第几行、期望与实际', diff.same === false && diff.detail.includes('第 2 行') && diff.detail.includes('4'));

/* ---------- 可选：真打一次 ---------- */

if (process.argv.includes('--live')) {
  globalThis.fetch = realFetch;
  const live = await compileAndRun({
    code: '#include <stdio.h>\nint main(void){int a,b;scanf("%d %d",&a,&b);printf("%d\\n",a+b);}',
    stdin: '3 4',
    serviceURL: SERVICE,
    languageId: 50,
  });
  check(`真实编译服务可用（${SERVICE}）`, live.includes('运行成功') && live.includes('7'));
  console.log('\n真实返回：\n' + live);
}

console.log('\n编译运行校验通过');
