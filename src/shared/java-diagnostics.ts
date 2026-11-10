/**
 * Java 的规则检查（纯函数，Node 里可以直接单测）。
 *
 * 插件不打包 Java 编译器（几百 MB，而且 PTA 的 Java 题本来就在服务端编译），
 * 所以这里只挑「不用理解类型、看字面就能确定」的语法问题：
 *   · 花括号 / 圆括号 / 方括号不配对
 *   · 字符串、字符常量没有闭合
 *   · return 语句和声明赋值行末尾少了分号
 *   · if / for / while 后面缺括号
 *
 * 判断前先把字符串、字符常量、注释抹成空格（长度不变），所以
 *   · 字符串和注释里的 `{}()` 不会被当成代码结构；
 *   · 诊断的 from/to 仍然是原文下标，页面可以直接拿去画波浪线。
 *
 * 规则刻意保守：只报「一眼就能确定」的问题，宁可漏报（比如跨行表达式的续行），
 * 也不要在用户写得没问题的代码上乱画红线。
 */

import type { DiagnosticBox } from './editor-assist-protocol.ts';

interface ScanState {
  /** 还停在跨行块注释里 */
  inBlockComment: boolean;
  /** 文本块（"""）开始处的绝对下标；null 表示不在文本块里 */
  textBlockStart: number | null;
}

interface ScannedLine {
  /** 抹掉字符串 / 字符常量 / 注释后的代码（长度与原文一致） */
  code: string;
  /** 只抹掉注释、保留字符串内容：判断行尾分号时用 */
  commentless: string;
  /** 这一行有没闭合的字符串 / 字符常量：有的话不再做语句级判断，免得重复报 */
  brokenLiteral: boolean;
  /** 这一行处在多行文本块里：内容不是代码，不做语句级判断 */
  inTextBlock: boolean;
}

interface StatementLine {
  /** 只抹掉注释的原文 */
  text: string;
  /** 这一行第一个字符的绝对下标 */
  start: number;
  /** 可以做「缺分号」判断 */
  usable: boolean;
}

/** 三种开括号：静态字面量查表，不用 Set */
const IS_OPEN_BRACKET: Readonly<Record<string, true>> = { '{': true, '(': true, '[': true };

const CLOSE_OF: Readonly<Record<string, string>> = { '{': '}', '(': ')', '[': ']' };

const OPEN_OF: Readonly<Record<string, string>> = { '}': '{', ')': '(', ']': '[' };

/** 行尾这些符号说明表达式还没写完（跨行续写），不能报「缺分号」 */
const CONTINUES_RE = /[+\-*/%=&|?:,.<(]$/;

/** 下一行以这些符号开头，说明上一行是跨行表达式的一部分 */
const CONTINUATION_START_RE = /^\s*[+\-*/%.?:)&|(\[{]/;

/**
 * 抹掉一行里的字符串、字符常量和注释。
 *
 * 两种视图（`code` 全抹、`commentless` 只抹注释）都保持长度不变，
 * 这样剥完之后的字符下标仍然能直接定位原文。
 */
function scanLine(raw: string, state: ScanState, lineStart: number, broken: DiagnosticBox[]): ScannedLine {
  let code = '';
  let commentless = '';
  let i = 0;
  let brokenLiteral = false;
  const textBlockAtStart = state.textBlockStart !== null;

  while (i < raw.length) {
    // 文本块（Java 15+ 的 """..."""）：里面全是内容，整段抹掉
    if (state.textBlockStart !== null) {
      const end = raw.indexOf('"""', i);
      if (end < 0) {
        code += ' '.repeat(raw.length - i);
        commentless += raw.slice(i);
        i = raw.length;
        break;
      }
      code += ' '.repeat(end + 3 - i);
      commentless += raw.slice(i, end + 3);
      i = end + 3;
      state.textBlockStart = null;
      continue;
    }

    if (state.inBlockComment) {
      const end = raw.indexOf('*/', i);
      if (end < 0) {
        code += ' '.repeat(raw.length - i);
        commentless += ' '.repeat(raw.length - i);
        i = raw.length;
        break;
      }
      code += ' '.repeat(end + 2 - i);
      commentless += ' '.repeat(end + 2 - i);
      i = end + 2;
      state.inBlockComment = false;
      continue;
    }

    const ch = raw[i];

    if (ch === '/' && raw[i + 1] === '/') {
      code += ' '.repeat(raw.length - i);
      commentless += ' '.repeat(raw.length - i);
      i = raw.length;
      break;
    }

    if (ch === '/' && raw[i + 1] === '*') {
      state.inBlockComment = true;
      code += '  ';
      commentless += '  ';
      i += 2;
      continue;
    }

    if (ch === '"' && raw.startsWith('"""', i)) {
      state.textBlockStart = lineStart + i;
      code += '   ';
      commentless += '"""';
      i += 3;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      const at = lineStart + i;
      code += ' ';
      commentless += quote;
      i += 1;
      let closed = false;
      while (i < raw.length) {
        const cur = raw[i];
        // 转义序列是两个字符：一起抹掉，长度才不会错位
        if (cur === '\\') {
          const take = Math.min(2, raw.length - i);
          code += ' '.repeat(take);
          commentless += raw.slice(i, i + take);
          i += take;
          continue;
        }
        code += ' ';
        commentless += cur;
        i += 1;
        if (cur === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        brokenLiteral = true;
        broken.push({
          from: at,
          to: Math.max(at + 1, lineStart + raw.length),
          severity: 'error',
          message: quote === '"' ? '字符串没有闭合' : '字符常量没有闭合',
          advice: quote === '"' ? '补上结尾的双引号 "' : "补上结尾的单引号 '",
        });
      }
      continue;
    }

    code += ch;
    commentless += ch;
    i += 1;
  }

  return {
    code,
    commentless,
    brokenLiteral,
    inTextBlock: textBlockAtStart || state.textBlockStart !== null,
  };
}

/** 括号配对：字符串和注释里的括号已经被抹掉，剩下的都是代码结构 */
function bracketDiagnostics(code: string): DiagnosticBox[] {
  const diagnostics: DiagnosticBox[] = [];
  const stack: { char: string; at: number }[] = [];

  for (let index = 0; index < code.length; index += 1) {
    const ch = code[index];
    if (IS_OPEN_BRACKET[ch]) {
      stack.push({ char: ch, at: index });
      continue;
    }
    const wanted = OPEN_OF[ch];
    if (!wanted) continue;

    const top = stack[stack.length - 1];
    if (!top) {
      diagnostics.push({
        from: index,
        to: index + 1,
        severity: 'error',
        message: `多余的 '${ch}'：前面没有对应的 '${wanted}'`,
        advice: `删掉这个 '${ch}'，或者在前面补上 '${wanted}'`,
      });
      continue;
    }
    if (top.char !== wanted) {
      // 当前闭括号在栈里更深处有没有同类型的开括号？
      let matchIndex = -1;
      for (let deeper = stack.length - 1; deeper >= 0; deeper -= 1) {
        if (stack[deeper].char === wanted) {
          matchIndex = deeper;
          break;
        }
      }
      if (matchIndex >= 0) {
        // 常见笔误：`if (x > 0 {` 少了右括号就写了 `{`。
        // 把中间这些没闭合的开括号逐个报出来，再让当前闭括号配到它该配的那个。
        for (let deeper = stack.length - 1; deeper > matchIndex; deeper -= 1) {
          const open = stack[deeper];
          diagnostics.push({
            from: open.at,
            to: open.at + 1,
            severity: 'error',
            message: `缺少与 '${open.char}' 配对的 '${CLOSE_OF[open.char]}'`,
            advice: `在这里后面补上 '${CLOSE_OF[open.char]}'，或者删掉多余的 '${open.char}'`,
          });
        }
        stack.length = matchIndex;
        continue;
      }
      // 栈里根本没有它的开括号：这个闭括号是多的。吃掉栈顶，避免后面连环报
      stack.pop();
      diagnostics.push({
        from: index,
        to: index + 1,
        severity: 'error',
        message: `括号不配对：这里的 '${ch}' 与前面的 '${top.char}' 对不上`,
        advice: `'${top.char}' 要用 '${CLOSE_OF[top.char]}' 收尾，检查这一对括号`,
      });
      continue;
    }
    stack.pop();
  }

  for (const item of stack) {
    const close = CLOSE_OF[item.char];
    diagnostics.push({
      from: item.at,
      to: item.at + 1,
      severity: 'error',
      message: `缺少与 '${item.char}' 配对的 '${close}'`,
      advice: `在这里后面补上 '${close}'，或者删掉多余的 '${item.char}'`,
    });
  }
  return diagnostics;
}

/** if / for / while 后面必须是括号（条件可以换行写，所以跨行找下一个非空白字符） */
function keywordParenDiagnostics(code: string): DiagnosticBox[] {
  const diagnostics: DiagnosticBox[] = [];
  const pattern = /\b(if|for|while)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    let index = match.index + match[0].length;
    while (index < code.length && /\s/.test(code[index])) index += 1;
    if (code[index] === '(') continue;
    diagnostics.push({
      from: match.index,
      to: match.index + match[0].length,
      severity: 'error',
      message: `${match[0]} 后面缺少括号`,
      advice: `条件要写在括号里，例如 ${match[0]} (条件) { ... }`,
    });
  }
  return diagnostics;
}

/** 声明赋值行的形状：修饰符* + 类型 + 变量名 + =（`int value = 5`、`List<Integer> list = ...`） */
const DECLARATION_ASSIGN_RE = new RegExp(
  '^(?:(?:public|protected|private|static|final|transient|volatile|abstract|synchronized|native|strictfp|default)\\s+)*'
  + '(?:[A-Za-z_$][\\w$]*(?:\\s*<[^;{}()]*>)?(?:\\s*\\[\\s*\\])*)\\s+'
  + '[A-Za-z_$][\\w$]*(?:\\s*\\[\\s*\\])*\\s*=(?!=)',
);

/**
 * 明显缺分号的两类行：
 *   · `return 表达式`（行尾不是分号 / 也不像跨行续写）
 *   · 声明赋值（`int value = 5`、`String s = "abc"` 等）
 *
 * 跨行表达式（行尾是运算符、下一行以 . 或 + 开头）一律放过：
 * Java 里换行只是空白，硬报会把正常代码画红。
 */
function semicolonDiagnostics(lines: StatementLine[]): DiagnosticBox[] {
  const diagnostics: DiagnosticBox[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.usable) continue;

    const trimmedEnd = line.text.replace(/\s+$/, '');
    const content = trimmedEnd.trimStart();
    if (!content) continue;
    if (/[;{},]$/.test(trimmedEnd)) continue;
    if (CONTINUES_RE.test(trimmedEnd)) continue;

    const next = lines.slice(index + 1).find((item) => item.text.trim() !== '');
    if (next && CONTINUATION_START_RE.test(next.text)) continue;

    // return 语句：单独一个 return 多半是还没写完，先不报
    if (/^\s*return\b/.test(trimmedEnd)) {
      if (!/\breturn\b\s+\S/.test(trimmedEnd)) continue;
      const leading = trimmedEnd.length - content.length;
      diagnostics.push({
        from: line.start + leading,
        to: line.start + trimmedEnd.length,
        severity: 'error',
        message: 'return 语句末尾少了分号',
        advice: '在 return 的表达式后面补上分号 ;',
      });
      continue;
    }

    // 控制语句 / 注解行不按声明赋值判断
    if (/^(if|for|while|switch|catch|synchronized|do|else|try|case|default)\b/.test(content)) continue;
    if (content.startsWith('@')) continue;

    // 声明赋值：修饰符* + 类型 + 变量名 + =
    if (!DECLARATION_ASSIGN_RE.test(content)) continue;
    // 等号右边只有空白（`int x =`）时也放过：半行代码更可能是还没写完
    if (/=\s*$/.test(trimmedEnd)) continue;

    diagnostics.push({
      from: line.start + (trimmedEnd.length - content.length),
      to: line.start + trimmedEnd.length,
      severity: 'error',
      message: '这一行声明赋值末尾少了分号',
      advice: '在语句末尾补上分号 ;',
    });
  }

  return diagnostics;
}

/**
 * Java 的规则检查：返回可以直接画到编辑器上的诊断（from/to/severity/message/advice）。
 *
 * 不做类型检查、不做语义分析，只覆盖「标点层面」的明显错误。
 */
export function checkJava(code: string): DiagnosticBox[] {
  // 不归一化换行：from/to 要能直接切原文，CRLF 时也不会偏一列
  const source = String(code ?? '');
  if (source.trim() === '') return [];

  const diagnostics: DiagnosticBox[] = [];
  const state: ScanState = { inBlockComment: false, textBlockStart: null };
  const codeLines: string[] = [];
  const statementLines: StatementLine[] = [];
  let lineStart = 0;

  for (const raw of source.split('\n')) {
    const scanned = scanLine(raw, state, lineStart, diagnostics);
    codeLines.push(scanned.code);
    statementLines.push({
      text: scanned.commentless,
      start: lineStart,
      usable: !scanned.brokenLiteral && !scanned.inTextBlock,
    });
    lineStart += raw.length + 1;
  }

  if (state.textBlockStart !== null) {
    diagnostics.push({
      from: state.textBlockStart,
      to: Math.min(state.textBlockStart + 3, source.length),
      severity: 'error',
      message: '三引号字符串没有闭合',
      advice: '补上结尾的 """（Java 文本块必须用三引号收尾）',
    });
  }

  const strippedCode = codeLines.join('\n');
  diagnostics.push(...bracketDiagnostics(strippedCode));
  diagnostics.push(...keywordParenDiagnostics(strippedCode));
  diagnostics.push(...semicolonDiagnostics(statementLines));

  // 诊断按出现位置排好，页面从上往下画波浪线时不用再排
  return diagnostics.sort((a, b) => a.from - b.from);
}
