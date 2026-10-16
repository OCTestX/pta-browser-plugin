/**
 * 逐行比较两段文本，给「左右两列 + 颜色」的差异视图用。
 *
 * 为什么要自己算：浏览器没有内置 diff，diff 库又只按整块文本处理，
 * 而这里要的是「哪一行新增 / 改过 / 删掉」——正好对应代码改动里最该被看见的那三件事。
 *
 * 算法：先掐掉公共前后缀（改一行代码时中间往往只剩一两行，DP 规模一下就小了），
 * 中间部分用 LCS 动态规划求最长公共子序列，再把「连续删除 + 连续新增」配对成「修改」。
 */

export type DiffRowType = 'equal' | 'add' | 'del' | 'mod';

export interface DiffRow {
  type: DiffRowType;
  left?: string;
  right?: string;
  /** 左右两列各自的行号（1 起） */
  leftNo?: number;
  rightNo?: number;
}

/**
 * 按行拆：空字符串是「没有内容」（0 行），不是「一行空的」；
 * 结尾那个换行也不该算成多出来的一行（代码文件基本都以换行结尾）。
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** LCS 动态规划的规模上限：超过就退化成「整体删除 + 整体新增」，别把界面卡住 */
const MAX_DP_CELLS = 600 * 600;

export function diffLines(before: string, after: string): DiffRow[] {
  const left = splitLines(before);
  const right = splitLines(after);

  let head = 0;
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1;

  let tail = 0;
  while (
    tail < left.length - head &&
    tail < right.length - head &&
    left[left.length - 1 - tail] === right[right.length - 1 - tail]
  ) {
    tail += 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i += 1) rows.push({ type: 'equal', left: left[i], right: right[i], leftNo: i + 1, rightNo: i + 1 });

  const midLeft = left.slice(head, left.length - tail);
  const midRight = right.slice(head, right.length - tail);
  const baseLeft = head;
  const baseRight = head;

  if (midLeft.length * midRight.length > MAX_DP_CELLS) {
    // 改动规模太大，逐行算不动：中间整体当作删除 + 新增
    for (let i = 0; i < midLeft.length; i += 1) {
      rows.push({ type: 'del', left: midLeft[i], leftNo: baseLeft + i + 1 });
    }
    for (let i = 0; i < midRight.length; i += 1) {
      rows.push({ type: 'add', right: midRight[i], rightNo: baseRight + i + 1 });
    }
  } else {
    rows.push(...middleDiff(midLeft, midRight, baseLeft, baseRight));
  }

  for (let i = 0; i < tail; i += 1) {
    const leftIndex = left.length - tail + i;
    const rightIndex = right.length - tail + i;
    rows.push({
      type: 'equal',
      left: left[leftIndex],
      right: right[rightIndex],
      leftNo: leftIndex + 1,
      rightNo: rightIndex + 1,
    });
  }

  return rows;
}

/** 中间那段：LCS 求公共行，再把先删后增的连续块两两配成「修改」 */
function middleDiff(
  left: string[],
  right: string[],
  baseLeft: number,
  baseRight: number,
): DiffRow[] {
  const n = left.length;
  const m = right.length;
  const table = lcsTable(left, right);

  const raw: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      raw.push({ type: 'equal', left: left[i], right: right[j], leftNo: baseLeft + i + 1, rightNo: baseRight + j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
      raw.push({ type: 'del', left: left[i], leftNo: baseLeft + i + 1 });
      i += 1;
    } else {
      raw.push({ type: 'add', right: right[j], rightNo: baseRight + j + 1 });
      j += 1;
    }
  }
  while (i < n) {
    raw.push({ type: 'del', left: left[i], leftNo: baseLeft + i + 1 });
    i += 1;
  }
  while (j < m) {
    raw.push({ type: 'add', right: right[j], rightNo: baseRight + j + 1 });
    j += 1;
  }

  // 连续的「删除 + 新增」配对成「修改」，左右同行显示
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < raw.length) {
    if (raw[k].type === 'del') {
      let delCount = 0;
      let addCount = 0;
      while (k + delCount < raw.length && raw[k + delCount].type === 'del') delCount += 1;
      while (k + delCount + addCount < raw.length && raw[k + delCount + addCount].type === 'add') addCount += 1;

      const pairs = Math.min(delCount, addCount);
      for (let p = 0; p < pairs; p += 1) {
        const removed = raw[k + p];
        const added = raw[k + delCount + p];
        rows.push({
          type: 'mod',
          left: removed.left,
          right: added.right,
          leftNo: removed.leftNo,
          rightNo: added.rightNo,
        });
      }
      for (let p = pairs; p < delCount; p += 1) rows.push(raw[k + p]);
      for (let p = pairs; p < addCount; p += 1) rows.push(raw[k + delCount + p]);
      k += delCount + addCount;
      continue;
    }
    rows.push(raw[k]);
    k += 1;
  }

  return rows;
}

/** 差异统计，工具结果与界面上都要用 */
export function diffStats(rows: DiffRow[]): { added: number; removed: number; changed: number } {
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const row of rows) {
    if (row.type === 'add') added += 1;
    else if (row.type === 'del') removed += 1;
    else if (row.type === 'mod') changed += 1;
  }
  return { added, removed, changed };
}

/** 差异视图的一段：改动块（hunk）或没动的上下文（context） */
export interface DiffSegment {
  kind: 'hunk' | 'context';
  rows: DiffRow[];
}

/**
 * 把差异行切成「改动块 / 上下文」交替的段。
 * 界面靠它把改动聚成一团：中间那条道上的箭头只画在 hunk 的头尾，两块改动之间是灰掉的上下文。
 */
export function segmentDiff(rows: DiffRow[]): DiffSegment[] {
  const segments: DiffSegment[] = [];
  let current: DiffSegment | null = null;

  for (const row of rows) {
    const kind: DiffSegment['kind'] = row.type === 'equal' ? 'context' : 'hunk';
    if (!current || current.kind !== kind) {
      current = { kind, rows: [] };
      segments.push(current);
    }
    current.rows.push(row);
  }
  return segments;
}

/** 行内被改动的那几个词/符号，界面用深色底标出来（IDEA 就是这么标行内差异的） */
export interface DiffPart {
  text: string;
  changed: boolean;
}

/** 把一行拆成词：标识符、数字、运算符各自成段，行内比对才有意义 */
function tokenizeLine(line: string): string[] {
  return line.match(/[A-Za-z_][A-Za-z0-9_]*|\d+|\s+|./g) ?? [line];
}

/**
 * 配对的两行做词级比对：左边的 changed 段是「被改掉的」，右边是「新写的」。
 * 例如 scanf("%d", a); → scanf("%d", &a); 只有 & 被标出来。
 */
export function markWordChanges(before: string, after: string): { left: DiffPart[]; right: DiffPart[] } {
  const leftTokens = tokenizeLine(before);
  const rightTokens = tokenizeLine(after);

  const table = lcsTable(leftTokens, rightTokens);
  const ops: { token: string; side: 'left' | 'right' | 'both' }[] = [];
  let i = 0;
  let j = 0;
  while (i < leftTokens.length && j < rightTokens.length) {
    if (leftTokens[i] === rightTokens[j]) {
      ops.push({ token: leftTokens[i], side: 'both' });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * (rightTokens.length + 1) + j] >= table[i * (rightTokens.length + 1) + j + 1]) {
      ops.push({ token: leftTokens[i], side: 'left' });
      i += 1;
    } else {
      ops.push({ token: rightTokens[j], side: 'right' });
      j += 1;
    }
  }
  while (i < leftTokens.length) {
    ops.push({ token: leftTokens[i], side: 'left' });
    i += 1;
  }
  while (j < rightTokens.length) {
    ops.push({ token: rightTokens[j], side: 'right' });
    j += 1;
  }

  // 整行都被重写时，词级高亮会把大半个句子涂满，反而看不清；交给整行的红/蓝底去表达
  const changedCount = ops.filter((op) => op.side !== 'both').length;
  if (ops.length > 0 && changedCount / ops.length > 0.6) {
    return {
      left: [{ text: before, changed: false }],
      right: [{ text: after, changed: false }],
    };
  }

  const left: DiffPart[] = [];
  const right: DiffPart[] = [];
  for (const op of ops) {
    if (op.side !== 'right') push(left, op.token, op.side === 'left');
    if (op.side !== 'left') push(right, op.token, op.side === 'right');
  }
  return { left, right };
}

function push(parts: DiffPart[], text: string, changed: boolean): void {
  const last = parts[parts.length - 1];
  if (last && last.changed === changed) last.text += text;
  else parts.push({ text, changed });
}

/** 最长公共子序列长度表：table[i * (m + 1) + j] = a[i..] 与 b[j..] 的 LCS 长度 */
function lcsTable(a: string[], b: string[]): Int32Array {
  const width = b.length + 1;
  const table = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  return table;
}
