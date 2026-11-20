// 代码提示的纯逻辑：候选表、前缀过滤、按使用频率排序、补全时该带哪个 #include。
//
// 为什么不放在页面脚本里：这份表要能被 Node 直接单测（哪些名字、头文件对不对），
// 而页面脚本是一段字符串、没有模块系统。所以表与规则都在这里，
// 由背景在注入时把结果整份塞进页面脚本。
//
// 本次只做 C / C++（用户拍板）：其它语言 `completionsFor` 返回空数组，补全不弹。

import { C_LIBRARY_DOCS } from './c-library-docs.ts';
import { CPP_LIBRARY_DOCS } from './cpp-library-docs.ts';

/** C 关键字（C11 起，够 PTA 用） */
export const C_KEYWORDS: string[] = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else',
  'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register',
  'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef',
  'union', 'unsigned', 'void', 'volatile', 'while',
];

/** C++ 关键字：C 的全部加上 C++ 独有的 */
export const CPP_KEYWORDS: string[] = [
  ...C_KEYWORDS,
  'bool', 'catch', 'class', 'constexpr', 'const_cast', 'decltype', 'delete', 'dynamic_cast',
  'explicit', 'export', 'false', 'friend', 'mutable', 'namespace', 'new', 'nullptr', 'operator',
  'private', 'protected', 'public', 'reinterpret_cast', 'static_assert', 'static_cast', 'template',
  'this', 'throw', 'true', 'try', 'typeid', 'typename', 'using', 'virtual', 'wchar_t',
];

/**
 * C 标准库函数 → 所在头文件。
 *
 * 只收**没有歧义**的名字：同一个名字出现在两个头里的（比如 remove 在 stdio.h 与
 * algorithm 里都有）宁可不标，免得补全时往文件头塞错 #include。
 */
export const C_STDLIB_HEADERS: Record<string, string> = {
  // stdio.h
  printf: 'stdio.h', scanf: 'stdio.h', puts: 'stdio.h', putchar: 'stdio.h', getchar: 'stdio.h',
  fopen: 'stdio.h', fclose: 'stdio.h', fread: 'stdio.h', fwrite: 'stdio.h', fgets: 'stdio.h',
  fputs: 'stdio.h', fseek: 'stdio.h', ftell: 'stdio.h', rewind: 'stdio.h', feof: 'stdio.h',
  fflush: 'stdio.h',
  // stdlib.h
  malloc: 'stdlib.h', calloc: 'stdlib.h', realloc: 'stdlib.h', free: 'stdlib.h', exit: 'stdlib.h',
  abort: 'stdlib.h', atexit: 'stdlib.h', atoi: 'stdlib.h', atol: 'stdlib.h', atof: 'stdlib.h',
  strtol: 'stdlib.h', strtod: 'stdlib.h', rand: 'stdlib.h', srand: 'stdlib.h', qsort: 'stdlib.h',
  bsearch: 'stdlib.h', abs: 'stdlib.h', labs: 'stdlib.h', getenv: 'stdlib.h', system: 'stdlib.h',
  // string.h
  strlen: 'string.h', strcpy: 'string.h', strncpy: 'string.h', strcat: 'string.h',
  strncat: 'string.h', strcmp: 'string.h', strncmp: 'string.h', strchr: 'string.h',
  strrchr: 'string.h', strstr: 'string.h', strtok: 'string.h', strspn: 'string.h',
  strcspn: 'string.h', strpbrk: 'string.h', memset: 'string.h', memcpy: 'string.h',
  memmove: 'string.h', memcmp: 'string.h', memchr: 'string.h',
  // math.h
  sqrt: 'math.h', pow: 'math.h', exp: 'math.h', log: 'math.h', log10: 'math.h', log2: 'math.h',
  sin: 'math.h', cos: 'math.h', tan: 'math.h', asin: 'math.h', acos: 'math.h', atan: 'math.h',
  atan2: 'math.h', sinh: 'math.h', cosh: 'math.h', tanh: 'math.h', ceil: 'math.h',
  floor: 'math.h', round: 'math.h', trunc: 'math.h', fabs: 'math.h', fmod: 'math.h',
  hypot: 'math.h', cbrt: 'math.h', ldexp: 'math.h', frexp: 'math.h', modf: 'math.h',
  isnan: 'math.h', isinf: 'math.h',
  M_PI: 'math.h', M_E: 'math.h', M_SQRT2: 'math.h', INFINITY: 'math.h', NAN: 'math.h',
};

/**
 * C++ 标准库名字 → 所在头文件。
 *
 * 成员函数（push_back / find / insert / top / first …）一律不给头：它们在好几个容器里
 * 都有，补全时自动补一个错的 #include 比不补更糟。
 */
export const CPP_STDLIB_HEADERS: Record<string, string> = {
  // iostream
  cin: 'iostream', cout: 'iostream', endl: 'iostream', getline: 'iostream',
  // vector
  vector: 'vector',
  // string
  string: 'string', substr: 'string', stoi: 'string', to_string: 'string',
  // algorithm
  sort: 'algorithm', reverse: 'algorithm', unique: 'algorithm', lower_bound: 'algorithm',
  upper_bound: 'algorithm', binary_search: 'algorithm', max_element: 'algorithm',
  min_element: 'algorithm', swap: 'algorithm', max: 'algorithm', min: 'algorithm',
  __gcd: 'algorithm',
  // numeric
  accumulate: 'numeric', gcd: 'numeric',
  // 关联容器
  map: 'map', unordered_map: 'unordered_map', set: 'set', unordered_set: 'unordered_set',
  // 适配器
  queue: 'queue', priority_queue: 'queue', stack: 'stack', deque: 'deque',
  // pair
  pair: 'utility', make_pair: 'utility',
  // climits
  INT_MAX: 'climits',
};

/** 带结构的补全：插入一段模板，光标落在 caret（相对模板开头的下标） */
export interface HintSnippet {
  text: string;
  caret: number;
}

/**
 * 补全项的分类：决定排序优先级与下拉里的分组。
 * 顺序 = 优先级：代码块 > 当前作用域里的名字 > 常量 > 关键字 > 标准库。
 */
export type HintKind = 'block' | 'keyword' | 'variable' | 'function' | 'constant' | 'library';

/** 补全项：名字 + 需要自动补的 #include（null 表示不用补） */
export interface HintEntry {
  label: string;
  header: string | null;
  /** 分类；不写按标准库算（老数据兼容） */
  kind?: HintKind;
  /** 关键字模板：整词补全后自动带出结构 */
  snippet?: HintSnippet;
}

/**
 * 用 `|` 标出光标位置：写模板时一目了然，算下标交给这里。
 * （页面对比、注释里都能看懂，比手数 offset 靠谱）
 */
function snippetWithCaret(raw: string): HintSnippet {
  const at = raw.indexOf('|');
  if (at < 0) return { text: raw, caret: raw.length };
  return { text: raw.slice(0, at) + raw.slice(at + 1), caret: at };
}

/**
 * 会带出结构的关键字模板（跟 IDEA 的 live template 一个意思）。
 * 只有「补全后十有八九要写结构」的那几个才有；int/char 这种补完就是补完了。
 */
const KEYWORD_SNIPPETS: Record<string, string> = {
  if: 'if (|) {\n    \n}',
  else: 'else {\n    |\n}',
  while: 'while (|) {\n    \n}',
  for: 'for (|;;) {\n    \n}',
  do: 'do {\n    \n} while (|);',
  switch: 'switch (|) {\n    \n}',
  struct: 'struct | {\n    \n};',
  main: 'int main(void) {\n    |\n}',
  fori: 'for (int i = 0; i < |; i++) {\n    \n}',
  scanf: 'scanf("%d", &|);',
  printf: 'printf("%d", |);',
};

/**
 * 各头文件里的常量（宏）。
 *
 * 用户选中这些常量时，插件会顺手把对应的 #include 补上——
 * 常量离开头文件就没了，只补名字等于埋雷。
 */
export const HEADER_CONSTANTS: Readonly<Record<string, readonly string[]>> = {
  'limits.h': ['CHAR_BIT', 'SCHAR_MAX', 'SCHAR_MIN', 'UCHAR_MAX', 'CHAR_MAX', 'CHAR_MIN', 'SHRT_MAX', 'SHRT_MIN', 'USHRT_MAX', 'INT_MAX', 'INT_MIN', 'UINT_MAX', 'LONG_MAX', 'LONG_MIN', 'ULONG_MAX', 'LLONG_MAX', 'LLONG_MIN', 'ULLONG_MAX'],
  'stdio.h': ['EOF', 'NULL', 'BUFSIZ', 'FILENAME_MAX', 'FOPEN_MAX', 'TMP_MAX', 'L_tmpnam', 'SEEK_SET', 'SEEK_CUR', 'SEEK_END', '_IOFBF', '_IOLBF', '_IONBF'],
  'stdlib.h': ['EXIT_SUCCESS', 'EXIT_FAILURE', 'RAND_MAX', 'MB_CUR_MAX'],
  'math.h': ['M_E', 'M_LOG2E', 'M_LOG10E', 'M_LN2', 'M_LN10', 'M_PI', 'M_PI_2', 'M_PI_4', 'M_1_PI', 'M_2_PI', 'M_SQRT2', 'M_SQRT1_2', 'INFINITY', 'NAN', 'HUGE_VAL'],
  'float.h': ['FLT_MAX', 'FLT_MIN', 'FLT_EPSILON', 'FLT_DIG', 'DBL_MAX', 'DBL_MIN', 'DBL_EPSILON', 'DBL_DIG', 'LDBL_MAX', 'LDBL_MIN'],
  'stdbool.h': ['true', 'false'],
  'stddef.h': ['NULL'],
  'time.h': ['CLOCKS_PER_SEC'],
  'errno.h': ['EPERM', 'ENOENT', 'EINTR', 'EIO', 'EBADF', 'EAGAIN', 'ENOMEM', 'EACCES', 'EFAULT', 'EINVAL'],
  'assert.h': ['NDEBUG'],
};

/** 常量候选项（label + 属于哪个头文件） */
export function constantEntries(): HintEntry[] {
  const out: HintEntry[] = [];
  const seen = new Set<string>();
  for (const header of Object.keys(HEADER_CONSTANTS)) {
    for (const label of HEADER_CONSTANTS[header]) {
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ label: label, header: header, kind: 'constant' });
    }
  }
  return out;
}

/** 语言归一化：PTA 语言下拉框读出来的值 → 我们认的两个 */
function normalizeLanguage(language: string): 'c' | 'cpp' | '' {
  const value = (language ?? '').trim().toLowerCase();
  if (value === 'cpp' || value === 'c++' || value === 'cxx') return 'cpp';
  if (value === 'c') return 'c';
  return '';
}

function entriesFromDocs(docs: Record<string, unknown>, headers: Record<string, string>): HintEntry[] {
  return Object.keys(docs).map((label) => ({ label, header: headers[label] ?? null, kind: 'library' as HintKind }));
}

function keywordEntries(list: string[]): HintEntry[] {
  return list.map((label) => {
    const template = KEYWORD_SNIPPETS[label];
    return {
      label: label,
      header: null,
      kind: (template ? 'block' : 'keyword') as HintKind,
      ...(template ? { snippet: snippetWithCaret(template) } : {}),
    };
  });
}

/** 每个关键字都要能带出自己的模板（测试与页面脚本共用这一份判断） */
export function keywordSnippet(label: string): HintSnippet | null {
  const template = KEYWORD_SNIPPETS[label];
  return template ? snippetWithCaret(template) : null;
}

/** 用户自己定义的名字：变量、函数、宏、常量 */
export interface ScopeName {
  name: string;
  kind: 'variable' | 'function' | 'macro' | 'constant';
  /** 属于哪个头文件（自己定义的没有） */
  header: string | null;
}

/**
 * 扫出「在这个位置可见」的名字：用户自己定义的函数、变量、宏、常量。
 *
 * 为什么要看作用域：同一个文件里到处是 i / tmp / p，
 * 把别的块里的变量也补出来，选中就是编译不过（IDE 不会这么干）。
 *
 * 判据：
 *   · 一对花括号 = 一个作用域，块里的名字只在块内可见；
 *   · 文件作用域的名字在声明之后可见；函数名例外（用户想补下面定义的函数）；
 *   · 光标在嵌套块里时，外层块的变量照样可见（这才是词法作用域）。
 *
 * 这个函数必须**自包含**：页面脚本是一整段字符串、没有模块系统，
 * 运行时要把它的源码整段塞进去，所以不能引用模块里的任何东西，
 * 也不能用模板字符串（反引号）——页面脚本的源码串里不能出现反引号。
 */
export function scopeNamesAt(source: string, position: number): ScopeName[] {
  const text = String(source == null ? '' : source);
  const limit = Math.max(0, Math.min(Number(position) || 0, text.length));

  // 1) 注释与字符串换成空格（长度不变，下标还对得上）
  const chars = text.split('');
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '/' && text.charAt(i + 1) === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) {
        chars[i] = ' ';
        i += 1;
      }
      if (i < text.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      chars[i] = ' ';
      i += 1;
      while (i < text.length && text.charAt(i) !== quote) {
        if (text.charAt(i) === '\\') {
          chars[i] = ' ';
          i += 1;
          if (i < text.length) {
            chars[i] = ' ';
            i += 1;
          }
          continue;
        }
        chars[i] = ' ';
        i += 1;
      }
      if (i < text.length) {
        chars[i] = ' ';
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  const code = chars.join('');

  // 2) 花括号块（没闭合的算到文末）
  const blocks: { open: number; close: number }[] = [];
  const stack: number[] = [];
  for (let p = 0; p < code.length; p += 1) {
    const c = code.charAt(p);
    if (c === '{') stack.push(p);
    else if (c === '}' && stack.length > 0) {
      blocks.push({ open: stack.pop() as number, close: p });
    }
  }
  // 没闭合的块算到文末之后一格：光标正好在文末时也算「还在块里」
  while (stack.length > 0) blocks.push({ open: stack.pop() as number, close: code.length + 1 });

  const blockAt = (offset: number): { open: number; close: number } | null => {
    let best: { open: number; close: number } | null = null;
    for (let k = 0; k < blocks.length; k += 1) {
      const b = blocks[k];
      if (offset > b.open && offset < b.close && (!best || b.open > best.open)) best = b;
    }
    return best;
  };

  // 3) 认声明
  const typeWords = 'int|char|short|long|float|double|void|bool|signed|unsigned|size_t|ssize_t|auto|const|struct|union|enum|static|extern|register|volatile|inline|wchar_t|int8_t|int16_t|int32_t|int64_t|uint8_t|uint16_t|uint32_t|uint64_t|ptrdiff_t';
  const typeSet: Record<string, boolean> = {};
  typeWords.split('|').forEach((word) => { typeSet[word] = true; });
  const keywordSet: Record<string, boolean> = {};
  'if|for|while|switch|catch|return|sizeof|do|else|defined|goto|break|continue'.split('|').forEach((word) => { keywordSet[word] = true; });

  const found: { name: string; kind: ScopeName['kind']; offset: number }[] = [];
  // 形参列表的范围：里面的 `int n` 是形参，不是变量声明，别重复算一遍
  const paramRanges: { from: number; to: number }[] = [];

  // 宏：#define NAME
  const macroRe = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
  let m: RegExpExecArray | null;
  while ((m = macroRe.exec(code)) !== null) {
    found.push({ name: m[1], kind: 'macro', offset: m.index });
  }

  // 函数：前面是类型关键字的 `名字(`
  // 形参属于**函数体**那个块（不在花括号里的话就是文件作用域，只对原型有效）
  const callRe = /\b([A-Za-z_]\w*)[ \t\n\r]*\(/g;
  while ((m = callRe.exec(code)) !== null) {
    const name = m[1];
    if (keywordSet[name]) continue;
    const before = code.slice(Math.max(0, m.index - 80), m.index);
    const prevMatch = /([A-Za-z_]\w*)[ \t\n\r]*\**\s*$/.exec(before);
    const prev = prevMatch ? prevMatch[1] : '';
    if (!prev || !typeSet[prev]) continue;
    found.push({ name: name, kind: 'function', offset: m.index });

    // 取形参：括号里逗号分隔的标识符
    const open = code.indexOf('(', m.index);
    let close = -1;
    let depth = 0;
    for (let p = open; p < code.length; p += 1) {
      const c = code.charAt(p);
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) { close = p; break; }
      }
    }
    if (open < 0 || close < 0) continue;
    paramRanges.push({ from: open, to: close });
    const params = code.slice(open + 1, close);
    // 形参的块 = 形参列表后面第一个 { 所在的块（只有定义才有体）
    let bodyOpen = -1;
    for (let p = close + 1; p < code.length; p += 1) {
      const c = code.charAt(p);
      if (c === ';') break;
      if (c === '{') { bodyOpen = p; break; }
      if (c === '}') break;
    }
    if (bodyOpen < 0) continue;
    const bodyBlock = blockAt(bodyOpen + 1);
    const paramRe = /([A-Za-z_]\w*)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(params)) !== null) {
      const pname = pm[1];
      if (typeSet[pname] || keywordSet[pname]) continue;
      found.push({
        name: pname,
        kind: 'variable',
        // +1：花括号本身不算「在块里」，从它后面开始才算
        offset: bodyBlock ? bodyBlock.open + 1 : bodyOpen + 1,
      });
    }
  }

  // 变量 / 常量：类型（可带修饰词）+ 名字
  // 类型词要能连着写（const int / unsigned long / static char），否则会把
  // `const int limit` 读成「名字叫 int 的常量」
  const typeGroup = '(?:' + typeWords + ')(?:[ \\t\\n\\r]+(?:' + typeWords + '))*';
  const varRe = new RegExp('\\b(' + typeGroup + ')\\b[ \\t\\n\\r]*\\**([A-Za-z_]\\w*)', 'g');
  while ((m = varRe.exec(code)) !== null) {
    const after = code.slice(varRe.lastIndex, varRe.lastIndex + 3);
    if (/^[ \t\n\r]*\(/.test(after)) continue; // 函数声明，交给上面那条
    if (code.charAt(varRe.lastIndex) === '*') continue; // `struct Node *p`：Node 是类型
    let inParams = false;
    for (const range of paramRanges) {
      if (m.index >= range.from && m.index <= range.to) { inParams = true; break; }
    }
    if (inParams) continue; // 形参，交给上面那条处理
    const before = code.slice(Math.max(0, m.index - 24), m.index);
    const isConst = /\bconst\b/.test(before) || /\bconst\b/.test(m[0]);
    // 位置取「名字」所在处：光标在声明之前时，这个名字还不该出现
    const nameAt = m.index + m[0].lastIndexOf(m[2]);
    found.push({ name: m[2], kind: isConst ? 'constant' : 'variable', offset: nameAt });
  }

  // 4) 按作用域过滤：只留光标位置能看见的
  const seen: Record<string, boolean> = {};
  const out: ScopeName[] = [];
  for (const item of found) {
    if (!item.name || seen[item.name]) continue;
    const block = blockAt(item.offset);
    if (block) {
      // 块内声明：光标得在这个块里，而且声明要在光标之前
      if (!(limit > item.offset && limit > block.open && limit < block.close)) continue;
    } else if (item.kind !== 'function' && !(limit > item.offset)) {
      // 文件作用域：声明之后才可见（函数名例外）
      continue;
    }
    seen[item.name] = true;
    out.push({ name: item.name, kind: item.kind, header: null });
  }
  return out;
}

/**
 * 从当前文件里抓出「用户自己的名字」，做变量/函数名补全。
 *
 * 启发式但够用：只认 `[A-Za-z_]\w*`，去掉关键字、去掉纯数字后缀的宏噪声，
 * 去重后按出现顺序保留——IDEA 里也是「文件里出现过的名字」优先。
 */
export function identifiersIn(source: string, language: string, limit = 300): HintEntry[] {
  const kind = normalizeLanguage(language);
  if (!kind) return [];
  const keywords = kind === 'cpp' ? CPP_KEYWORDS : C_KEYWORDS;
  const skip = new Set<string>([...keywords, '__', 'main']);
  const seen = new Set<string>();
  const out: HintEntry[] = [];
  const pattern = /[A-Za-z_][A-Za-z_0-9]*/g;
  const text = String(source ?? '');
  let match = pattern.exec(text);
  while (match) {
    const label = match[0];
    // 每个匹配都往前推：`continue` 之前忘掉 exec 就会原地打转（死循环）
    if (label.length >= 2 && !skip.has(label) && !seen.has(label)) {
      seen.add(label);
      out.push({ label: label, header: null, kind: 'variable' });
      if (out.length >= limit) break;
    }
    match = pattern.exec(text);
  }
  return out;
}

/**
 * 排序权重：代码块 > 当前作用域里的名字 > 常量 > 关键字 > 标准库。
 * 同档里再按使用频率、名字排序。
 */
export function kindRank(entry: HintEntry): number {
  switch (entry.kind) {
    case 'block': return 0;
    case 'variable': return 1;
    case 'function': return 1;
    case 'constant': return 2;
    case 'keyword': return 3;
    default: return 4;
  }
}

/**
 * 某个语言的全部补全项。
 *
 * C++ 也要给 C 的标准库（PTA 的 C++ 题里 `printf`、`malloc` 一样常见，
 * 只是头文件要换成 C++ 的写法——这里仍按 C 的头标，因为 `<stdio.h>` 在 C++ 里同样合法）。
 */
export function completionsFor(language: string): HintEntry[] {
  const kind = normalizeLanguage(language);
  if (kind === 'c') {
    return [...keywordEntries(C_KEYWORDS), ...entriesFromDocs(C_LIBRARY_DOCS, C_STDLIB_HEADERS)];
  }
  if (kind === 'cpp') {
    return [
      ...keywordEntries(CPP_KEYWORDS),
      ...entriesFromDocs(CPP_LIBRARY_DOCS, CPP_STDLIB_HEADERS),
      ...entriesFromDocs(C_LIBRARY_DOCS, C_STDLIB_HEADERS),
    ];
  }
  return [];
}

/**
 * 前缀过滤：忽略大小写，且**整词已经打全的不再提示**（否则每敲完一个词
 * 都弹一条和原文一模一样的候选，纯噪音）。
 */
export function filterCompletions(list: HintEntry[], prefix: string): HintEntry[] {
  const head = (prefix ?? '').toLowerCase();
  if (!head) return [];
  return list.filter((entry) => entry.label.toLowerCase().startsWith(head) && entry.label !== prefix);
}

/** 按历史使用次数排序：常用的在前，同分按名字升序（保证顺序稳定） */
export function sortByFrequency(list: HintEntry[], freq: Record<string, number>): HintEntry[] {
  const score = (entry: HintEntry): number => {
    const value = freq?.[entry.label];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return [...list].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}
