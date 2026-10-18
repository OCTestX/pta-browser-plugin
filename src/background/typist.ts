/**
 * 逐字敲代码，边敲边对抗编辑器的「自动闭合」与「自动缩进」。
 *
 * 思路来自同行的实测实现（项目里的 other_pta.md），核心是三条：
 *   ① 每行开始前保证光标右侧为空（只允许删 ) ] } " '，见到别的字符立刻停手，防盲删）
 *   ② 缩进用探针按一下回读一次（不能「要删 N 格就按 N 次 Backspace」——光标停在纯前导空白上时
 *      一次 Backspace 会删光整段缩进，多按的几下直接砸进代码）
 *   ③ 逐字符敲，敲之前先看光标右侧有没有「幻影」（编辑器自动补的右半边）：
 *        源文本正要它 → ArrowRight 跨过去（不重复敲）
 *        用不上       → Delete 抹掉（否则会插进代码中间）
 *        引号幻影     → 留到字面量结束（字符串正常闭合靠它）
 *
 * 探针与按键都通过注入的 io 提供，所以这套算法可以脱离浏览器测（见 scripts/test-typist.mjs）。
 */

// 带上 .ts 后缀：scripts/test-typist.mjs 直接用 Node 导入本模块（Node 不做省略后缀解析）
import { throwIfAborted } from '../shared/abort.ts';

export interface CursorProbe {
  /** 光标在当前行的列号 */
  col: number;
  /** 当前行前导空白长度 */
  indent: number;
  /** 列号超出本行文本长度 —— 说明探针读到的是重渲染前的旧 DOM */
  stale: boolean;
}

export interface TypistIo {
  typeChar: (char: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  /** 光标右侧到行尾的文本；探针不可用时返回 null */
  probeRight: () => Promise<string | null>;
  probeCursor: () => Promise<CursorProbe | null>;
  delay: (ms: number) => Promise<void>;
}

export interface TypistStats {
  lines: number;
  typed: number;
  /** 跨过去的编辑器自动补的闭合符 */
  skipped: number;
  /** 抹掉的用不上的闭合符 */
  erased: number;
  /** 行首清掉的多余闭合符 */
  cleared: number;
  indentBackspace: number;
  indentSpace: number;
}

const OPEN_TO_CLOSE: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
};
const CLOSERS = new Set([')', ']', '}', '"', "'"]);

const MAX_ATTEMPTS = 40;

type LexMode = 'code' | 'line' | 'block' | 'string';

interface LexState {
  mode: LexMode;
  quote: string;
  escaped: boolean;
}

/** 只做四件事：// 行注释、/* * / 块注释、"…"、'…'，外加 \ 转义 */
function stepLex(state: LexState, char: string, next: string | undefined): void {
  if (state.mode === 'line') return;
  if (state.mode === 'block') {
    if (char === '*' && next === '/') state.mode = 'code';
    return;
  }
  if (state.mode === 'string') {
    if (state.escaped) {
      state.escaped = false;
      return;
    }
    if (char === '\\') {
      state.escaped = true;
      return;
    }
    if (char === state.quote) state.mode = 'code';
    return;
  }
  if (char === '/' && next === '/') {
    state.mode = 'line';
    return;
  }
  if (char === '/' && next === '*') {
    state.mode = 'block';
    return;
  }
  if (char === '"' || char === "'") {
    state.mode = 'string';
    state.quote = char;
  }
}

export async function runTypist(
  io: TypistIo,
  source: string,
  perCharDelayMs = 0,
  signal?: AbortSignal,
): Promise<TypistStats> {
  const stats: TypistStats = {
    lines: 0,
    typed: 0,
    skipped: 0,
    erased: 0,
    cleared: 0,
    indentBackspace: 0,
    indentSpace: 0,
  };

  const raw = source.replace(/\r\n/g, '\n').replace(/\t/g, '  ');
  const lines = raw.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();

  let phantom: string | null = null;
  let phantomQuote = false;
  const lex: LexState = { mode: 'code', quote: '', escaped: false };

  const dropPhantom = async (force: boolean): Promise<void> => {
    if (!phantom) return;
    if (phantomQuote && !force) return; // 引号幻影要留到字面量结束
    const right = await io.probeRight();
    if (right?.startsWith(phantom)) {
      await io.press('Delete');
      stats.erased += 1;
    }
    phantom = null;
    phantomQuote = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    stats.lines += 1;

    if (index > 0) {
      // 换行前必须把行尾的幻影抹掉，否则会被 Enter 顶到下一行行首
      const continues = lines[index - 1].endsWith('\\');
      await dropPhantom(continues);
      await io.press('Enter');
      lex.mode = lex.mode === 'line' ? 'code' : lex.mode;
    }

    await clearLineTail(io, stats);

    const leading = line.match(/^[ \t]*/)?.[0].length ?? 0;
    const target = line.trim() === '' ? 0 : leading;
    await normalizeIndent(io, stats, target);

    for (let position = leading; position < line.length; position += 1) {
      // 逐字敲动辄几十秒：每个字符前都看一眼停止标记，按了「停止」就立刻收手
      throwIfAborted(signal);
      const char = line[position];
      const next = line[position + 1];

      if (phantom) {
        const right = await io.probeRight();
        if (right === null || !right.startsWith(phantom)) {
          phantom = null; // 幻影没生成（编辑器没自动闭合），当普通字符敲
          phantomQuote = false;
        } else if (char === phantom) {
          await io.press('ArrowRight'); // 源文本正要它，跨过去
          stats.skipped += 1;
          stepLex(lex, char, next);
          continue;
        } else if (!phantomQuote) {
          await io.press('Delete'); // 用不上，抹掉
          stats.erased += 1;
          phantom = null;
        }
      }

      const modeBefore = lex.mode;
      await io.typeChar(char);
      stats.typed += 1;
      if (perCharDelayMs > 0) await io.delay(perCharDelayMs);
      stepLex(lex, char, next);

      // 敲完左半边，编辑器通常会补上右半边，记下来下一轮去调和。
      // 括号不区分注释/字符串（编辑器的自动闭合也不认这些）；引号只在开启字符串时记，
      // 注释里的那个 ' 我们不认，免得留下一个永远等不到配对的幻影。
      const closer: string | undefined = OPEN_TO_CLOSE[char];
      const isQuote = char === '"' || char === "'";
      if (closer && (!isQuote || modeBefore === 'code')) {
        phantom = closer;
        phantomQuote = isQuote;
      }
    }
  }

  await dropPhantom(false);
  return stats;
}

/** ① 行首硬不变量：光标右侧必须为空，且只允许删闭合符 */
async function clearLineTail(io: TypistIo, stats: TypistStats): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const right = await io.probeRight();
    if (right === null || right === '') return;
    if (!CLOSERS.has(right[0])) return; // 见到字母数字说明探针读到别的行了，立刻停手
    await io.press('Delete');
    stats.cleared += 1;
  }
}

/** ② 缩进归一化：按一下回读一次 */
async function normalizeIndent(io: TypistIo, stats: TypistStats, target: number): Promise<void> {
  for (let guard = 0; guard < MAX_ATTEMPTS; guard += 1) {
    const cursor = await io.probeCursor();
    if (!cursor || cursor.stale) break;
    if (cursor.col <= target) break;
    if (cursor.col > cursor.indent) break; // 光标前面已有正文，宁可不改也不能删
    await io.press('Backspace');
    stats.indentBackspace += 1;
  }

  for (let guard = 0; guard < MAX_ATTEMPTS; guard += 1) {
    const cursor = await io.probeCursor();
    if (!cursor || cursor.stale) break;
    if (cursor.col >= target) break;
    await io.typeChar(' ');
    stats.indentSpace += 1;
  }
}

export function describeTypist(stats: TypistStats): string {
  const parts = [`已逐字敲入 ${stats.lines} 行（${stats.typed} 个字符）`];
  if (stats.skipped > 0) parts.push(`跨过编辑器自动补的右符号 ${stats.skipped} 个`);
  if (stats.erased + stats.cleared > 0) {
    parts.push(`抹掉多余的闭合符 ${stats.erased + stats.cleared} 个`);
  }
  if (stats.indentBackspace + stats.indentSpace > 0) {
    parts.push(`缩进调整 ${stats.indentBackspace + stats.indentSpace} 处`);
  }
  return parts.join('，');
}
