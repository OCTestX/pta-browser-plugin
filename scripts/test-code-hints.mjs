// 代码提示纯逻辑的单测：候选表、前缀过滤、按频率排序。
// 用法：node scripts/test-code-hints.mjs
import {
  CPP_KEYWORDS,
  C_KEYWORDS,
  completionsFor,
  constantEntries,
  filterCompletions,
  keywordSnippet,
  scopeNamesAt,
  sortByFrequency,
} from '../src/shared/code-hints.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 400)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const cList = completionsFor('c');
const cppList = completionsFor('cpp');

// ---- 1. C 的候选 ----
const printf = cList.find((item) => item.label === 'printf');
check('C 候选里有 printf', Boolean(printf));
check('printf 需要 stdio.h', printf?.header === 'stdio.h', printf?.header);
const intEntry = cList.find((item) => item.label === 'int');
check('C 候选里有 int 关键字', Boolean(intEntry));
check('关键字不需要头文件', intEntry?.header === null, intEntry?.header);
check('C 候选里有 sqrt 且属于 math.h', cList.find((item) => item.label === 'sqrt')?.header === 'math.h');
check('C 候选里没有重复名字',
  new Set(cList.map((item) => item.label)).size === cList.length,
  cList.length);

// ---- 2. C++ 的候选：关键字更多，还带 C 的标准库 ----
check('C++ 候选里有 vector 且属于 vector 头', cppList.find((item) => item.label === 'vector')?.header === 'vector');
check('C++ 候选里有 cin 且属于 iostream', cppList.find((item) => item.label === 'cin')?.header === 'iostream');
check('C++ 候选里有关键字 nullptr', cppList.some((item) => item.label === 'nullptr' && item.header === null));
check('C++ 候选里也带 C 的 printf', cppList.some((item) => item.label === 'printf'));
check('C++ 关键字比 C 多', CPP_KEYWORDS.length > C_KEYWORDS.length);
check('成员函数不给头文件（push_back 不该自动补错头）',
  (cppList.find((item) => item.label === 'push_back')?.header ?? null) === null);

// ---- 3. 其它语言不提示 ----
check('Python 没有候选', completionsFor('python').length === 0);
check('Java 没有候选', completionsFor('java').length === 0);
check('空语言没有候选', completionsFor('').length === 0);

// ---- 4. 前缀过滤 ----
const printed = filterCompletions(cList, 'prin');
check('prin 能筛出 printf', printed.some((item) => item.label === 'printf'));
check('prin 筛不出 scanf', !printed.some((item) => item.label === 'scanf'));
check('大小写不敏感', filterCompletions(cList, 'PRIN').some((item) => item.label === 'printf'));
check('整词已经打全的不再提示', filterCompletions(cList, 'printf').every((item) => item.label !== 'printf'));
check('空前缀不提示任何东西', filterCompletions(cList, '').length === 0);

// ---- 5. 按频率排序 ----
const items = [
  { label: 'alpha', header: null },
  { label: 'beta', header: null },
  { label: 'gamma', header: null },
];
const sorted = sortByFrequency(items, { gamma: 5, alpha: 5 });
check('高频的排前面', sorted[0].label === 'alpha' && sorted[1].label === 'gamma', sorted.map((i) => i.label));
check('同分按名字升序', sorted[2].label === 'beta', sorted.map((i) => i.label));
check('没有记录的排最后且顺序稳定',
  JSON.stringify(sortByFrequency(items, {}).map((i) => i.label)) === JSON.stringify(['alpha', 'beta', 'gamma']));
check('排序不改原数组', items[0].label === 'alpha');

// ---- 6. 常量表 ----
const constants = constantEntries();
check('常量表里有 INT_MAX', constants.some((item) => item.label === 'INT_MAX'));
check('INT_MAX 属于 limits.h', constants.find((item) => item.label === 'INT_MAX')?.header === 'limits.h');
check('常量表里有 NULL', constants.some((item) => item.label === 'NULL'));
check('同名常量只出现一次', new Set(constants.map((item) => item.label)).size === constants.length);
check('常量属于 constant 这一档', constants.every((item) => item.kind === 'constant'));

// ---- 7. 关键字模板（预制代码块）----
check('while 有结构模板', keywordSnippet('while')?.text.includes('while () {'), keywordSnippet('while'));
check('while 模板的光标落在条件括号里', keywordSnippet('while')?.caret === 7, keywordSnippet('while'));
check('int 这种关键字没有模板', keywordSnippet('int') === null);

// ---- 8. 作用域：只看当前位置能看见的名字 ----
const scoped = [
  '#define MAXN 100',
  'int fact(int n) {',
  '    int inner = 1;',
  '    {',
  '        int deep = 2;',
  '    }',
  '    return n * fact(n - 1);',
  '}',
  'int main(void) {',
  '    double tmp = 1.5;',
  '    const int limit = 10;',
  '    return 0;',
  '}',
].join('\n');
const inMain = scopeNamesAt(scoped, scoped.indexOf('return 0;')).map((item) => item.name);
check('作用域：main 里能看见自己的变量', inMain.includes('tmp'), inMain);
check('作用域：main 里能看见常量', inMain.includes('limit'), inMain);
check('作用域：main 里能看见宏', inMain.includes('MAXN'), inMain);
check('作用域：main 里能看见函数', inMain.includes('fact'), inMain);
check('作用域：main 里看不见别的函数的形参', !inMain.includes('n'), inMain);
check('作用域：main 里看不见别的函数的局部变量', !inMain.includes('inner'), inMain);
const inFact = scopeNamesAt(scoped, scoped.indexOf('return n * fact')).map((item) => item.name);
check('作用域：函数里能看见自己的形参', inFact.includes('n'), inFact);
check('作用域：函数里能看见自己的局部变量', inFact.includes('inner'), inFact);
check('作用域：函数里看不见 main 的变量', !inFact.includes('tmp'), inFact);
const inDeep = scopeNamesAt(scoped, scoped.indexOf('int deep') + 10).map((item) => item.name);
check('作用域：内层块里能看见外层的变量', inDeep.includes('inner'), inDeep);
check('作用域：内层块里能看见自己的变量', inDeep.includes('deep'), inDeep);
const atTop = scopeNamesAt(scoped, scoped.indexOf('int fact')).map((item) => item.name);
check('作用域：文件顶部看不见函数体里的变量', !atTop.includes('inner'), atTop);

console.log('\n全部通过');
