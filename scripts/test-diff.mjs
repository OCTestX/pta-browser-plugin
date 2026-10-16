// diff 引擎的单元校验：行配对、行号、颜色分类、超大输入的降级行为。
// 用法：node scripts/test-diff.mjs
import { diffLines, diffStats, markWordChanges, segmentDiff } from '../src/shared/diff.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const types = (rows) => rows.map((row) => row.type);
const left = (rows) => rows.map((row) => row.left);
const right = (rows) => rows.map((row) => row.right);

/* ---------- 完全一样 ---------- */

const same = diffLines('a\nb\nc', 'a\nb\nc');
check('相同文本全是 equal', types(same).every((type) => type === 'equal') && same.length === 3);
check('相同文本行号一一对应', same[2].leftNo === 3 && same[2].rightNo === 3);

/* ---------- 改一行 ---------- */

const modified = diffLines('int a = 1;\nint b = 2;\nreturn 0;', 'int a = 1;\nint b = 3;\nreturn 0;');
check('改一行得到一行 mod', types(modified).join(',') === 'equal,mod,equal');
check('mod 左右分别是旧行与新行', modified[1].left === 'int b = 2;' && modified[1].right === 'int b = 3;');
check('行号跟着走', modified[1].leftNo === 2 && modified[1].rightNo === 2);
check('统计：改 1 行', JSON.stringify(diffStats(modified)) === '{"added":0,"removed":0,"changed":1}');

/* ---------- 加一行 ---------- */

const added = diffLines('a\nb', 'a\nb\nc');
check('尾部新增得到一行 add', types(added).join(',') === 'equal,equal,add');
check('add 只在右列有内容', added[2].left === undefined && added[2].right === 'c');
check('新增行号是右列的', added[2].rightNo === 3 && added[2].leftNo === undefined);

/* ---------- 删一行 ---------- */

const removed = diffLines('a\nb\nc', 'a\nc');
check('中间删除得到一行 del', types(removed).join(',') === 'equal,del,equal');
check('del 只在左列有内容', removed[1].left === 'b' && removed[1].right === undefined);

/* ---------- 删两行、加一行：多的那条要单独标出来 ---------- */

const mixed = diffLines('a\nx\ny\nz', 'a\nb\nz');
check('删 2 加 1 会配对成一行 mod 加一行 del', types(mixed).join(',') === 'equal,mod,del,equal');
check('配对的是靠前的两行', mixed[1].left === 'x' && mixed[1].right === 'b');
check('剩下的删除行单独显示', mixed[2].left === 'y' && mixed[2].right === undefined);
check(
  '统计：新增 0、修改 1、删除 1',
  JSON.stringify(diffStats(mixed)) === '{"added":0,"removed":1,"changed":1}',
);

/* ---------- 全换 ---------- */

const rewrite = diffLines('old one\nold two', 'new one\nnew two');
check('整段重写会全部配对成 mod', types(rewrite).join(',') === 'mod,mod');

/* ---------- 空的一侧 ---------- */

check('空文本 -> 有内容全算新增', types(diffLines('', 'a\nb')).join(',') === 'add,add');
check('有内容 -> 空文本全算删除', types(diffLines('a\nb', '')).join(',') === 'del,del');

/* ---------- 超大输入的降级：别把界面卡死 ---------- */

const bigLeft = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
const bigRight = `${bigLeft}\nextra`;
const big = diffLines(bigLeft, bigRight);
check(
  '改动规模超过 DP 上限时降级：仍然标出新增行',
  big.some((row) => row.type === 'add' && row.right === 'extra') && big.length > 900,
);

/* ---------- 统计与行号合计自洽 ---------- */

const sample = diffLines('1\n2\n3\n4', '1\n9\n3\n4\n5');
check(
  '左列行号从 1 起连续、不跳号',
  sample.map((row) => row.leftNo).filter((no) => no !== undefined).join(',') === '1,2,3,4',
);
check(
  '右列行号从 1 起连续、不跳号',
  sample.map((row) => row.rightNo).filter((no) => no !== undefined).join(',') === '1,2,3,4,5',
);
check('改过的那行左右是 2 和 9', sample.find((row) => row.type === 'mod')?.left === '2' && sample.find((row) => row.type === 'mod')?.right === '9');
check('四行原文变成五行新文本', left(sample).filter((line) => line !== undefined).length === 4 && right(sample).filter((line) => line !== undefined).length === 5);

/* ---------- 改动块 / 上下文分段（界面靠它把改动聚成一团） ---------- */

const segments = segmentDiff(diffLines('a\nb\nc\nd\ne\nf\ng\nh\nx\ny\nz', 'a\nb\nc\nd\ne\nf\ng\nh\nX\nY\nz'));
check(
  '改动块与上下文交替分段',
  segments.map((segment) => segment.kind).join(',') === 'context,hunk,context',
);
check('改动块里装的是变化的那几行', segments[1].rows.length === 2);

const noChange = segmentDiff(diffLines('a\nb', 'a\nb'));
check('完全没改动时只有一段上下文', noChange.length === 1 && noChange[0].kind === 'context');

/* ---------- 行内词级差异（IDEA 那种高亮） ---------- */

const words = markWordChanges('scanf("%d", a);', 'scanf("%d", &a);');
check('两边文本拼回去与原文一致', words.left.map((p) => p.text).join('') === 'scanf("%d", a);');
check('右边的换行拼回去也对', words.right.map((p) => p.text).join('') === 'scanf("%d", &a);');
check('只标出新增的 & 这个符号', words.right.filter((p) => p.changed).map((p) => p.text).join('') === '&');
// 两边共有的 a); 还能对上，就不该标它——IDE 也是这么做的
check('共有的部分不标改动', words.left.every((p) => !p.changed));

const numberOnly = markWordChanges('int a = 1;', 'int a = 2;');
check('数字替换时两边各标一处', numberOnly.left.filter((p) => p.changed).map((p) => p.text).join('') === '1'
  && numberOnly.right.filter((p) => p.changed).map((p) => p.text).join('') === '2');


const sameWords = markWordChanges('int a = 1;', 'int a = 1;');
check('两行一样时没有词被标改动', sameWords.left.every((p) => !p.changed));

const numberChange = markWordChanges('scanf("%d", &n);', 'scanf("%d", &n + 1);');
check(
  '只追加内容时只标右边新增的一段',
  numberChange.right.filter((p) => p.changed).map((p) => p.text).join('') === ' + 1',
);

console.log('\ndiff 引擎校验通过');
