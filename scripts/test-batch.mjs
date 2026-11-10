// 赶题模式本轮统计：reset / 去重 / 结论覆盖 / 汇总文案。
// 纯内存逻辑，Node 剥类型后直接导入 .ts。
// 用法：node scripts/test-batch.mjs
import {
  batchStats,
  batchSummary,
  recordVerdict,
  resetBatch,
  setCurrentProblem,
} from '../src/background/batch-progress.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// 新一轮开始前没有任何统计
resetBatch(7);
check('没做过题时没有统计', batchStats(7) === null && batchSummary(7) === '');

// 同一道题重复读题只算一条；结论后一次覆盖前一次
setCurrentProblem(7, { key: 'p1', title: '7-1 第一题', type: '7' });
recordVerdict(7, 'WA');
recordVerdict(7, 'AC');
setCurrentProblem(7, { key: 'p1', title: '7-1 第一题（读题重跑）', type: '7' });

setCurrentProblem(7, { key: 'p2', title: '7-2 第二题', type: '7' });
recordVerdict(7, 'CE');
setCurrentProblem(7, { key: 'p3', title: '7-3 第三题', type: '7' });

const stats = batchStats(7);
check('按题目去重后统计 3 题', stats.attempted === 3, stats);
check('AC 计 1 题', stats.accepted === 1, stats);
check('未过计 1 题（结论覆盖成最后一次）', stats.failed === 1, stats);
check('没拿到结论的题单独计数', stats.unknown === 1, stats);

const summary = batchSummary(7);
check(
  '汇总里带做过/AC/未过与未过题名',
  summary.includes('做过 3 题') && summary.includes('AC 1 题') && summary.includes('7-2 第二题（CE）'),
  summary,
);

// 同一题再次读题会更新标题（read_problem 拿到的才是真标题）
setCurrentProblem(7, { key: 'p2', title: '7-2 真标题', type: '7' });
check('同一题的标题会随读题更新', batchSummary(7).includes('7-2 真标题'), batchSummary(7));

// reset 之后上一轮不残留
resetBatch(7);
check('开新一轮会清空上一轮统计', batchStats(7) === null);

console.log('\n赶题统计通过');
