// 编辑器增强共享层的单测：格式化、彩虹括号、诊断解析、标准库注释表。
// 都是纯函数，Node 剥类型后能直接导入 .ts，不用先构建。
// 用法：node scripts/test-editor-assist.mjs
import { formatCode, formatSummary, stripLiteralsAndComments } from '../src/shared/code-format.ts';
import { bracketDepths, RAINBOW_COLORS } from '../src/shared/code-brackets.ts';
import { offsetOfPosition, parseClangDiagnostics } from '../src/shared/code-diagnostics.ts';
import { C_LIBRARY_DOCS, lookupCFunctionDoc } from '../src/shared/c-library-docs.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ── 格式化 ──────────────────────────────────────────────────────────────

// formatCode 刻意不拆行、也不加运算符空格（只动行首缩进/行尾空白/空行），
// 所以这里给的是已经断好行的输入：能钉住「按花括号重排缩进」这件事就够了，
// 顺带证明它没有偷偷改 token 内容（`int x=1;` 原样保留）。
const cFormatted = formatCode('void f() {\nint x=1;\n}\n', 'c');
check(
  'C 代码按花括号重排缩进，} 顶格',
  cFormatted === 'void f() {\n    int x=1;\n}',
  cFormatted,
);

// 字符串里的 `{` 不该被当成开括号，否则后面整段都会多缩一层
const stringBraces = formatCode('int main() {\nprintf("{");\nreturn 0;\n}\n', 'c');
const stringBracesLines = stringBraces.split('\n');
check(
  '字符串里的花括号不影响缩进',
  stringBracesLines[1] === '    printf("{");' && stringBracesLines[2] === '    return 0;',
  stringBraces,
);

// Python 的缩进是语义，只许把 Tab 换成 4 空格，层级不能动
const pythonFormatted = formatCode('def f():\n\tx = 1\n', 'python3');
check(
  'Python 只把 Tab 换成 4 空格，不改变缩进层级',
  pythonFormatted === 'def f():\n    x = 1',
  pythonFormatted,
);

const plainFormatted = formatCode('a  \n\n\n\nb  \n', 'unknownlang');
check(
  '不认识的语言只清行尾空白并把连续空行压成一行',
  plainFormatted === 'a\n\nb',
  plainFormatted,
);

const summaryChanged = formatSummary('a\nb', 'a\nc');
const summarySame = formatSummary('a', 'a');
check(
  'formatSummary 报告改动行数，无改动时如实说明',
  summaryChanged.includes('1') && summarySame.includes('没有改动'),
  { summaryChanged, summarySame },
);

// 剥离只做等长替换（用空格占位），否则括号下标就会错位
const stripped = stripLiteralsAndComments('printf("{");', false);
check(
  'stripLiteralsAndComments 等长替换，字符串里的 { 被剥掉',
  stripped.code.length === 'printf("{");'.length && !stripped.code.includes('{'),
  stripped,
);

// ── 彩虹括号 ────────────────────────────────────────────────────────────

const pairMarks = bracketDepths('f(1)');
check(
  '配对的一对括号同层同色',
  pairMarks.length === 2 &&
    pairMarks[0].at === 1 &&
    pairMarks[1].at === 3 &&
    pairMarks[0].depth === pairMarks[1].depth,
  pairMarks,
);

const nestedMarks = bracketDepths('{[()]}');
const nestedDepths = nestedMarks.map((mark) => mark.depth % RAINBOW_COLORS.length);
check(
  '混合嵌套按层数加深，闭括号回到配对的开括号层',
  nestedMarks.map((mark) => mark.at).join(',') === '0,1,2,3,4,5' &&
    nestedDepths.join(',') === '0,1,2,2,1,0',
  nestedMarks,
);

// 外层 printf 的圆括号是代码，必须算；字符串里的 `{`（下标 8）不能被算进去。
// 所以这里断言「恰好剩下两个真括号」，字符串占位后的那个位置没有任何标记。
const stringBraceMarks = bracketDepths('printf("{")');
check(
  '字符串里的括号不算（只剩 printf 自己的圆括号）',
  stringBraceMarks.map((mark) => mark.at).join(',') === '6,10',
  stringBraceMarks,
);

check(
  '块注释里的括号不算',
  bracketDepths('/* { */ int a;').length === 0,
  bracketDepths('/* { */ int a;'),
);

// 层数要取模，否则超过颜色表长度就越界了；第 7 个是第 7 层（下标 6）
const deepMarks = bracketDepths('{'.repeat(9));
const seventh = deepMarks[6];
check(
  '层数对颜色表取模，深层不会越界',
  deepMarks.length === 9 && seventh.depth >= 0 && seventh.depth < RAINBOW_COLORS.length,
  deepMarks,
);

// ── 诊断 ────────────────────────────────────────────────────────────────

// 真实形状：诊断行后面跟源码片段行和 ^ 指针行，只有首行能认
const clangOutput = [
  "pta1.c:3:14: error: expected ';' at end of declaration",
  '    3 |     int x = 5',
  '      |              ^',
  '1 error generated.',
].join('\n');
const parsed = parseClangDiagnostics(clangOutput);
check(
  'parseClangDiagnostics 只认首行，跳过源码片段与 ^ 指针',
  parsed.length === 1 &&
    parsed[0].line === 3 &&
    parsed[0].column === 14 &&
    parsed[0].severity === 'error' &&
    parsed[0].advice.includes('分号'),
  parsed,
);

check(
  '纯 ASCII 时字节列号等于字符列号',
  offsetOfPosition('int a;\nint b;', 2, 5) === 11,
  offsetOfPosition('int a;\nint b;', 2, 5),
);

// 逐字符算过字节偏移：
//   'int a; /*' 是 9 字节（字符下标 0..8），'中' 占 3 字节 → 9..11，
//   后面 '*' 12、'/' 13、' ' 14、'i' 15、'n' 16、't' 17、' ' 18、'b' 19。
// 所以第 20 个字节（1 基列号 20）落在 'b' 上；字符下标是 17，比字节列号小 2
// （「中」多算 2 字节 —— 3 字节但只占 1 个字符），这正是要换算的原因。
const chineseCode = 'int a; /*中*/ int b = ;';
check(
  '中文前置时按字节列号换算成字符下标',
  chineseCode[offsetOfPosition(chineseCode, 1, 20)] === 'b',
  offsetOfPosition(chineseCode, 1, 20),
);

check(
  '行号越界返回 -1',
  offsetOfPosition('a', 5, 1) === -1,
  offsetOfPosition('a', 5, 1),
);

// ── 标准库注释表 ────────────────────────────────────────────────────────

const printfDoc = lookupCFunctionDoc('printf');
check(
  'lookupCFunctionDoc 命中常用函数、查不到返回 null',
  Boolean(printfDoc?.signature) &&
    Boolean(printfDoc?.summary) &&
    lookupCFunctionDoc('notAFunction') === null,
  { printfDoc, missing: lookupCFunctionDoc('notAFunction') },
);

const incompleteDocs = Object.entries(C_LIBRARY_DOCS)
  .filter(([, doc]) => !doc.signature?.trim() || !doc.summary?.trim())
  .map(([name]) => name);
check('表里每一条都有非空 signature 和 summary', incompleteDocs.length === 0, incompleteDocs);

// 初学者最常问的就是这几个，缺一个就等于悬停提示当场失效
for (const name of [
  'printf', 'scanf', 'malloc', 'free', 'strlen', 'strcmp',
  'memcpy', 'memset', 'sqrt', 'pow', 'fabs', 'qsort',
]) {
  check(`标准库注释表包含 ${name}`, Boolean(C_LIBRARY_DOCS[name]), Object.keys(C_LIBRARY_DOCS).length);
}

console.log('\n编辑器增强的共享逻辑通过。');
