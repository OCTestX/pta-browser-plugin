// 提交运行时间解析的单测：纯逻辑，Node 剥掉类型后直接导入 .ts。
//
// 这里钉的是真机上踩到的两个坑：
//   · 表头是英文 `Time Usage`（不是「运行时间」），按中文词找列会一条都找不到；
//   · 同一行里还有「564 KB」的内存列，单位认错就会把内存当时间画。
//
// 用法：node scripts/test-submission-runtime.mjs
const {
  isTimeUsageHeader,
  parseRuntimeCell,
  parseRuntimeText,
} = await import('../src/shared/submission-runtime.ts');

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ---- 1. 表头 ----
check('英文表头 Time Usage 认得出（真机就是它）', isTimeUsageHeader('Time Usage'));
check('中文表头「运行时间」认得出', isTimeUsageHeader('运行时间'));
check('内存列不算运行时间', isTimeUsageHeader('Memory Usage') === false);
check('其它表头不算', isTimeUsageHeader('Submit At') === false);

// ---- 2. 单元格 ----
check('2 ms 解析成 2', parseRuntimeCell('2 ms') === 2, parseRuntimeCell('2 ms'));
check('0.012 s 解析成 12 毫秒', parseRuntimeCell('0.012 s') === 12, parseRuntimeCell('0.012 s'));
check('毫秒中文单位也认', parseRuntimeCell('7 毫秒') === 7);
check('内存列 564 KB 返回 null', parseRuntimeCell('564 KB') === null);
check('提交时间那列返回 null', parseRuntimeCell('2026/11/18 21:25:08') === null);
check('空单元格返回 null', parseRuntimeCell('') === null);
check('0 ms 是合法值（不是 null）', parseRuntimeCell('0 ms') === 0);

// ---- 3. 整行文本（没有独立时间列时的退路）----
check('中文行文本能抠出时间', parseRuntimeText('运行时间：12 ms 内存 564 KB') === 12);
check('英文行文本能抠出时间', parseRuntimeText('Run Time 0.5 s') === 500);
check('没有运行时间字样的行返回 null', parseRuntimeText('Accepted 20 7-30 C++ (g++) 564 KB') === null);

console.log('\n全部通过');
