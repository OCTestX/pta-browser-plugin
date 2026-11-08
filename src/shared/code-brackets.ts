/**
 * 彩虹括号：算出每个括号的嵌套层数（纯函数，Node 里可以直接单测）。
 *
 * 页面侧不自己算：CodeMirror 的实例只在 MAIN world 里，
 * 而「层数」是个纯文本问题，放在这里算一次、单测钉住，两边就不会各算各的。
 *
 * 规则：
 *   · 一对配对的括号用同一个层数（开括号用递增前的层数，闭括号用递减后的），
 *     这样一对括号同色，视觉上才像「一对」；
 *   · 字符串、字符常量、注释里的括号不算数（`printf("{")` 不该影响层数）；
 *   · 层数对颜色表取模：超过 6 层就从头再用一遍颜色。
 */

// 带 .ts 后缀：这个模块会被 scripts/test-editor-assist.mjs 直接用 Node 导入（Node 不做省略后缀解析）
import { stripLiteralsAndComments } from './code-format.ts';

/** 一个括号：绝对字符下标 + 层级（已对颜色表取模） */
export interface BracketMark {
  at: number;
  depth: number;
}

/** 彩虹括号的颜色：和 PTA 的浅色主题对比度都够，相邻两层不撞色 */
export const RAINBOW_COLORS: readonly string[] = [
  '#d1373f', // 红
  '#b06d00', // 琥珀
  '#2f7d32', // 绿
  '#17599b', // 蓝
  '#7a3fa8', // 紫
  '#a34a12', // 赭
];

interface BracketShape {
  open: string;
  close: string;
}

/** 三种括号分开配对了再取层数，混着的 `([{` 才会层层加深 */
const BRACKET_PAIRS: readonly BracketShape[] = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
];

/**
 * 算出正文里每个括号的层数。
 *
 * 返回的下标是**原始文本**里的下标（`stripLiteralsAndComments` 用空格等长
 * 替换，所以剥完之后下标仍然对得上），调用方可以拿它直接去 `domAtPos`。
 */
export function bracketDepths(code: string): BracketMark[] {
  const marks: BracketMark[] = [];
  const source = String(code ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');

  // 三种括号各一个深度计数器，再取总和：`f([1])` 的 `[` 会落在 `(` 里面一层
  const depths = [0, 0, 0];
  let inBlockComment = false;
  let base = 0;

  for (const raw of lines) {
    const stripped = stripLiteralsAndComments(raw, inBlockComment);
    inBlockComment = stripped.inBlockComment;
    const line = stripped.code;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === ' ' || char === '\t') continue;

      for (let kind = 0; kind < BRACKET_PAIRS.length; kind += 1) {
        const pair = BRACKET_PAIRS[kind];
        if (char === pair.open) {
          const total = depths[0] + depths[1] + depths[2];
          marks.push({ at: base + index, depth: total % RAINBOW_COLORS.length });
          depths[kind] += 1;
          break;
        }
        if (char === pair.close) {
          depths[kind] = Math.max(0, depths[kind] - 1);
          const total = depths[0] + depths[1] + depths[2];
          marks.push({ at: base + index, depth: total % RAINBOW_COLORS.length });
          break;
        }
      }
    }

    // +1 是换行符本身（\r\n 已经先归一成 \n 了）
    base += raw.length + 1;
  }

  return marks;
}
