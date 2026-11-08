/**
 * 「整理代码」按钮背后的格式化逻辑（纯函数，Node 里可以直接单测）。
 *
 * 目标不是「clang-format 那种完美重排」，而是**安全**：
 * 用户交的是 PTA 作答区的代码，改坏了就是白写。所以这里的规则刻意保守：
 *   · 一定不改任何 token 的内容（字符串、注释里的字面量原样保留）；
 *   · 一定不改语义结构（不挪动代码、不合并行、不加删括号）；
 *   · 只动「行首缩进、行尾空白、空行」。
 *
 * 按语言分两种策略：
 *   · 大括号系（C/C++/Java/JS…）：按花括号深度重算缩进（每层 4 个空格）。
 *     字符串/字符/注释里的花括号不算数，所以 `printf("{")` 不会把缩进带歪。
 *   · 缩进敏感系（Python）：**不重排缩进**（那是语义），只做行尾空白与空行清理，
 *     并且仅当整个文件统一用 Tab 缩进时才把 Tab 换成 4 空格（混用 Tab/空格在
 *     Python 里本身就不合法，统一成空格反而更安全）。
 */

/** 缩进用几个空格 */
export const INDENT_WIDTH = 4;

/** 语言归类：决定用哪套缩进策略 */
export type CodeStyle = 'brace' | 'indent' | 'plain';

export function codeStyleFor(language: string): CodeStyle {
  const lang = (language ?? '').toLowerCase();
  if (/python/.test(lang)) return 'indent';
  if (/^(c|cpp|c\+\+|java|js|javascript|golang|go|rust|php|swift|kotlin|cs|c#|scala|dart|ts|typescript)\b/.test(lang)) {
    return 'brace';
  }
  return 'plain';
}

/** 行内的字符串/字符/注释剥掉之后剩下的「纯代码」，用来数花括号 */
interface StrippedLine {
  /** 剥掉字符串与注释后的代码 */
  code: string;
  /** 这行结束时是否还停在块注释里 */
  inBlockComment: boolean;
}

/**
 * 剥掉一行里的字符串、字符常量和注释。
 *
 * 剥掉的部分**用空格占位、长度不变**，这样剥完之后同一行里的下标仍然对得上
 * 原文（彩虹括号要拿这些下标去 CodeMirror 里定位 DOM）。
 *
 * 字符串内容也必须抹成空格：`printf("{")` 里的那个 `{` 不是代码结构，
 * 留着它会让缩进和括号层数一起算歪。
 */
export function stripLiteralsAndComments(line: string, inBlockComment: boolean): StrippedLine {
  let out = '';
  let index = 0;
  let block = inBlockComment;
  while (index < line.length) {
    if (block) {
      const end = line.indexOf('*/', index);
      if (end < 0) {
        out += ' '.repeat(line.length - index);
        index = line.length;
        break;
      }
      out += ' '.repeat(end + 2 - index);
      index = end + 2;
      block = false;
      continue;
    }
    const ch = line[index];
    if (ch === '/' && line[index + 1] === '*') {
      block = true;
      out += '  ';
      index += 2;
      continue;
    }
    if (ch === '/' && line[index + 1] === '/') {
      out += ' '.repeat(line.length - index);
      index = line.length;
      break;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ' ';
      index += 1;
      while (index < line.length) {
        const cur = line[index];
        // 转义序列是两个字符，一起吃掉、一起补空格，长度才不会错位
        if (cur === '\\') {
          const take = Math.min(2, line.length - index);
          out += ' '.repeat(take);
          index += take;
          continue;
        }
        out += ' ';
        index += 1;
        if (cur === quote) break;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return { code: out, inBlockComment: block };
}

/**
 * 大括号系的重新缩进。
 *
 * 规则：
 *   · 缩进 = 花括号深度 + （圆括号没闭合时多一层）
 *   · 以 } 开头的行按「收尾后」的深度算
 *   · case/default 标签少一层
 *   · 预处理指令顶格；反斜杠续行保持顶格
 */
export function reindentByBraces(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let depth = 0;
  let paren = 0;
  let inBlock = false;
  let inPreprocessor = false;

  for (const raw of lines) {
    const stripped = stripLiteralsAndComments(raw, inBlock);
    const codeOnly = stripped.code;
    inBlock = stripped.inBlockComment;

    const trimmed = raw.trim();
    if (trimmed === '') {
      out.push('');
      continue;
    }

    // 预处理指令（#include / #define …）必须顶格，反斜杠续行也保持顶格
    const preprocessor = /^\s*#/.test(raw) || inPreprocessor;
    inPreprocessor = /\\\s*$/.test(raw);

    let indent = depth;
    if (paren > 0) indent += 1;
    // 以 } 开头的行是收尾花括号，case/default 标签按惯例比块内语句少一层
    if (/^\s*\}/.test(codeOnly)) indent -= 1;
    if (/^\s*(case\b|default\b)/.test(codeOnly)) indent -= 1;
    if (indent < 0) indent = 0;

    if (preprocessor) {
      out.push(raw.replace(/[ \t]+$/, ''));
    } else {
      const body = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      out.push(' '.repeat(indent * INDENT_WIDTH) + body);
    }

    let roundDelta = 0;
    let curlyDelta = 0;
    for (const ch of codeOnly) {
      if (ch === '(' || ch === '[') roundDelta += 1;
      else if (ch === ')' || ch === ']') roundDelta -= 1;
      else if (ch === '{') curlyDelta += 1;
      else if (ch === '}') curlyDelta -= 1;
    }
    paren = Math.max(0, paren + roundDelta);
    depth = Math.max(0, depth + curlyDelta);
  }
  return out.join('\n');
}

/** 缩进敏感系（Python）：只清理行尾空白与多余空行，缩进一个字都不动 */
export function tidyIndentSensitive(code: string): string {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  // 只有当所有缩进都用 Tab（没有任何一行用空格缩进）时，才把 Tab 换成空格
  const usesSpaceIndent = lines.some((line) => /^[ ]+\S/.test(line));
  const usesTabIndent = lines.some((line) => /^\t+\S/.test(line));
  const convertTabs = usesTabIndent && !usesSpaceIndent;

  const out: string[] = [];
  let blank = 0;
  for (const raw of lines) {
    const line = convertTabs ? raw.replace(/^\t+/, (tabs) => ' '.repeat(tabs.length * INDENT_WIDTH)) : raw;
    const trimmed = line.replace(/[ \t]+$/, '');
    if (trimmed === '') {
      blank += 1;
      if (blank <= 1) out.push('');
      continue;
    }
    blank = 0;
    out.push(trimmed);
  }
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** 不认识的语言：只做行尾空白与多余空行清理 */
export function tidyPlain(code: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of code.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.replace(/[ \t]+$/, '');
    if (trimmed === '') {
      blank += 1;
      if (blank <= 1) out.push('');
      continue;
    }
    blank = 0;
    out.push(trimmed);
  }
  while (out.length > 0 && out[0] === '') out.shift();
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * 整理代码：按语言选策略。
 *
 * @param code    作答区里的原文
 * @param language 页面上选的语言（c / python / python3 …）
 */
export function formatCode(code: string, language: string): string {
  const source = String(code ?? '');
  if (source.trim() === '') return source;
  const style = codeStyleFor(language);
  if (style === 'brace') {
    const reindented = reindentByBraces(source);
    return tidyPlain(reindented);
  }
  if (style === 'indent') return tidyIndentSensitive(source);
  return tidyPlain(source);
}

/**
 * 整理前后的差异摘要，给按钮做提示用（「整理了 12 行」）。
 */
export function formatSummary(before: string, after: string): string {
  if (before === after) return '代码已经是整齐的，没有改动';
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let changed = 0;
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changed += 1;
  }
  return `已整理 ${changed} 行`;
}
