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

  // 题面的「输入样例 / 输出样例」也是 CodeMirror，但是只读的；
  // 只看 contenteditable 不够（它们是 contenteditable="false" + aria-readonly="true"）
  const isEditableElement = (node) => {
    if (!node) return false;
    if (node.getAttribute('aria-readonly') === 'true') return false;
    const attr = node.getAttribute('contenteditable');
    if (attr === 'false') return false;
    return node.isContentEditable || attr === '' || attr === 'true' || attr === 'plaintext-only';
  };

  const findEditorElement = () => {
    const nodes = Array.from(document.querySelectorAll('.cm-content, [contenteditable="true"]'));
    let best = null;
    let bestLength = 0;
    for (const node of nodes) {
      if (!isEditableElement(node)) continue;
      const length = (node.innerText || node.textContent || '').length;
      if (!best || length > bestLength) { best = node; bestLength = length; }
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
      ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return node.tagName.toLowerCase() + id + cls + ' → ' + key;
  };

  // 编辑器实例不在公开 API 上，只能顺着 DOM 摸：PTA 挂在 #pta-answer-editor 的 cmTile.view 上
  const collectEditorViews = () => {
    const starts = ['#pta-answer-editor', '.cm-editor', '.cm-content', '[contenteditable="true"]'];
    const roots = [];
    for (const selector of starts) {
      try { document.querySelectorAll(selector).forEach((el) => roots.push(el)); } catch (e) {}
    }
    const likelyKeys = ['cmTile', 'cmView', 'editorView', 'view', '_view'];
    const skipKeys = new Set(['children', 'parentElement', 'ownerDocument', 'style', 'classList', 'dataset', 'innerHTML']);
    const found = [];
    const seen = new Set();

    const consider = (value, node, path) => {
      if (!looksLikeEditorView(value) || seen.has(value)) return;
      seen.add(value);
      // 找到承载它的可编辑元素（往上下都看一眼）
      let element = node;
      if (!element.classList || !element.classList.contains('cm-content')) {
        element = element.querySelector ? element.querySelector('.cm-content') : null;
      }
      found.push({
        view: value,
        path,
        readOnly: value.state.readOnly === true || (element ? !isEditableElement(element) : false),
        length: String(value.state.doc).length,
      });
    };

    for (const root of roots) {
      for (let node = root; node; node = node.parentElement) {
        for (const key of likelyKeys) {
          let value;
          try { value = node[key]; } catch (e) { continue; }
          if (looksLikeEditorView(value)) consider(value, node, describePath(node, key));
          if (value && typeof value === 'object') {
            for (const subKey of likelyKeys) {
              let inner;
              try { inner = value[subKey]; } catch (e) { continue; }
              if (looksLikeEditorView(inner)) consider(inner, node, describePath(node, key + '.' + subKey));
            }
          }
        }
        for (const key of Object.getOwnPropertyNames(node)) {
          if (skipKeys.has(key) || likelyKeys.includes(key)) continue;
          let value;
          try { value = node[key]; } catch (e) { continue; }
          if (looksLikeEditorView(value)) consider(value, node, describePath(node, key));
        }
      }
    }
    return found;
  };

  // 作答区＝可写的那一个；实在有多个就取内容最长的（作答区通常比样例框长），
  // 都空就取最后一个（DOM 顺序上作答区在样例框后面）
  const pickEditorView = () => {
    const views = collectEditorViews();
    const writable = views.filter((item) => !item.readOnly);
    if (writable.length === 0) return { best: null, readOnlyCount: views.length, writableCount: 0 };
    const best = writable.reduce((a, b) => (b.length > a.length ? b : a));
    return { best, readOnlyCount: views.length - writable.length, writableCount: writable.length };
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


  // ---- 判题与弹窗（提交相关的几条实测经验都写在这里）----

  // 归一化判题文字：顺序即优先级 —— 具体状态排在泛化词前面，
  // 否则「编译错误」会被当成「错误」报成 WA，模型就会一直改算法而不碰那句语法错误
  const judgeStatus = (text) => {
    const value = String(text || '');
    const code = value.match(/\\b(AC|WA|RE|TLE|MLE|CE|PE|OLE)\\b/i);
    if (code) return code[1].toUpperCase();
    const words = [
      ['编译错误', 'CE'],
      ['运行超时', 'TLE'],
      ['内存超限', 'MLE'],
      ['输出超限', 'OLE'],
      ['运行错误', 'RE'],
      ['格式错误', 'PE'],
      ['答案错误', 'WA'],
      ['未通过', '未通过'],
      ['答案正确', 'AC'],
      ['通过', 'AC'],
    ];
    for (const [word, status] of words) {
      if (value.includes(word)) return status;
    }
    return null;
  };

  // jsdom 这类环境没有 innerText，退回 textContent
  const textOf = (node) => ((node && (node.innerText || node.textContent || '')) + '').trim();
  const shortText = (node) => textOf(node).slice(0, 200);
  const buttonLabel = (node) => ((node && (node.innerText || node.textContent || node.value || '')) + '').trim();

  // 判题文字可能挂在弹窗里，也可能直接出现在页面上
  const readJudgeText = () => {
    const containers = ['[class*=judge]', '[class*=result]', '[class*=status]', '[role=alert]', '.el-message', '.ant-message', '[class*=modal]', '[class*=dialog]'];
    const chunks = [];
    for (const selector of containers) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
      for (const node of nodes) {
        const text = shortText(node);
        if (text && text.length < 200) chunks.push(text);
      }
    }
    const joined = chunks.join(' \\n ');
    const matched = judgeStatus(joined);
    if (matched) return { text: joined.slice(0, 400), status: matched };
    // 弹窗里没找到就从整页正文按行捞
    const lines = (document.body.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    const hit = lines.find((line) => judgeStatus(line));
    return { text: hit || joined.slice(0, 400), status: hit ? judgeStatus(hit) : null };
  };

  // 分三级找提交按钮：真按钮精确匹配 → 真按钮包含匹配 → 退到 a/[role=button]/class 含 btn 的元素。
  // 顺序很关键：PTA 登录页上「登录」既是标签页又是提交按钮，按 DOM 顺序点会点到标签页
  const findSubmitButton = () => {
    const labels = ['提交本题作答', '提交答案', '提交', '提交评测', 'Submit'];
    const candidates = [];
    for (const label of labels) {
      for (const node of document.querySelectorAll('button, input[type=submit]')) {
        if (buttonLabel(node) === label) return { node, how: '精确匹配 ' + label };
      }
    }
    for (const label of labels) {
      for (const node of document.querySelectorAll('button, input[type=submit]')) {
        if (buttonLabel(node).includes(label)) candidates.push({ node, how: '包含匹配 ' + label });
      }
    }
    if (candidates.length > 0) return candidates[0];
    for (const label of labels) {
      try {
        const node = Array.from(document.querySelectorAll('a, [role=button], div[class*=btn], span[class*=btn], li, label'))
          .find((el) => textOf(el) === label);
        if (node) return { node, how: '兜底匹配 ' + label };
      } catch (e) {}
    }
    return null;
  };

  // 关弹窗：ESC → 在识别到的弹窗内部找关闭控件 → 点文字按钮 → 点遮罩；最多三轮（关一层常常还压着一层）
  const dismissOverlays = () => {
    let closed = 0;
    const dialogSelectors = ['[class*=modal]', '[class*=dialog]', '[class*=overlay]', '[class*=popup]', '.el-dialog', '.ant-modal'];
    for (let round = 0; round < 3; round++) {
      let did = false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));

      const dialogs = [];
      for (const selector of dialogSelectors) {
        try { document.querySelectorAll(selector).forEach((node) => dialogs.push(node)); } catch (e) {}
      }
      for (const dialog of dialogs) {
        const closers = Array.from(dialog.querySelectorAll('[class*=close], [class*=dismiss], [aria-label*=close i], .pc-close, button'));
        for (const closer of closers) {
          const text = textOf(closer);
          const isTextButton = ['关闭', '确定', '我知道了', '知道了', '取消'].includes(text);
          const looksClose = /close|dismiss/i.test(closer.className || '') || /close/i.test(closer.getAttribute('aria-label') || '');
          if (isTextButton || looksClose) {
            try { closer.click(); closed += 1; did = true; break; } catch (e) {}
          }
        }
        if (did) break;
      }
      if (!did) break;
    }
    return closed;
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
const MARKERS = ['题目描述', '题目背景', '题目要求', '问题描述', '输入格式', '输出格式', '样例输入', '样例输出', '输入样例', '输出样例'];

// 一、先按常见类名找，注意要遍历「所有」匹配：
// 只取第一个匹配的话，第一个元素文本太少就会把整个选择器丢掉（PTA 的考试页就是这样）
const specific = [
  '.problem-content', '.problem-statement', '.pt12-problem-content', '.problem-description',
  '[class*=problem-statement]', '[class*=statement]', '[class*=problem-content]',
];
let hit = null;
for (const selector of specific) {
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
  for (const node of nodes) {
    const text = textOf(node);
    if (text.length > 40 && (!hit || text.length > hit.text.length)) hit = { selector, text };
  }
}

// 二、类名对不上时按小标题定位：同时出现两个以上小标题标记的「最小」容器
if (!hit || hit.text.length < 200) {
  let best = null;
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll('div, section, article, main, form')); } catch (e) {}
  for (const node of nodes) {
    const text = textOf(node);
    if (text.length < 80 || text.length > 30000) continue;
    const marks = MARKERS.filter((m) => text.indexOf(m) >= 0).length;
    if (marks < 2) continue;
    if (!best || marks > best.marks || (marks === best.marks && text.length < best.text.length)) {
      best = { selector: '按小标题定位的容器（含 ' + marks + ' 个小标题）', text, marks };
    }
  }
  if (best) hit = best;
}

let raw = hit ? hit.text : textOf(document.body);
let source = hit ? hit.selector : '整页正文';
if (!hit) {
  // 退到整页正文时，从第一个小标题开始截，把前面的导航和侧栏丢掉
  const positions = MARKERS.map((m) => raw.indexOf(m)).filter((i) => i >= 0);
  if (positions.length > 0) {
    raw = raw.slice(Math.min.apply(null, positions));
    source = '整页正文（只取小标题之后的部分）';
  }
}

// 三、把纯 UI 文案行滤掉
const NOISE = [
  '题目总览', '作答', '题数', '编程题', '图例', 'Toggle Sidebar', '上一题', '下一题',
  '全屏浏览', '切换布局', '复制内容', '格式', '全屏', '题目描述', '我的提交', '提交本题作答', '复制',
];
const lines = raw.split('\\n').map((line) => line.replace(/[ \\t]+$/, '')).filter((line) => {
  const text = line.trim();
  if (!text) return true;
  if (NOISE.indexOf(text) >= 0) return false;
  if (/^当前\\d+\\s*-\\s*\\d+项/.test(text)) return false;
  if (/^\\d+$/.test(text)) return false;
  return true;
});
let text = lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
if (text.length > maxChars) text = text.slice(0, maxChars) + '\\n…（题面过长，已截断）';

// 四、顺手把样例抠出来，模型可以直接拿去当 compile_and_run_c 的 stdin
const blocks = [];
{
  let current = null;
  for (const line of text.split('\\n').map((l) => l.trim())) {
    const isInput = /^(样例\\s*输入|输入样例|示例\\s*\\d*\\s*的?输入|sample\\s*input)/i.test(line);
    const isOutput = /^(样例\\s*输出|输出样例|示例\\s*\\d*\\s*的?输出|sample\\s*output)/i.test(line);
    if (isInput || isOutput) {
      current = { kind: isInput ? 'in' : 'out', lines: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (MARKERS.some((marker) => line.indexOf(marker) === 0)) { current = null; continue; }
    if (/^(复制|Copy)$/i.test(line)) continue;
    current.lines.push(line);
  }
}
const pairs = [];
let pendingInput = null;
for (const block of blocks) {
  const body = block.lines.join('\\n').trim();
  if (block.kind === 'in') {
    pendingInput = { input: body, output: '' };
  } else if (pendingInput) {
    pendingInput.output = body;
    pairs.push(pendingInput);
    pendingInput = null;
  }
}

const title = (document.title || textOf(document.querySelector('h1')) || '').trim();
const idMatch = location.pathname.match(/\\/(\\d{6,})/);
const out = ['题目：' + (title || '（没取到标题）'), '地址：' + location.href];
if (idMatch) out.push('题目 ID：' + idMatch[1]);
if (pairs.length > 0) {
  out.push('', '样例（共 ' + pairs.length + ' 组，可以直接当 compile_and_run_c 的 stdin）：');
  pairs.slice(0, 5).forEach((pair, index) => {
    out.push('样例 ' + (index + 1) + ' 输入：' + fence + '\\n' + (pair.input || '（空）') + '\\n' + fence);
    out.push('样例 ' + (index + 1) + ' 输出：' + fence + '\\n' + (pair.output || '（空）') + '\\n' + fence);
  });
}
out.push('', '题面（来源：' + source + '，' + text.length + ' 字）：', text);
return out.join('\\n');
`;

/** 读作答区里的代码 */
export const READ_EDITOR_SCRIPT = `${HELPERS}
const picked = pickEditorView();
if (picked.best) {
  const code = picked.best.view.state.doc.toString();
  return '作答区（' + picked.best.path + '）读到完整文档（' + picked.best.view.state.doc.lines + ' 行，' + code.length + ' 字符）：\\n' + fence + '\\n' + code + '\\n' + fence;
}
if (picked.readOnlyCount > 0) {
  return '页面上只找到 ' + picked.readOnlyCount + ' 个只读编辑器（是题面的样例框，不是作答区），没找到可写的作答区';
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

const picked = pickEditorView();
if (!picked.best) {
  if (picked.readOnlyCount > 0) {
    return '页面上只有 ' + picked.readOnlyCount + ' 个只读编辑器（题面的样例框），没找到可写的作答区，写不进去';
  }
} else {
  const view = picked.best.view;
  if (view.state.readOnly) return '作答区是只读的，写不进去';
  const length = view.state.doc.length;
  const changes = clear || length === 0
    ? { from: 0, to: length, insert: code }
    : { from: length, to: length, insert: (view.state.doc.toString().endsWith('\\n') ? '' : '\\n') + code };
  view.dispatch({ changes });
  // 把光标放到文末：一是用户接手时位置正常，二是后面用真实按键「戳一下」时不会插到代码中间
  view.dispatch({ selection: { anchor: view.state.doc.length } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const after = view.state.doc.toString();
  return '已通过编辑器实例（' + picked.best.path + '）' + (clear ? '整段覆写' : '追加') + ' ' + code.split('\\n').length + ' 行。' + compareText(code, after);
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

/** 提交作答并等判题结论 */
export const SUBMIT_ANSWER_SCRIPT = `${HELPERS}
const waitSeconds = Math.min(Math.max(Number(__args.waitSeconds) || 20, 5), 120);
const pollMs = Math.min(Math.max(Number(__args.pollMs) || 2000, 10), 5000);

// 先读一次旧结论、关掉上一次留下的弹窗：弹窗盖着编辑器和提交按钮，不关掉点不到
const before = readJudgeText();
const closed = dismissOverlays();

const found = findSubmitButton();
if (!found) {
  return '没找到提交按钮。可用按钮：' + Array.from(document.querySelectorAll('button'))
    .map((b) => textOf(b)).filter(Boolean).slice(0, 20).join(' / ');
}
if (found.node.scrollIntoView) found.node.scrollIntoView({ block: 'center' });
found.node.click();

const deadline = Date.now() + waitSeconds * 1000;
let latest = { text: '', status: null };
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  const now = readJudgeText();
  latest = now;
  // 结论要同时满足：文字非空 ∧ 与提交前不同 ∧ 能归一化成状态码
  // （只看「变了」会把「评测中」当成结论，然后把还在评测的弹窗关掉，这次结果永远等不到）
  if (now.status && now.text && now.text !== before.text) {
    return '已点击提交（' + found.how + (closed ? '，先关掉了 ' + closed + ' 层弹窗' : '') + '）。\\n判题结论：' + now.status + '\\n原文：' + now.text.slice(0, 300);
  }
}

return '已点击提交（' + found.how + '）。\\n等了 ' + waitSeconds + ' 秒还没出结论，当前页面上看到的是：' + (latest.text || '（没读到判题文字）') + '\\n可以稍后再调 read_judge_result 看结果（拿到结论之前不要关弹窗）。';
`;

/** 读当前判题结果（不点任何东西） */
export const READ_JUDGE_SCRIPT = `${HELPERS}
const now = readJudgeText();
if (!now.text) return '页面上没读到判题文字（可能还没有提交过，或者弹窗已经关了）';
return (now.status ? '判题结论：' + now.status + '\\n' : '还没出结论（或读到的不是结论）。\\n') + '原文：' + now.text.slice(0, 400);
`;

/** 关掉挡在前面的弹窗 */
export const CLOSE_DIALOGS_SCRIPT = `${HELPERS}
const closed = dismissOverlays();
return closed > 0 ? '已关掉 ' + closed + ' 层弹窗' : '没找到需要关的弹窗';
`;
