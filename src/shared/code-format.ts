/**
 * 「整理代码」按钮背后的格式化逻辑（纯函数，Node 里可以直接单测）。
 *
 * 目标不是「clang-format 那种完美重排」，而是**安全 + 好读**：
 * 用户交的是 PTA 作答区的代码，改坏了就是白写。所以规则刻意守两条底线：
 *   · 一定不改任何 token 的内容（字符串、字符常量、注释里的字面量原样保留）；
 *   · 一定不改语义结构（不挪动代码、不合并行、不加删括号、不改 Python 的缩进）。
 *
 * 目前按语言分三套：
 *   · **C**（`formatCode(code, 'c')`）：运算符两侧统一一个空格、逗号/分号后补空格、
 *     按花括号重排缩进、**无花括号的控制体缩进一层**（`if (x)\n    return 1;`）。
 *   · **Python**：只规范符号运算符两侧的空格（`a==b` → `a == b`），
 *     **缩进一个字都不动**（那是语义），也不碰 `:`。
 *   · 其他大括号语言 / 不认识的语言：只清行尾空白、压空行（老行为，保守）。
 */

/** 缩进用几个空格 */
export const INDENT_WIDTH = 4;

/** 语言归类：决定用哪套整理策略 */
export type CodeStyle = 'c' | 'python' | 'brace' | 'plain';

/**
 * 按语言选策略。
 *
 * 只有 C 和 Python 做了「加空格」这类改动，其余语言先保守处理：
 * 不认识的语法（模板、装饰器、lambda 里带冒号…）上动空格，风险大于收益。
 */
export function codeStyleFor(language: string): CodeStyle {
  const lang = String(language ?? '').toLowerCase();
  if (/python/.test(lang)) return 'python';
  if (/^c\b/.test(lang) || /\bgcc\b|\bclang\b/.test(lang) || /^c$/.test(lang)) return 'c';
  if (/^(cpp|c\+\+|java|js|javascript|golang|go|rust|php|swift|kotlin|cs|c#|scala|dart|ts|typescript)\b/.test(lang)) {
    return 'brace';
  }
  return 'plain';
}

/* ------------------------------------------------------------------ *
 * 剥掉字符串 / 注释（长度保持不变）
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * 词法切分：只用来重排空格，不改 token 内容
 * ------------------------------------------------------------------ */

type TokenKind = 'word' | 'number' | 'string' | 'comment' | 'op';

interface Token {
  kind: TokenKind;
  text: string;
}

/** 多字符运算符：必须按长度从长到短匹配，否则 `<<=` 会被拆成 `<` `<=` */
const OPERATORS = [
  '<<=', '>>=', '...', '->*', '::',
  '->', '++', '--', '==', '!=', '<=', '>=', '&&', '||',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '//',
].sort((a, b) => b.length - a.length);

interface TokenizeResult {
  tokens: Token[];
  inBlockComment: boolean;
  /** Python 用：这行结束时是否还在三引号字符串里 */
  inTripleQuote: string;
}

/** 把一行切成 token；空白直接丢掉（空格由后面的规则重新生成） */
export function tokenizeLine(line: string, options: { python?: boolean; inBlockComment?: boolean; inTripleQuote?: string } = {}): TokenizeResult {
  const python = options.python === true;
  let block = options.inBlockComment === true;
  let triple = options.inTripleQuote ?? '';
  const tokens: Token[] = [];
  let index = 0;

  const push = (kind: TokenKind, text: string) => tokens.push({ kind, text });

  while (index < line.length) {
    const ch = line[index];

    if (block) {
      const end = line.indexOf('*/', index);
      if (end < 0) {
        push('comment', line.slice(index));
        index = line.length;
        break;
      }
      push('comment', line.slice(index, end + 2));
      index = end + 2;
      block = false;
      continue;
    }

    if (triple) {
      const end = line.indexOf(triple, index);
      if (end < 0) {
        push('string', line.slice(index));
        index = line.length;
        break;
      }
      push('string', line.slice(index, end + triple.length));
      index = end + triple.length;
      triple = '';
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      index += 1;
      continue;
    }

    // Python 的三引号字符串可能跨行，得单独认
    if (python && (line.startsWith('"""', index) || line.startsWith("'''", index))) {
      const quote = line.slice(index, index + 3);
      const end = line.indexOf(quote, index + 3);
      if (end < 0) {
        push('string', line.slice(index));
        index = line.length;
        triple = quote;
        break;
      }
      push('string', line.slice(index, end + 3));
      index = end + 3;
      continue;
    }

    if (ch === '/' && line[index + 1] === '*' && !python) {
      block = true;
      index += 2;
      continue;
    }
    if (ch === '/' && line[index + 1] === '/' && !python) {
      push('comment', line.slice(index));
      index = line.length;
      break;
    }
    if (python && ch === '#') {
      push('comment', line.slice(index));
      index = line.length;
      break;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let end = index + 1;
      while (end < line.length) {
        const cur = line[end];
        if (cur === '\\') {
          end += 2;
          continue;
        }
        end += 1;
        if (cur === quote) break;
      }
      push('string', line.slice(index, Math.min(end, line.length)));
      index = Math.min(end, line.length);
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(line[index + 1] ?? ''))) {
      const match = /^(?:0[xXbB][0-9a-fA-F_]+|[0-9][0-9a-zA-Z_.]*|\.?[0-9][0-9a-zA-Z_.]*)/.exec(line.slice(index));
      const text = match ? match[0] : ch;
      push('number', text);
      index += text.length;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(line.slice(index));
      const text = match ? match[0] : ch;
      push('word', text);
      index += text.length;
      continue;
    }

    const op = OPERATORS.find((candidate) => line.startsWith(candidate, index));
    if (op) {
      push('op', op);
      index += op.length;
      continue;
    }
    push('op', ch);
    index += 1;
  }

  return { tokens, inBlockComment: block, inTripleQuote: triple };
}

/* ------------------------------------------------------------------ *
 * 空格重排
 * ------------------------------------------------------------------ */

/** 这些词后面跟 `*` / `&` 时，那个符号是声明符：`int *p` */
const TYPE_WORDS = new Set([
  'void', 'char', 'short', 'int', 'long', 'float', 'double', 'signed', 'unsigned',
  'const', 'volatile', 'static', 'extern', 'register', 'struct', 'union', 'enum',
  'typedef', 'inline', 'restrict', 'size_t', 'ssize_t', 'bool', '_Bool',
  'FILE', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'auto',
]);

/** 这些都算「值」：后面紧跟 `(` 是函数调用、紧跟 `*` 是乘法 */
const valueKinds = new Set<TokenKind>(['word', 'number', 'string']);

/** 两侧都要一个空格的二元运算符 */
const BINARY_OPS = new Set([
  '=', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%',
  '&&', '||', '&', '|', '^', '<<', '>>', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<=', '>>=', '**', '//',
  'and', 'or', 'in', 'is',
]);

/** 紧跟在后面、需要「下一个 token 也留空格」的符号 */
const FORCE_SPACE_AFTER = new Set([',', ';']);

const isValue = (token: Token | null): boolean =>
  !!token && (valueKinds.has(token.kind) || token.text === ')' || token.text === ']' || token.text === '}');

/**
 * 重新生成一行里的空格。
 *
 * 规则（C 模式，Python 模式关掉 `? :` 和声明符那两条）：
 *   · 二元运算符两侧各一个空格；`7*2` → `7 * 2`
 *   · `,` 和 `;` 后面一个空格、前面没有
 *   · `(` 前面不加空格（`f(x)`、`if (x)` 保持调用/关键字原样）
 *   · `*` / `&` 分三种：声明符（前面是类型名 → `int *p`）、解引用（前面是运算符 →
 *     `*p`）、乘法（两侧都是值 → `a * b`）
 *   · 一元 `+ - ! ~` 紧贴后面的操作数
 *   · `++` / `--` 两侧都不加空格
 *   · `? :` 成对加成二元运算符；单个 `:`（标签、`case 1:`）不动
 */
function spaceTokens(tokens: Token[], python: boolean): string {
  let out = '';
  let prev: Token | null = null;
  // prev 在 emit 闭包里赋值，直接读会被 TS 收窄成 null；包一层函数按声明类型读
  const last = (): Token | null => prev;
  let forceSpace = false;
  let pendingTernary = 0;
  // 上一个 `*` / `&` 已经被判成声明符时，连续的 `char **argv` 里的第二个也跟着算声明符
  let declaratorChain = false;

  const emit = (token: Token, leadingSpace: boolean) => {
    if (out.length > 0 && (leadingSpace || forceSpace)) out += ' ';
    out += token.text;
    forceSpace = false;
    prev = token;
  };

  const startsExpression = (token: Token | null): boolean => {
    if (!token) return true;
    if (token.text === '(' || token.text === '[' || token.text === '{') return true;
    if (token.kind === 'op') return ![')', ']', '}', '++', '--'].includes(token.text);
    return token.kind === 'word' && ['return', 'case', 'else', 'do'].includes(token.text);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const text = token.text;

    if (token.kind === 'comment') {
      // 注释原样保留；前面有代码就空一格，行尾注释不至于黏在符号上
      emit(token, out.length > 0);
      continue;
    }

    if (token.kind === 'word' || token.kind === 'number' || token.kind === 'string') {
      const before = last();
      emit(token, isValue(before) || (!!before && ['}', ')', ']'].includes(before.text)));
      declaratorChain = false;
      continue;
    }

    // ---- 运算符 ----
    if (text === '(' || text === '[') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (text === ')' || text === ']') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (text === '{') {
      const before = last();
      emit(token, isValue(before) || (!!before && [')', ']'].includes(before.text)));
      declaratorChain = false;
      continue;
    }
    if (text === '}') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (FORCE_SPACE_AFTER.has(text)) {
      emit(token, false);
      forceSpace = true;
      declaratorChain = false;
      continue;
    }
    if (text === '.') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (text === '->' || text === '->*' || text === '::') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (text === '++' || text === '--') {
      emit(token, false);
      declaratorChain = false;
      continue;
    }
    if (text === '!' || text === '~') {
      emit(token, startsExpression(last()));
      declaratorChain = false;
      continue;
    }

    if (text === '*' || text === '&' || text === '**') {
      // 声明符：前面是类型名（`int *p`、`char **argv`），或上一个星号已经是声明符
      const before = last();
      if (!python && (declaratorChain || (!!before && before.kind === 'word' && TYPE_WORDS.has(before.text)))) {
        emit(token, true);
        declaratorChain = true;
        continue;
      }
      // 解引用 / 取地址：前面是运算符、括号、逗号、return 之类
      if (startsExpression(last())) {
        emit(token, false);
        declaratorChain = false;
        continue;
      }
      emit(token, true);
      forceSpace = true;
      declaratorChain = false;
      continue;
    }

    if (text === '+' || text === '-') {
      if (startsExpression(last())) {
        emit(token, false);
        declaratorChain = false;
        continue;
      }
      emit(token, true);
      forceSpace = true;
      declaratorChain = false;
      continue;
    }

    if (text === '?') {
      emit(token, true);
      forceSpace = true;
      pendingTernary += 1;
      declaratorChain = false;
      continue;
    }
    if (text === ':') {
      if (!python && pendingTernary > 0) {
        emit(token, true);
        forceSpace = true;
        pendingTernary -= 1;
      } else {
        emit(token, false);
      }
      declaratorChain = false;
      continue;
    }

    if (BINARY_OPS.has(text)) {
      emit(token, true);
      forceSpace = true;
      declaratorChain = false;
      continue;
    }

    // 剩下的标点（`##`、`@` 之类）：左边不加空格，别把 token 拆开
    emit(token, false);
    declaratorChain = false;
  }

  return out.replace(/\s+$/, '');
}

/* ------------------------------------------------------------------ *
 * C：重排空格 + 重算缩进（含无花括号的控制体）
 * ------------------------------------------------------------------ */

/**
 * 大括号系的重新缩进。
 *
 * 规则：
 *   · 缩进 = 花括号深度 +（圆括号没闭合时多一层）+（上一行是没写 `{` 的控制语句时一层）
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
  /** 上一行是 `if (...)` / `else` 这种没写 `{` 的控制语句：下一行要多缩一层 */
  let pendingBody = false;

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

    const opensBrace = /\{\s*$/.test(codeOnly);
    const isBraceOnly = /^\s*\}/.test(codeOnly);

    if (opensBrace) pendingBody = false;

    let indent = depth;
    if (paren > 0) indent += 1;
    if (pendingBody && !opensBrace) indent += 1;
    // 以 } 开头的行是收尾花括号，case/default 标签按惯例比块内语句少一层
    if (isBraceOnly) indent -= 1;
    if (/^\s*(case\b|default\b)/.test(codeOnly)) indent -= 1;
    if (indent < 0) indent = 0;

    if (preprocessor) {
      out.push(raw.replace(/[ \t]+$/, ''));
      pendingBody = false;
    } else {
      const body = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      out.push(' '.repeat(indent * INDENT_WIDTH) + body);
      // 这一行吃掉了上一行的待缩进：除非它自己又是一句没写 `{` 的控制语句
      pendingBody = !opensBrace && !isBraceOnly && isBodylessControl(codeOnly);
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

/**
 * 这一行是不是「没写花括号的控制语句头」——`if (...) {...}` 不算，
 * `if (x)` / `else` / `do` / `else if (x)` 算。
 */
function isBodylessControl(codeOnly: string): boolean {
  const text = codeOnly.trim();
  if (text === '') return false;
  if (/\{\s*$/.test(text) || /\}\s*$/.test(text)) return false;
  if (/^(else|do)$/.test(text)) return true;
  if (/^(if|for|while|else\s+if|switch)\b/.test(text) && /\)\s*$/.test(text)) return true;
  return false;
}

/** C：逐行重排空格，再重算缩进 */
function formatC(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const spaced: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    // 预处理指令、块注释内、反斜杠续行：一律原样，动空格只会把宏和续行弄坏
    if (/^\s*#/.test(raw) || inBlock || /\\\s*$/.test(raw)) {
      spaced.push(raw.replace(/[ \t]+$/, ''));
      if (inBlock) {
        const closed = raw.includes('*/');
        if (closed) inBlock = false;
      }
      continue;
    }
    const { tokens, inBlockComment } = tokenizeLine(raw);
    inBlock = inBlockComment;
    spaced.push(spaceTokens(tokens, false));
  }
  return tidyPlain(reindentByBraces(spaced.join('\n')));
}

/* ------------------------------------------------------------------ *
 * Python：只规范运算符空格，缩进一个字都不动
 * ------------------------------------------------------------------ */

function formatPython(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const spaced: string[] = [];
  let inTriple = '';
  for (const raw of lines) {
    const leading = /^[ \t]*/.exec(raw)?.[0] ?? '';
    const body = raw.slice(leading.length).replace(/[ \t]+$/, '');
    if (body === '') {
      spaced.push('');
      continue;
    }
    // 三引号块里、或者续行：原样保留
    if (inTriple) {
      spaced.push(raw.replace(/[ \t]+$/, ''));
      if (body.includes(inTriple)) inTriple = '';
      continue;
    }
    if (body.startsWith('#')) {
      spaced.push(leading + body);
      continue;
    }
    const result = tokenizeLine(body, { python: true, inTripleQuote: inTriple });
    inTriple = result.inTripleQuote;
    const joined = spaceTokens(result.tokens, true);
    spaced.push(leading + joined);
  }
  return tidyIndentSensitive(spaced.join('\n'));
}

/* ------------------------------------------------------------------ *
 * 兜底清理
 * ------------------------------------------------------------------ */

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
  if (style === 'c') return formatC(source);
  if (style === 'python') return formatPython(source);
  if (style === 'brace') {
    const reindented = reindentByBraces(source);
    return tidyPlain(reindented);
  }
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
