/**
 * 把 clang 的编译诊断解析成结构化错误，并给出中文修改建议。
 *
 * 内置编译器（Clang 22）输出的诊断长这样：
 *
 *   pta1.c:3:14: error: expected ';' at end of declaration
 *       3 |     int x = 5
 *         |              ^
 *
 * 页面上要画红色波浪号，就得知道「第几行第几列」。这里把那段文本解析成
 * {line, column, severity, message}，行号列号都按 clang 的习惯从 1 开始。
 *
 * 「中文修改建议」是给初学者看的：同一个 clang 报错，英文对新手不太友好，
 * 这里按报错关键词给一句能照着改的中文提示。
 */

/** 一条编译诊断 */
export interface CodeDiagnostic {
  /** 行号，从 1 开始（跟 clang 一致） */
  line: number;
  /** 列号，从 1 开始（跟 clang 一致） */
  column: number;
  severity: 'error' | 'warning' | 'note';
  /** clang 原文 */
  message: string;
  /** 给初学者的中文修改建议 */
  advice: string;
}

/** clang 诊断行的形状：文件名:行:列: 级别: 正文 */
const DIAGNOSTIC_LINE = /^(.+?):(\d+):(\d+):\s*(error|warning|note):\s*(.*)$/;

/**
 * 常见报错的修改建议。
 *
 * 关键词是「小写化后的 clang 原文里包含的片段」，命中第一条就用它的建议。
 * 顺序有讲究：更具体的写法排在前面，避免被宽泛的规则先命中。
 */
const ADVICE_RULES: ReadonlyArray<{ readonly match: string; readonly advice: string }> = [
  { match: "expected ';'", advice: '这一行末尾少了分号，检查上一行是不是漏了 ;' },
  { match: "expected '}'", advice: '大括号没配对，数一下左右各有多少个 {' },
  { match: "expected ')'", advice: '括号没配对，检查函数调用的参数和括号是否都写全了' },
  { match: 'expected expression', advice: '等号右边缺了表达式，看看是不是只写了等号' },
  { match: 'expected unqualified-id', advice: '这里需要一个变量名或类型名' },
  { match: 'use of undeclared identifier', advice: '用了没有声明的变量：检查拼写，或者在使用前先定义它' },
  { match: 'unknown type name', advice: '类型不认识：检查头文件（#include）是否包含、类型名是否拼错' },
  { match: 'implicit declaration of function', advice: '函数没有声明：多半是漏了对应的 #include' },
  { match: 'control reaches end of non-void function', advice: '函数声明了返回值类型，却没有 return' },
  { match: 'too few arguments to function call', advice: '调用这个函数时给的参数少了' },
  { match: 'too many arguments to function call', advice: '调用这个函数时给的参数多了' },
  { match: 'invalid operands to binary expression', advice: '运算符两边的类型对不上，先确认变量的类型' },
  { match: 'subscripted value is not an array', advice: '给非数组的东西用了下标' },
  { match: 'called object type', advice: '把一个变量当函数调用了' },
  { match: 'no member named', advice: '结构体里没有这个成员，检查成员名和结构体类型' },
  { match: 'assignment to const-qualified variable', advice: '不能给 const 变量赋值' },
  { match: 'unused variable', advice: '这个变量声明了却没用过，可以删掉或者用上它' },
  { match: 'variable', advice: '这个变量有问题：检查拼写和使用前是否已经赋值' },
  { match: 'break statement not in loop', advice: 'break 只能写在循环或 switch 里' },
  { match: 'duplicate case value', advice: 'switch 里有两个一样的 case' },
  { match: 'redefinition of', advice: '同一个名字定义了两次，删掉多余的那一个' },
  { match: 'return', advice: 'return 的用法有问题：检查返回值类型和 return 的值是否一致' },
  { match: 'invalid conversion', advice: '类型转换不合法，先确认赋值的类型' },
  { match: 'array subscript is not an integer', advice: '数组下标必须是整数' },
  { match: 'expected primary-expression', advice: '这里应该是一个值（变量、数字或函数调用）' },
  { match: 'stray', advice: '代码里有无法识别的字符，检查是不是输入法打错了' },
];

/** 没匹配到具体规则时的兜底建议 */
const DEFAULT_ADVICE = '按报错给出的行号列号找到那一处，对照上面的英文说明检查';

/**
 * 给一条 clang 报错配一句中文修改建议。
 *
 * 单独抽出来是因为页面上画波浪号和写建议是两条线：前者要位置，后者要内容。
 */
export function adviceForMessage(message: string): string {
  const lower = message.toLowerCase();
  for (const rule of ADVICE_RULES) {
    if (lower.includes(rule.match)) return rule.advice;
  }
  return DEFAULT_ADVICE;
}

/**
 * 解析 clang 的诊断输出，取出每一条 error / warning。
 *
 * 只认「文件名:行:列: 级别: 正文」这种行；诊断附带的源码片段（`3 | ...`）
 * 和指向符（`^`）会自然被过滤掉。
 */
export function parseClangDiagnostics(output: string): CodeDiagnostic[] {
  const diagnostics: CodeDiagnostic[] = [];
  for (const line of String(output ?? '').split('\n')) {
    const match = DIAGNOSTIC_LINE.exec(line.trim());
    if (!match) continue;
    const message = match[5].trim();
    if (!message) continue;
    diagnostics.push({
      line: Number(match[2]),
      column: Number(match[3]),
      severity: match[4] as CodeDiagnostic['severity'],
      message,
      advice: adviceForMessage(message),
    });
  }
  return diagnostics;
}

/**
 * 把「第几行第几列」换算成代码里的字符下标（行号越界返回 -1）。
 *
 * clang 的列号从 1 开始，而且按 UTF-8 **字节**算：一行里前面有一个汉字，
 * 后面所有列都会比字符下标多 2（汉字占 3 字节、只算 1 个字符）。
 * 直接拿列号当字符下标用，含中文的注释或字符串后面的报错就会指偏，
 * 所以这里先按字节切到列位置，再把切出来的字节解码回字符数。
 *
 * 行列对不上（列号超出本行）时退回到行尾，至少波浪线还画在同一行。
 */
export function offsetOfPosition(text: string, line: number, column: number): number {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (line < 1 || line > lines.length) return -1;
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += lines[index].length + 1;

  const lineText = lines[line - 1];
  // 字节 → 字符：clang 的列号是字节偏移，编辑器里的下标按 UTF-16 码元数
  const encoder = new TextEncoder();
  const bytes = encoder.encode(lineText);
  const clamped = Math.min(Math.max(column - 1, 0), bytes.length);
  const characterIndex = new TextDecoder().decode(bytes.subarray(0, clamped)).length;
  return offset + characterIndex;
}
