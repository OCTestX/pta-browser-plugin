// 用一个「会自动闭合、会自动缩进」的假编辑器验证 typist 算法：
// 把源码逐字敲进去之后，编辑器里的文本必须与源码逐字一致（这才是「输入干净」）。
// 假编辑器复刻了真实 CodeMirror 的几个关键行为（见 other_pta.md 的坑位清单）：
//   · 敲左括号/引号会自动补右半边
//   · Enter 会把光标右边的内容切到新行，并按前一行自动缩进
//   · 光标停在纯前导空白上时，一次 Backspace 删光整段缩进（不是一格）
// 用法：node scripts/test-typist.mjs
import { describeTypist, runTypist } from '../src/background/typist.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

const OPEN_TO_CLOSE = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
const QUOTES = new Set(['"', "'"]);

/** 假编辑器的语法感知：真实 CodeMirror 用语法树判断引号是开字符串还是闭字符串 */
function createFakeLexer() {
  let mode = 'code';
  let quote = '';
  let escaped = false;
  return {
    /** 这个引号会不会开启一个字符串（也就是编辑器会不会给它补右半边） */
    opensString(char) {
      if (mode !== 'code') return false;
      return QUOTES.has(char);
    },
    step(char, next) {
      if (mode === 'line') return;
      if (mode === 'block') {
        if (char === '*' && next === '/') mode = 'code';
        return;
      }
      if (mode === 'string') {
        if (escaped) {
          escaped = false;
          return;
        }
        if (char === '\\') {
          escaped = true;
          return;
        }
        if (char === quote) mode = 'code';
        return;
      }
      if (char === '/' && next === '/') mode = 'line';
      else if (char === '/' && next === '*') mode = 'block';
      else if (QUOTES.has(char)) {
        mode = 'string';
        quote = char;
      }
    },
    resetLine() {
      if (mode === 'line') mode = 'code';
    },
  };
}

function createFakeEditor({ autoClose = true, indentStep = 2, autoIndent = true } = {}) {
  let lines = [''];
  let line = 0;
  let col = 0;
  const lex = createFakeLexer();

  const current = () => lines[line];
  const leadingOf = (text) => (text.match(/^[ \t]*/) ?? [''])[0].length;

  const io = {
    async typeChar(char) {
      const text = current();
      // 引号只在开启字符串时才补右半边（语法感知），括号一律补
      const closer =
        autoClose && (!QUOTES.has(char) || lex.opensString(char)) ? OPEN_TO_CLOSE[char] : undefined;
      lines[line] = text.slice(0, col) + char + text.slice(col);
      col += 1;
      if (closer) {
        const after = current();
        lines[line] = after.slice(0, col) + closer + after.slice(col);
      }
      lex.step(char, text.slice(col));
    },

    async press(key) {
      const text = current();
      if (key === 'Enter') {
        const left = text.slice(0, col);
        const right = text.slice(col);
        let indent = autoIndent ? leadingOf(left) : 0;
        if (autoIndent && left.trimEnd().endsWith('{')) indent += indentStep;
        lines[line] = left;
        lines.splice(line + 1, 0, ' '.repeat(indent) + right);
        line += 1;
        col = indent;
        lex.resetLine();
        return;
      }
      if (key === 'Backspace') {
        if (col === 0) return;
        const indent = leadingOf(text);
        if (col <= indent) {
          // 光标在纯前导空白上：一次删光整段缩进
          lines[line] = text.slice(indent);
          col = 0;
          return;
        }
        lines[line] = text.slice(0, col - 1) + text.slice(col);
        col -= 1;
        return;
      }
      if (key === 'Delete') {
        lines[line] = text.slice(0, col) + text.slice(col + 1);
        return;
      }
      if (key === 'ArrowRight') {
        col = Math.min(col + 1, current().length);
      }
    },

    async probeRight() {
      return current().slice(col);
    },

    async probeCursor() {
      const text = current();
      return { indent: leadingOf(text), col, stale: col > text.length };
    },

    async delay() {},
  };

  return { io, text: () => lines.join('\n') };
}

const SOURCE = [
  '#include <stdio.h>',
  '',
  'int main() {',
  '  int n = 0;',
  '  scanf("%d", &n);',
  '  if (n > 0) {',
  '    printf("%d\\n", n * 2);',
  '  }',
  '  return 0;',
  '}',
].join('\n');

/* ---------- 1. 编辑器会自动闭合 + 自动缩进 ---------- */

const editor = createFakeEditor();
const stats = await runTypist(editor.io, SOURCE);
check('自动闭合 + 自动缩进下，敲完的内容与源码逐字一致', editor.text() === SOURCE);
check('确实跨过了编辑器自动补的闭合符', stats.skipped > 0);
check('确实抹掉过用不上的闭合符', stats.erased + stats.cleared > 0);
check('确实调整过自动缩进', stats.indentBackspace + stats.indentSpace > 0);
check('统计信息能读出来', describeTypist(stats).includes('已逐字敲入 10 行'));
// 不变量：源码里每个非行首空白的字符，要么被敲进去，要么是跨过编辑器已有的闭合符，不能凭空少掉
const bodyChars = SOURCE.split('\n').reduce(
  (sum, line) => sum + line.length - (line.match(/^ */)?.[0].length ?? 0),
  0,
);
check('源码字符一个不多一个不少', stats.typed + stats.skipped === bodyChars);

/* ---------- 2. 编辑器不自动闭合 ---------- */

const plain = createFakeEditor({ autoClose: false });
const plainStats = await runTypist(plain.io, SOURCE);
check('不自动闭合时结果同样逐字一致', plain.text() === SOURCE);
check('不自动闭合时没有可跨的幻影', plainStats.skipped === 0 && plainStats.erased === 0);

/* ---------- 3. 自动缩进与源码不一致 ---------- */

const weird = createFakeEditor({ indentStep: 4 });
const weirdStats = await runTypist(weird.io, SOURCE);
check('自动缩进比源码深时会被改回来', weird.text() === SOURCE);
check('为此按过 Backspace 修缩进', weirdStats.indentBackspace > 0);

/* ---------- 4. 紧凑代码（一行里多个括号与引号） ---------- */

const tight = createFakeEditor();
const tightSource = 'int main(){printf("hi");return 0;}';
await runTypist(tight.io, tightSource);
check('一行内多个括号引号也能敲对', tight.text() === tightSource);

/* ---------- 5. 引号里带转义与括号 ---------- */

const tricky = createFakeEditor();
const trickySource = ['x = "a\\"b(c";', "c = '\\'';"].join('\n');
await runTypist(tricky.io, trickySource);
check('字符串里的转义引号与括号不会错位', tricky.text() === trickySource);

console.log('\ntypist 校验通过');
