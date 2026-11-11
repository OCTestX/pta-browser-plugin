// 编辑器增强共享层的单测：格式化、彩虹括号、诊断解析、标准库注释表。
// 都是纯函数，Node 剥类型后能直接导入 .ts，不用先构建。
// 用法：node scripts/test-editor-assist.mjs
import { formatCode, formatSummary, stripLiteralsAndComments, wrapLongConditions } from '../src/shared/code-format.ts';
import { bracketDepths, RAINBOW_COLORS } from '../src/shared/code-brackets.ts';
import { offsetOfPosition, parseClangDiagnostics, isFragmentContextDiagnostic } from '../src/shared/code-diagnostics.ts';
import { C_LIBRARY_DOCS, lookupCFunctionDoc } from '../src/shared/c-library-docs.ts';
import { CPP_LIBRARY_DOCS } from '../src/shared/cpp-library-docs.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

// ── 格式化 ──────────────────────────────────────────────────────────────

// C：按花括号重排缩进 + 运算符两侧补空格
const cFormatted = formatCode('void f() {\nint x=1;\n}\n', 'c');
check(
  'C 代码按花括号重排缩进、运算符两侧补空格',
  cFormatted === 'void f() {\n    int x = 1;\n}',
  cFormatted,
);

// 用户报过的两个例子：无花括号的控制体要缩进一层；乘号两侧要空格
const ifBody = formatCode('if(n==1)\nreturn 1;', 'c');
check(
  '无花括号的 if 体缩进一层，== 两侧补空格',
  ifBody === 'if(n == 1)\n    return 1;',
  ifBody,
);
check(
  '乘号两侧补空格（7*2 → 7 * 2）',
  formatCode('7*2', 'c') === '7 * 2',
  formatCode('7*2', 'c'),
);

// 多条件过长时按顶层 && / || 拆行，`) {` 单独一行
check(
  '长 if 条件按 && 拆行并缩进',
  wrapLongConditions('if (a && b && c) {', 10) ===
    'if (a &&\n    b &&\n    c\n) {',
  wrapLongConditions('if (a && b && c) {', 10),
);
check(
  '嵌套条件组不拆开',
  wrapLongConditions('if (a && (b || c) && d) {', 10) ===
    'if (a &&\n    (b || c) &&\n    d\n) {',
  wrapLongConditions('if (a && (b || c) && d) {', 10),
);
check('短条件保持单行', wrapLongConditions('if (a && b) {', 100) === 'if (a && b) {');
const longCondition = formatCode(
  'if (conditionNumberOne && conditionNumberTwo && conditionNumberThree && conditionNumberFour && conditionNumberFive) {\n    doSomething();\n}',
  'c',
);
check(
  'formatCode 对长条件使用换行格式',
  longCondition.includes('if (conditionNumberOne &&\n') &&
    longCondition.includes('    conditionNumberTwo &&\n') &&
    longCondition.includes('    conditionNumberFive\n) {'),
  longCondition,
);
const longJavaCondition = formatCode(
  'if (conditionNumberOne && conditionNumberTwo && conditionNumberThree && conditionNumberFour && conditionNumberFive) {\n    doSomething();\n}',
  'java',
);
check(
  'Java 长条件同样换行',
  longJavaCondition.includes('    conditionNumberTwo &&\n') && longJavaCondition.includes('\n) {'),
  longJavaCondition,
);

// 声明符 / 解引用 / 自增不能被当成乘法，否则 `int *p` 会变成 `int * p`
const pointers = formatCode('int *p=&a;\nint b=*p;\nx++;\ny=a*-b;', 'c');
check(
  '声明符与一元运算符不被当成二元运算符',
  pointers === 'int *p = &a;\nint b = *p;\nx++;\ny = a * -b;',
  pointers,
);

// 字符串和注释里的内容一个字都不能动
const literalSafe = formatCode('char *s="a+b=c";  // it\'s 1+2\nint n=1+2;', 'c');
check(
  '字符串与注释内容原样保留',
  literalSafe.split('\n')[0] === 'char *s = "a+b=c"; // it\'s 1+2'
    && literalSafe.split('\n')[1] === 'int n = 1 + 2;',
  literalSafe,
);

// 块注释的分隔符必须留在 token 里：漏掉 `/*` 时 `/* x */` 会被整理成 ` x */`，注释就没了
const blockCommentLine = formatCode('/* x */\nint a=1;', 'c');
check(
  '单行块注释保留 /* 与 */ 分隔符',
  blockCommentLine === '/* x */\nint a = 1;',
  blockCommentLine,
);
const blockCommentTail = formatCode('int a=1; /* x */', 'c');
check(
  '行尾块注释保留分隔符',
  blockCommentTail === 'int a = 1; /* x */',
  blockCommentTail,
);
const blockCommentMulti = formatCode('/* a\n b */\nint a=1;', 'c');
check(
  '多行块注释首尾分隔符都在',
  blockCommentMulti.startsWith('/*')
    && blockCommentMulti.includes('*/')
    && blockCommentMulti.split('\n').pop() === 'int a = 1;',
  blockCommentMulti,
);
const lineCommentOnly = formatCode('int a=1; // x', 'c');
check(
  '// 行注释内容不受影响',
  lineCommentOnly === 'int a = 1; // x',
  lineCommentOnly,
);

// C++ 走 brace 策略（只重排缩进、不动空格），块注释同样要原样保留
const cppComments = formatCode('/* x */\nint a=1; /* y */', 'cpp');
check(
  'C++ 整理保留块注释分隔符',
  cppComments === '/* x */\nint a=1; /* y */',
  cppComments,
);

// 幂等：按两下按钮不能让它一直变
const once = formatCode('int main(){int a=1;\nif(a>0){\nreturn a;}\nreturn 0;}', 'c');
check('整理是幂等的', once === formatCode(once, 'c'), { once, again: formatCode(once, 'c') });

// 预处理指令顶格，且行里的 `<` `>` 不能被当成比较运算符
const preprocessor = formatCode('#include<stdio.h>\nint main() {\nreturn 0;\n}', 'c');
check(
  '预处理指令顶格且原样保留',
  preprocessor.split('\n')[0] === '#include<stdio.h>',
  preprocessor,
);

// 字符串里的 `{` 不该被当成开括号，否则后面整段都会多缩一层
const stringBraces = formatCode('int main() {\nprintf("{");\nreturn 0;\n}\n', 'c');
const stringBracesLines = stringBraces.split('\n');
check(
  '字符串里的花括号不影响缩进',
  stringBracesLines[1] === '    printf("{");' && stringBracesLines[2] === '    return 0;',
  stringBraces,
);

// Python：缩进是语义，只规范运算符空格（Tab 统一成 4 空格）
const pythonFormatted = formatCode('def f(a,b):\n\tx=a+b\n\treturn x\n', 'python3');
check(
  'Python 只规范运算符空格，缩进层级不动',
  pythonFormatted === 'def f(a, b):\n    x = a + b\n    return x',
  pythonFormatted,
);

// Java：以前落在 brace（只重排缩进，不补运算符空格），现在有独立策略；
// 泛型尖括号必须先被判成泛型，否则 `List<String>` 会被拆成 `List < String >`
const javaBasic = formatCode(
  'class A{\npublic static void main(String[] args){\nint a=1+2;\nSystem.out.println(a);\n}\n}',
  'java',
);
check(
  'Java 按花括号重排缩进并补运算符空格',
  javaBasic === 'class A {\n    public static void main(String[] args) {\n        int a = 1 + 2;\n        System.out.println(a);\n    }\n}',
  javaBasic,
);
check('Java 整理是幂等的', javaBasic === formatCode(javaBasic, 'java'), formatCode(javaBasic, 'java'));

const javaGenerics = formatCode(
  'List<String> a=new ArrayList<>();\nMap<String,Integer> m=new HashMap<>();\nList<Map<String,Integer>> nested=null;',
  'java',
);
check(
  'Java 泛型尖括号不被拆成比较运算符',
  javaGenerics === 'List<String> a = new ArrayList<>();\nMap<String, Integer> m = new HashMap<>();\nList<Map<String, Integer>> nested = null;',
  javaGenerics,
);

const javaWildcards = formatCode('List<? extends Number> xs=null;\nMap<?,?> m=new HashMap<>();', 'java');
check(
  'Java 通配符泛型不被拆开',
  javaWildcards === 'List<? extends Number> xs = null;\nMap<?, ?> m = new HashMap<>();',
  javaWildcards,
);

// 文本块的缩进属于字符串内容，宁可整份不整理也不能改里面的空格
const javaTextBlock = 'class A{\nString s="""\n  hi\n""";\n}';
check(
  'Java 文本块原样保留',
  formatCode(javaTextBlock, 'java') === javaTextBlock,
  formatCode(javaTextBlock, 'java'),
);

const javaCompare = formatCode('if(a<b){\nreturn 1;\n}', 'java');
check(
  'Java 比较运算符两侧补空格、if 后留空格',
  javaCompare === 'if (a < b) {\n    return 1;\n}',
  javaCompare,
);

const javaForEach = formatCode('for(String s:list){\nSystem.out.println(s);\n}', 'java');
check(
  'Java for-each 的冒号两侧补空格',
  javaForEach === 'for (String s : list) {\n    System.out.println(s);\n}',
  javaForEach,
);

const javaComments = formatCode('int a=1; /* x */\n// note\nint b=2;', 'java');
check(
  'Java 整理保留块注释与行注释',
  javaComments === 'int a = 1; /* x */\n// note\nint b = 2;',
  javaComments,
);

const javaImports = formatCode('import java.util.*;\nimport java.util.List;\nclass A{}', 'java');
check(
  'Java 不动 import 行',
  javaImports.split('\n').slice(0, 2).join('|') === 'import java.util.*;|import java.util.List;',
  javaImports,
);

// 泛型方法声明的 `<` 前面是修饰符（不是类型名），也得认出来，否则会变成 `< T extends … >`
const javaGenericMethod = formatCode(
  'public static <T extends Comparable<T>> T max(T a,T b){return a.compareTo(b)>0?a:b;}',
  'java',
);
check(
  'Java 泛型方法声明的尖括号不被拆开',
  javaGenericMethod.includes('<T extends Comparable<T>> T max(T a, T b)'),
  javaGenericMethod,
);

// 接口默认方法以 default 开头，不能被当成 switch 的 default 标签少缩一层
const javaDefaultMethod = formatCode(
  'interface Shape{\ndefault void print(){\nSystem.out.println("s");\n}\n}',
  'java',
);
check(
  'Java 接口 default 方法按方法缩进',
  javaDefaultMethod === 'interface Shape {\n    default void print() {\n        System.out.println("s");\n    }\n}',
  javaDefaultMethod,
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

// clang 22 对缺头文件的真实措辞是「undeclared library function ... implicit function
// declarations [-Wimplicit-function-declaration]」，和 GCC 的 "implicit declaration of
// function" 不是一个词序，所以建议表里两种都得有，否则只会落到兜底那句空话
const undeclared = parseClangDiagnostics(
  "check.c:3:9: error: call to undeclared library function 'printf' with type 'int (const char *, ...)'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]",
);
check(
  '缺头文件的报错给出「检查 #include」的建议',
  undeclared.length === 1 && undeclared[0].advice.includes('#include'),
  undeclared,
);

// 代码填空片段（type/6）依赖题面/裁判提供的类型、常量、宏；独立编译的「未声明」
// 是假报错，不能画红波浪线。真正的语法错误仍要保留。
check(
  '片段模式识别缺题面上下文的语义错误',
  isFragmentContextDiagnostic("unknown type name 'ArrNode'") &&
    isFragmentContextDiagnostic("use of undeclared identifier 'kMaxSize'") &&
    isFragmentContextDiagnostic("no member named 'data_' in 'ArrNode'"),
);
check(
  '片段模式不放过真正的语法错误',
  !isFragmentContextDiagnostic("expected ';' after expression") &&
    !isFragmentContextDiagnostic('invalid operands to binary expression'),
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

// C++ 标准库常用名字：悬停时查的是同一张表（background 合并后一起下发）
const incompleteCpp = Object.entries(CPP_LIBRARY_DOCS)
  .filter(([, doc]) => !doc.signature?.trim() || !doc.summary?.trim())
  .map(([name]) => name);
check('C++ 注释表每一条都有非空 signature 和 summary', incompleteCpp.length === 0, incompleteCpp);
for (const name of ['vector', 'string', 'sort', 'map', 'priority_queue', 'push_back', 'cin', 'cout']) {
  check(`C++ 注释表包含 ${name}`, Boolean(CPP_LIBRARY_DOCS[name]), Object.keys(CPP_LIBRARY_DOCS).length);
}

console.log('\n编辑器增强的共享逻辑通过。');
