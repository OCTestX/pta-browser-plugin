// 赶题模式本轮统计：reset / 去重 / 结论覆盖 / 汇总文案。
// 纯内存逻辑，Node 剥类型后直接导入 .ts。
// 用法：node scripts/test-batch.mjs
import {
  batchActive,
  batchSnapshot,
  batchStats,
  batchSummary,
  finishBatch,
  recordVerdict,
  resetBatch,
  setCurrentProblem,
  setRemaining,
  setTotal,
} from '../src/background/batch-progress.ts';
import { buildRedoCommand, parseRedoTargets } from '../src/shared/batch.ts';
import {
  clearSubmitted,
  markSubmitted,
  submittedProblems,
} from '../src/background/submitted-problems.ts';

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

/* ---------- 总览卡用的快照 ---------- */

// 没开过赶题模式的标签页：快照是空的，面板据此不画卡
const idle = batchSnapshot(999);
check('没开赶题模式时快照不激活', idle.active === false, idle);
check('没开赶题模式时没有题目', idle.problems.length === 0, idle);

// 普通标签页不该因为 finishBatch 而凭空多出一轮统计
finishBatch(998);
check('没开过赶题模式的标签页不会被 finishBatch 造出统计', batchActive(998) === false);
check('没开过赶题模式的标签页快照仍然不激活', batchSnapshot(998).active === false);

// 单道题做题：读题会记统计，但面板不该因此冒出一张「赶题模式」卡
setCurrentProblem(501, { key: 's1', title: '单题', type: '7' });
check('单题做题不激活赶题模式卡', batchSnapshot(501).active === false, batchSnapshot(501).active);
check('单题做题时 batchActive 也是 false', batchActive(501) === false);

resetBatch(7);
check('开一轮后快照激活', batchSnapshot(7).active === true);

// 正在做的题：没结论时是「进行中」
setCurrentProblem(7, { key: 'p1', title: '7-1 第一题', type: '7' });
let snap = batchSnapshot(7);
check('快照里有一道题', snap.problems.length === 1, snap);
check('当前题就是刚读的那道', snap.current?.title === '7-1 第一题', snap);
check('没结论的当前题标成进行中', snap.problems[0].status === 'current', snap.problems);
check('没结论的题算进 unknown', snap.unknown === 1 && snap.failed === 0 && snap.accepted === 0, snap);

// 拿到结论后：结论优先于「进行中」——刚 AC 完的那道题要显示 AC
recordVerdict(7, 'AC');
snap = batchSnapshot(7);
check('AC 之后状态是 accepted', snap.problems[0].status === 'accepted', snap.problems);
check('AC 之后 accepted 计数加一', snap.accepted === 1 && snap.unknown === 0, snap);
check('AC 之后当前题仍然是那道题', snap.current?.title === '7-1 第一题', snap);

// 换到下一题：上一题保留结论，新题是进行中
setCurrentProblem(7, { key: 'p2', title: '7-2 第二题', type: '7' });
recordVerdict(7, 'WA');
snap = batchSnapshot(7);
check('两道题都在清单里', snap.problems.length === 2, snap.problems);
check('第一题仍是 AC', snap.problems[0].status === 'accepted', snap.problems);
check('没过的题标成 failed', snap.problems[1].status === 'failed', snap.problems);
check('没过的题带上结论', snap.problems[1].verdict === 'WA', snap.problems);
check('当前题切到第二题', snap.current?.title === '7-2 第二题', snap);

// 「还剩几题」「一共几题」：面板据此画整份题单的进度条
setRemaining(7, 5);
setTotal(7, 12);
snap = batchSnapshot(7);
check('快照带上还剩几题', snap.remaining === 5, snap);
check('快照带上题单总数', snap.total === 12, snap);

// 收工
finishBatch(7);
snap = batchSnapshot(7);
check('收工后快照标记为已结束', snap.finished === true, snap);
check('收工后统计还在', snap.attempted === 2 && snap.accepted === 1 && snap.failed === 1, snap);
check('正常收工写的是 done', snap.stopReason === 'done', snap);

// 用户按了停止：跟「题单做完了」不是一回事，卡片上要写清楚
finishBatch(7, 'stopped');
snap = batchSnapshot(7);
check('按停止后写明是 stopped', snap.stopReason === 'stopped', snap);
check('按停止后仍然算已结束', snap.finished === true, snap);

// 开新一轮：快照也回到空状态
resetBatch(7);
snap = batchSnapshot(7);
check('开新一轮后快照清空', snap.attempted === 0 && snap.problems.length === 0 && snap.remaining === null && snap.total === null, snap);
check('开新一轮后未收工', snap.finished === false, snap);

/* ---------- 题目地址：面板靠它把用户带回那道题 ---------- */

resetBatch(9);
setCurrentProblem(9, {
  key: 'p1',
  title: '7-1 第一题',
  type: '7',
  url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=111',
});
recordVerdict(9, 'WA');
snap = batchSnapshot(9);
check('快照带上题目地址', snap.problems[0].url.includes('problemSetProblemId=111'), snap.problems[0]);

// 换到下一题时地址也跟着更新（next_problem 报来的地址更完整）
setCurrentProblem(9, {
  key: 'p2',
  title: '7-2 第二题',
  type: '7',
  url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=222',
});
snap = batchSnapshot(9);
check('换题后新题也带地址', snap.problems[1].url.includes('problemSetProblemId=222'), snap.problems[1]);
check('上一题的地址不被改掉', snap.problems[0].url.includes('problemSetProblemId=111'), snap.problems[0]);

// 没地址的题：面板不能给「重做」按钮
setCurrentProblem(9, { key: 'p3', title: '7-3 第三题', type: '7' });
recordVerdict(9, 'CE');
snap = batchSnapshot(9);
check('没地址的题地址是空串', snap.problems[2].url === '', snap.problems[2]);
check('两题没过', snap.failed === 2, snap);

/* ---------- 「重做没过的题」那条指令 ---------- */

const failed = snap.problems.filter((problem) => problem.status === 'failed');
const redo = buildRedoCommand(failed);
check('重做指令是 /fuck 开头', redo.startsWith('/fuck'), redo);
check('重做指令带上了题目标题', redo.includes('7-1 第一题'), redo);
check('重做指令带上了题目地址', redo.includes('problemSetProblemId=111'), redo);
check('没地址的题不会被写进重做指令', !redo.includes('7-3 第三题'), redo);
check(
  '全部没地址时指令是空串',
  buildRedoCommand(snap.problems.filter((problem) => !problem.url)) === '',
);
check('没有可重做的题时指令是空串', buildRedoCommand([]) === '', buildRedoCommand([]));

/* ---------- 从重做指令里把地址抠出来（后台靠它认「点名重做」这一轮） ---------- */

const redoTargets = parseRedoTargets(redo);
check('重做指令里能抠出题目地址', redoTargets.length === 1, redoTargets);
check('抠出来的地址就是那道题的地址', redoTargets[0].includes('problemSetProblemId=111'), redoTargets);
check('普通消息里抠不出地址', parseRedoTargets('/fuck 赶紧做完剩下的题').length === 0);
check('半角冒号也认', parseRedoTargets('地址: https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=9').length === 1);
check(
  '多道题能抠出多个地址',
  parseRedoTargets('1. 甲\n   地址：https://a/1\n2. 乙\n   地址：https://b/2').join(',') === 'https://a/1,https://b/2',
);

/* ---------- 插件自己记的「提交过的题」 ---------- */

clearSubmitted(77);
check('一开始没提交过任何题', submittedProblems(77).length === 0);
markSubmitted(77, '733');
markSubmitted(77, '734');
check('提交过的题被记下来', submittedProblems(77).join(',') === '733,734', submittedProblems(77));
markSubmitted(77, '733');
check('同一道题重复提交只记一条', submittedProblems(77).length === 2);
markSubmitted(77, '  ');
check('空 ID 不记', submittedProblems(77).length === 2);
markSubmitted(78, '900');
check('不同标签页各记各的', submittedProblems(77).length === 2 && submittedProblems(78).length === 1);
clearSubmitted(77);
check('整页重新加载后清掉（页面侧栏这时已经刷新）', submittedProblems(77).length === 0);
check('别的标签页不受影响', submittedProblems(78).length === 1);

/* ---------- 提交过却没拿到结论的题 ---------- */

resetBatch(99);
setCurrentProblem(99, { key: 'p1', title: '题目一' });
markSubmitted(99, 'p1');
let snap99 = batchSnapshot(99);
check(
  '正在做的题标成 current',
  snap99.problems.find((problem) => problem.key === 'p1')?.status === 'current',
  snap99.problems,
);
setCurrentProblem(99, { key: 'p2', title: '题目二' });
snap99 = batchSnapshot(99);
const doneWithoutVerdict = snap99.problems.find((problem) => problem.key === 'p1');
check(
  '提交过但没拿到判题结论的题标成「没结论」（不是「待做」）',
  doneWithoutVerdict?.status === 'unknown',
  doneWithoutVerdict,
);
// 判题结论记在当前题头上（判题弹窗是当前这一页的）
recordVerdict(99, 'AC');
snap99 = batchSnapshot(99);
check(
  '判题结论记到当前题上',
  snap99.problems.find((problem) => problem.key === 'p2')?.status === 'accepted',
  snap99.problems,
);
clearSubmitted(99);

console.log('\n赶题统计通过');
