/**
 * PTA 页面上的三个动作脚本，都在**页面主世界**执行（编辑器实例挂在页面自己的 JS 对象上，
 * 隔离世界看不到）。参数通过 __args 注入，脚本里 return 的值会被序列化回 background。
 *
 * 思路取自同行实践（项目里的 other_pta.md）：
 *   · 题面按容器优先级抠，一个都没命中就退到整页正文 —— 宁可读得糙，不能读不到，且不抛异常
 *   · 作答区是 CodeMirror 6，优先走编辑器实例读写（读得到全文，写是原子的），
 *     拿不到实例才退回 DOM（DOM 只能读到渲染出来的行，长文档会缺）
 */

const HELPERS = `
  // 模板字符串里写不了裸的三反引号，用它拼代码块围栏
  const fence = String.fromCharCode(96).repeat(3);

  const findEditorElement = () => {
    const nodes = Array.from(document.querySelectorAll('.cm-content, [contenteditable="true"]'));
    let best = null;
    let bestLength = 0;
    for (const el of nodes) {
      const editable = el.isContentEditable || (() => {
        const attr = el.getAttribute('contenteditable');
        return attr === '' || attr === 'true' || attr === 'plaintext-only';
      })();
      if (!editable) continue;
      const length = (el.innerText || el.textContent || '').length;
      if (!best || length > bestLength) { best = el; bestLength = length; }
    }
    return best;
  };

  const looksLikeEditorView = (value) => !!value
    && typeof value.dispatch === 'function'
    && value.state && value.state.doc
    && typeof value.state.doc.toString === 'function';

  const describePath = (node, key) => {
    const id = node.id ? '#' + node.id : '';
    const cls = typeof node.className === 'string' && node.className.trim()
      ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    return node.tagName.toLowerCase() + id + cls + ' → ' + key;
  };

  // 编辑器实例不在公开 API 上，只能顺着 DOM 摸过去；
  // PTA 是挂成 #pta-answer-editor 的 cmTile.view
  const findEditorView = () => {
    const starts = ['#pta-answer-editor', '.cm-editor', '.cm-content', '[contenteditable="true"]'];
    const roots = [];
    for (const selector of starts) {
      try { document.querySelectorAll(selector).forEach((el) => roots.push(el)); } catch (e) {}
    }
    const likelyKeys = ['cmTile', 'cmView', 'editorView', 'view', '_view'];
    const skipKeys = new Set(['children', 'parentElement', 'ownerDocument', 'style', 'classList', 'dataset', 'innerHTML']);

    for (const root of roots) {
      for (let node = root; node; node = node.parentElement) {
        for (const key of likelyKeys) {
          let value;
          try { value = node[key]; } catch (e) { continue; }
          if (looksLikeEditorView(value)) return { view: value, path: describePath(node, key) };
          if (value && typeof value === 'object') {
            for (const subKey of likelyKeys) {
              let inner;
              try { inner = value[subKey]; } catch (e) { continue; }
              if (looksLikeEditorView(inner)) {
                return { view: inner, path: describePath(node, key + '.' + subKey) };
              }
            }
          }
        }
        // 兜底：扫一遍自身属性（跳过明显重的），只在这一层做，避免递归太深
        for (const key of Object.getOwnPropertyNames(node)) {
          if (skipKeys.has(key) || likelyKeys.includes(key)) continue;
          let value;
          try { value = node[key]; } catch (e) { continue; }
          if (looksLikeEditorView(value)) return { view: value, path: describePath(node, key) };
        }
      }
    }
    return null;
  };

  // DOM 退路：CodeMirror 只渲染视口附近的行，长文档会读缺
  const readFromDom = (element) => {
    const lines = Array.from(element.querySelectorAll('.cm-line')).map((n) => n.textContent || '');
    return lines.length > 0 ? lines.join('\\n') : (element.textContent || '');
  };

  const normalizeLines = (value) => {
    const lines = String(value).replace(/\\r\\n/g, '\\n').split('\\n').map((l) => l.replace(/[ \\t]+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  // 回读比对：尾部空白与末尾空行不算差异
  const compareText = (expected, actual) => {
    const want = normalizeLines(expected);
    const got = normalizeLines(actual);
    const mismatch = want.findIndex((line, index) => line !== (got[index] === undefined ? '\\u0000' : got[index]));
    if (mismatch === -1 && want.length === got.length) return '回读比对：' + want.length + ' 行与目标一致';
    const at = mismatch === -1 ? Math.min(want.length, got.length) : mismatch;
    const brief = (line) => line === undefined ? '（没有这一行）' : (line.length > 40 ? line.slice(0, 40) + '…' : line);
    return '回读比对：与目标不一致（第 ' + (at + 1) + ' 行起），期望「' + brief(want[at]) + '」，实际「' + brief(got[at]) + '」';
  };
`;

/** 定位并抠出题面 */
export const READ_PROBLEM_SCRIPT = `${HELPERS}
const maxChars = typeof __args.maxChars === 'number' ? __args.maxChars : 6000;
const containers = ['.problem-content', '.problem-statement', '.pt12-problem-content', '[class*=problem]', '[class*=statement]'];
// innerText 是渲染后的文本（优先），个别环境没实现就退回 textContent
const textOf = (node) => ((node && (node.innerText || node.textContent)) || '').trim();
let hit = null;
for (const selector of containers) {
  let node = null;
  try { node = document.querySelector(selector); } catch (e) { continue; }
  const text = textOf(node);
  if (text.length > 40) { hit = { selector, text }; break; }
}
const raw = hit ? hit.text : textOf(document.body);
const text = raw.length > maxChars ? raw.slice(0, maxChars) + '\\n…（题面过长，已截断）' : raw;
const title = (document.title || textOf(document.querySelector('h1')) || '').trim();
const idMatch = location.pathname.match(/\\/(\\d{6,})/);
const lines = ['题目：' + (title || '（没取到标题）'), '地址：' + location.href];
if (idMatch) lines.push('题目 ID：' + idMatch[1]);
lines.push('', '题面（来源：' + (hit ? hit.selector : '整页正文（没命中题目容器）') + '，共 ' + raw.length + ' 字）：', text);
return lines.join('\\n');
`;

/** 读作答区里的代码 */
export const READ_EDITOR_SCRIPT = `${HELPERS}
const found = findEditorView();
if (found) {
  const code = found.view.state.doc.toString();
  return '编辑器实例：' + found.path + '\\n读到完整文档（' + found.view.state.doc.lines + ' 行，' + code.length + ' 字符）：\\n' + fence + '\\n' + code + '\\n' + fence;
}
const element = findEditorElement();
if (!element) return '页面上没找到作答区（既没有编辑器实例，也没有可编辑区域）';
const code = readFromDom(element);
return '没拿到编辑器实例，只能按 DOM 读渲染出来的 ' + code.split('\\n').length + ' 行（长文档会缺行）：\\n' + fence + '\\n' + code + '\\n' + fence;
`;

/** 覆写作答区里的代码 */
export const WRITE_EDITOR_SCRIPT = `${HELPERS}
const code = String(__args.code === undefined ? '' : __args.code);
if (!code.trim()) return '没有给 code 参数';
const clear = __args.clear !== false;

const found = findEditorView();
if (found) {
  const view = found.view;
  if (view.state.readOnly) return '编辑器是只读的，写不进去';
  const length = view.state.doc.length;
  const changes = clear || length === 0
    ? { from: 0, to: length, insert: code }
    : { from: length, to: length, insert: (view.state.doc.toString().endsWith('\\n') ? '' : '\\n') + code };
  view.dispatch({ changes });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = view.state.doc.toString();
  return '已通过编辑器实例（' + found.path + '）' + (clear ? '覆写' : '追加') + ' ' + code.split('\\n').length + ' 行。' + compareText(code, after);
}

// 退路：拿不到实例就聚焦后整段插入（整段插入不会触发逐字符的自动闭合）
const element = findEditorElement();
if (!element) return '页面上没找到作答区，也没拿到编辑器实例';
element.focus();
const selection = document.getSelection();
if (selection) {
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}
let inserted = false;
try { inserted = document.execCommand('insertText', false, code); } catch (e) { inserted = false; }
await new Promise((resolve) => setTimeout(resolve, 200));
const after = readFromDom(element);
const route = inserted ? '已聚焦后整段插入' : 'execCommand 不可用，未能写入';
return route + '（没拿到编辑器实例），' + compareText(code, after);
`;
