/**
 * PTA 页面上执行的脚本集合（都在页面主世界跑，通过 background/input-methods 或 injectScript 注入）。
 *
 * 注意：这些脚本是模板字符串，里面的 `\n` 之类的转义要写成双反斜杠；
 * 另外模板字符串里写不了裸的三反引号，用 fence 变量拼代码块围栏。
 */

const HELPERS = `
  // 模板字符串里写不了裸的三反引号，用它拼代码块围栏
  const fence = String.fromCharCode(96).repeat(3);

  // jsdom 这类环境没有 innerText，退回 textContent
  const textOf = (node) => ((node && (node.innerText || node.textContent || '')) + '').trim();

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
      ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
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
              if (looksLikeEditorView(inner)) {
                consider(inner, node, describePath(node, key + '.' + subKey));
              }
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

  // 作答区＝可写的那一个；实在有多个就取内容最长的，都空就取最后一个
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

  // 页面弹的提示（比如「禁止粘贴」）：让测试结果能看出是不是被页面拦了
  const findPageNotice = () => {
    const patterns = ['禁止粘贴', '禁止复制', '不允许粘贴', '不能粘贴', '请勿粘贴'];
    const nodes = Array.from(document.querySelectorAll('[role=alert], [class*=message], [class*=toast], [class*=notice], [class*=tips], body > div'));
    for (const node of nodes) {
      const text = shortText(node);
      if (!text || text.length > 120) continue;
      if (patterns.some((pattern) => text.indexOf(pattern) >= 0)) return text;
    }
    return '';
  };

  const shortText = (node) => textOf(node).slice(0, 200);
  const buttonLabel = (node) => ((node && (node.innerText || node.textContent || node.value || '')) + '').trim();

  // 用户点「停止」时后台会往页面里置这个标记，轮询循环靠它退出（executeScript 撤不回来）
  const aborted = () => globalThis.__ptaAborted === true;

  // 可被「停止」打断的等待：最多 100ms 一醒，醒来先看取消标记
  const sleepOrAbort = (ms) => new Promise((resolve) => {
    if (aborted()) { resolve(); return; }
    const deadline = Date.now() + ms;
    const wake = () => {
      if (aborted() || Date.now() >= deadline) { resolve(); return; }
      setTimeout(wake, Math.min(100, Math.max(deadline - Date.now(), 0)));
    };
    wake();
  });

  const normalizeLines = (value) => {
    const lines = String(value).replace(/\\r\\n/g, '\\n').split('\\n').map((l) => l.replace(/[ \\t]+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };

  // ---- 判题（提交相关的几条实测经验都写在这里）----

  // 判题结论词表：顺序即优先级 —— 具体状态排在泛化词前面，
  // 否则「编译错误」会被当成「错误」报成 WA，模型就会一直改算法而不碰那句语法错误。
  //
  // 「部分正确」必须排在所有正向词前面：PTA 的部分得分弹窗里常同时出现
  // 「部分正确」和「通过测试点 6/10」，只认泛化的「通过」就会把部分正确误报成 AC，
  // 模型以为整题都对、交卷就完事了（这题还没拿满分）。
  const JUDGE_WORDS = [
    ['部分正确', 'PC'],
    ['部分得分', 'PC'],
    ['部分通过', 'PC'],
    ['partial correct', 'PC'],
    ['编译错误', 'CE'],
    ['运行超时', 'TLE'],
    ['内存超限', 'MLE'],
    ['输出超限', 'OLE'],
    ['运行错误', 'RE'],
    ['格式错误', 'PE'],
    ['答案错误', 'WA'],
    ['未通过', '未通过'],
    ['答案正确', 'AC'],
  ];

  // 「通过」太泛：PTA 会在结论旁边写「通过测试点 6/10」「通过率 60%」，
  // 这些是在说统计，不是在说结论。只有真正在讲结论的「通过」才算 AC。
  const isVerdictPass = (value) => {
    const hit = /(?<![未不非部])通过(?![率测的])/.exec(value);
    return Boolean(hit);
  };

  // 归一化判题文字，并给出优先级（rank 越小越具体）：跨容器挑结论时按 rank 取最好的那个
  const judgeHit = (text) => {
    const value = String(text || '');
    const code = value.match(/\\b(AC|WA|RE|TLE|MLE|CE|PE|OLE)\\b/i);
    // 字母状态码比「通过」「答案正确」这类泛化中文词可信，但不如「部分正确」「编译错误」具体
    if (code) return { status: code[1].toUpperCase(), rank: 5 };
    const lower = value.toLowerCase();
    for (let index = 0; index < JUDGE_WORDS.length; index += 1) {
      if (lower.includes(JUDGE_WORDS[index][0])) return { status: JUDGE_WORDS[index][1], rank: 10 + index };
    }
    if (isVerdictPass(value)) return { status: 'AC', rank: 30 };
    return null;
  };

  // 判题文字可能挂在弹窗里，也可能直接出现在页面上。
  // 一条一条地判再按优先级取最好的那个：把多个容器拼成一大段再匹配会先撞上谁算谁
  // （实测把「部分正确 通过测试点 6/10」报成了 AC）。
  const readJudgeText = () => {
    const containers = ['[class*=judge]', '[class*=result]', '[class*=status]', '[role=alert]', '.el-message', '.ant-message', '[class*=modal]', '[class*=dialog]'];
    const chunks = [];
    let best = null;
    for (const selector of containers) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
      for (const node of nodes) {
        const text = shortText(node);
        if (!text || text.length >= 200) continue;
        chunks.push(text);
        const hit = judgeHit(text);
        if (hit && (!best || hit.rank < best.rank)) best = { text, status: hit.status };
      }
    }
    if (best) return { text: best.text.slice(0, 400), status: best.status };

    const lines = (document.body.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const hit = judgeHit(line);
      if (hit) return { text: line.slice(0, 400), status: hit.status };
    }
    // 没有结论也把看到的中间状态带回去（评测中/排队中），调用方要靠它判断「变了没有」
    return { text: chunks.join(' \\n ').slice(0, 400), status: null };
  };

  // 判题弹窗随时可能被用户关掉，一关掉 DOM 上就再也读不到了 —— 而模型往往是在弹窗消失之后才来读结果的。
  // 所以把每次读到的判题文字记在页面全局里，并且挂一个观察器持续更新，弹窗没了还能回看最后一次见到的结论。
  const rememberJudge = (now) => {
    if (now && now.text) globalThis.__ptaJudgeSnapshot = { text: now.text, status: now.status, at: Date.now() };
    return now;
  };

  const watchJudge = () => {
    if (globalThis.__ptaJudgeWatch) return;
    globalThis.__ptaJudgeWatch = true;
    let trailing = 0;
    const observer = new MutationObserver(() => {
      // 一串 DOM 变化的开头立刻读一次，不能被防抖挡住：判题结论可能只活几十毫秒
      // 就被下一次渲染或关弹窗顶掉，漏读会让快照里留着上一次的旧结论（错报比不报更糟）
      try { rememberJudge(readJudgeText()); } catch (e) {}
      // 尾部再补一次读，把这一串变化收尾后的状态也记上
      if (trailing) return;
      trailing = setTimeout(() => { trailing = 0; try { rememberJudge(readJudgeText()); } catch (e) {} }, 300);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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

  // 关弹窗：ESC → 在识别到的弹窗内部找关闭控件 → 点文字按钮；最多三轮（关一层常常还压着一层）
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

  // 回读比对：尾部空白与末尾空行不算差异。结构化返回，文本在调用方拼
  const compareText = (expected, actual) => {
    const want = normalizeLines(expected);
    const got = normalizeLines(actual);
    const mismatch = want.findIndex((line, index) => line !== (got[index] === undefined ? '\\u0000' : got[index]));
    if (mismatch === -1 && want.length === got.length) {
      return { ok: true, detail: '回读比对：' + want.length + ' 行与目标一致' };
    }
    const at = mismatch === -1 ? Math.min(want.length, got.length) : mismatch;
    const brief = (line) => line === undefined ? '（没有这一行）' : (line.length > 40 ? line.slice(0, 40) + '…' : line);
    return {
      ok: false,
      detail: '回读比对：与目标不一致（第 ' + (at + 1) + ' 行起），期望「' + brief(want[at]) + '」，实际「' + brief(got[at]) + '」',
    };
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

// 三、把纯 UI 文案行滤掉。注意不能按「纯数字行」过滤 —— 样例输出经常就是一行数字（比如 "7"），
// 会连带把样例答案删掉；侧栏题号在按容器/小标题定位时本来就被排除在外了
const NOISE = [
  '题目总览', '作答', '题数', '编程题', '图例', 'Toggle Sidebar', '上一题', '下一题',
  '全屏浏览', '切换布局', '复制内容', '格式', '全屏', '题目描述', '我的提交', '提交本题作答', '复制',
];
const lines = raw.split('\\n').map((line) => line.replace(/[ \\t]+$/, '')).filter((line) => {
  const value = line.trim();
  if (!value) return true;
  if (NOISE.indexOf(value) >= 0) return false;
  if (/^当前\\d+\\s*-\\s*\\d+项/.test(value)) return false;
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

// 只取样例：给 write_editor_code 的自动检查用，返回结构化数据
if (__args.samplesOnly === true) {
  return { title, url: location.href, samples: pairs };
}

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

/** 提交作答并等判题结论 */
export const SUBMIT_ANSWER_SCRIPT = `${HELPERS}
const waitSeconds = Math.min(Math.max(Number(__args.waitSeconds) || 20, 5), 120);
const pollMs = Math.min(Math.max(Number(__args.pollMs) || 2000, 10), 5000);

// 边提交边记快照：判题弹窗一旦被关掉，DOM 上就再也读不到这次的结论了
watchJudge();

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
// 上一次提交留下的结论不能当成这一次的：清掉快照，重新记这次的
globalThis.__ptaJudgeSnapshot = null;

const deadline = Date.now() + waitSeconds * 1000;
let latest = { text: '', status: null };
while (Date.now() < deadline) {
  await sleepOrAbort(pollMs);
  if (aborted()) return '已按用户要求停止等待判题结论';
  const now = rememberJudge(readJudgeText());
  latest = now;
  // 结论要同时满足：文字非空 ∧ 与提交前不同 ∧ 能归一化成状态码
  // （只看「变了」会把「评测中」当成结论，然后把还在评测的弹窗关掉，这次结果永远等不到）
  if (now.status && now.text && now.text !== before.text) {
    return '已点击提交（' + found.how + (closed ? '，先关掉了 ' + closed + ' 层弹窗' : '') + '）。\\n判题结论：' + now.status + '\\n原文：' + now.text.slice(0, 300);
  }
}

return '已点击提交（' + found.how + '）。\\n等了 ' + waitSeconds + ' 秒还没出结论，当前页面上看到的是：' + (latest.text || '（没读到判题文字）') + '\\n可以稍后再调 read_judge_result 看结果（拿到结论之前不要关弹窗）。';
`;

/**
 * 读当前判题结果（不点任何东西），一直读到能归一化成状态码的结论为止。
 *
 * 为什么不只读一次：PTA 的结论是在弹窗里逐字蹦出来的，模型在提交后隔几秒才调这个工具很常见，
 * 读一次只会得到「评测中」。而且用户完全可能在结论出来之后、模型来读之前就把弹窗关掉 ——
 * 这时 DOM 上什么都不剩，所以这里既能实时轮询，也能回看页面上留着的判题快照。
 */
export const READ_JUDGE_SCRIPT = `${HELPERS}
// 注意 Number(x) || 60 这种写法会把显式传的 0 当成没传，这里老老实实判断
const askedWait = Number(__args.waitSeconds);
const waitSeconds = Math.min(Math.max(Number.isFinite(askedWait) ? askedWait : 60, 0), 120);
const askedPoll = Number(__args.pollMs);
const pollMs = Math.min(Math.max(Number.isFinite(askedPoll) ? askedPoll : 300, 50), 5000);

watchJudge();

const describe = (hit, source) => {
  const head = hit.status ? '判题结论：' + hit.status + '\\n' : '还没出结论（页面上只有中间状态）。\\n';
  return head + source + '原文：' + hit.text.slice(0, 400);
};

const deadline = Date.now() + waitSeconds * 1000;
let latest = rememberJudge(readJudgeText());
if (latest.status && latest.text) return describe(latest, '');

// 快照只在「弹窗已经不在页面上了」时才用来兜底：页面上还有判题文字就说明这次还在评测，
// 这时返回上一条旧结论比不返回更糟
const snapshot = globalThis.__ptaJudgeSnapshot;
if (!latest.text && snapshot && snapshot.status && snapshot.text) {
  return describe(snapshot, '（判题弹窗现在不在页面上了，这是页面留下的判题记录）\\n');
}

while (Date.now() < deadline) {
  await sleepOrAbort(pollMs);
  if (aborted()) {
    return '已按用户要求停止等待判题结论。停止前页面上看到的是：' + (latest.text || '（没读到判题文字）');
  }
  latest = rememberJudge(readJudgeText());
  if (latest.status && latest.text) return describe(latest, '');
  // 弹窗在等待过程中被关掉了：改用快照收尾，别再空等
  if (!latest.text) {
    const late = globalThis.__ptaJudgeSnapshot;
    if (late && late.status && late.text) {
      return describe(late, '（判题弹窗在等待过程中被关掉了，这是页面留下的判题记录）\\n');
    }
  }
}

return '等了 ' + waitSeconds + ' 秒还没读到能归一化成状态码的判题结论。\\n页面上现在看到的是：' + (latest.text || '（没读到判题文字，弹窗可能已经被关掉了）');
`;

/** 关掉挡在前面的弹窗 */
export const CLOSE_DIALOGS_SCRIPT = `${HELPERS}
const closed = dismissOverlays();
return closed > 0 ? '已关掉 ' + closed + ' 层弹窗' : '没找到需要关的弹窗';
`;

/** 看提交按钮现在能不能点（写入之后确认页面有没有认这次修改） */
export const CHECK_READY_SCRIPT = `${HELPERS}
const isDisabled = (node) => node.disabled === true
  || node.getAttribute('aria-disabled') === 'true'
  || /disabled/i.test(String(node.className || ''))
  || /disabled/i.test(String(node.getAttribute('class') || ''));

const found = findSubmitButton();
const picked = pickEditorView();
const lines = picked.best ? picked.best.view.state.doc.lines : null;
const parts = [];
if (!found) {
  const labels = Array.from(document.querySelectorAll('button')).map((b) => buttonLabel(b)).filter(Boolean).slice(0, 15);
  parts.push('没找到提交按钮（页面上的按钮：' + labels.join(' / ') + '）');
} else {
  parts.push('提交按钮：' + found.how + '，' + (isDisabled(found.node) ? '当前是禁用的' : '当前可用'));
}
if (lines !== null) parts.push('作答区：' + lines + ' 行');
return parts.join('；');
`;

/** 设置页「模拟输入测试」与写入工具共用的页面侧方法（都在页面主世界执行） */
export const INPUT_METHOD_SCRIPT = `${HELPERS}
const method = String(__args.method || '');
const text = String(__args.text === undefined ? '' : __args.text);
const json = __args.json === true;
if (method !== 'clear' && method !== 'readDoc' && method !== 'rect' && !text) return '没有给 text';

const picked = pickEditorView();
const element = findEditorElement();

// 统一的收尾：报告用了什么方法、回读比对结果；json 模式返回结构化数据（给写入链路判断用）
const finish = (how) => {
  const after = picked.best
    ? picked.best.view.state.doc.toString()
    : (element ? readFromDom(element) : '');
  const diff = compareText(text, after);
  if (json) return { ok: diff.ok, method, detail: diff.detail, length: after.length };
  const parts = [how, diff.detail];
  const notice = findPageNotice();
  if (notice) parts.push('页面上出现了提示：' + notice);
  return parts.join('；');
};

// 回读：优先编辑器实例（view.state.doc 是完整文档，DOM 只能读到渲染出来的行）
if (method === 'readDoc') {
  if (picked.best) return picked.best.view.state.doc.toString();
  return element ? readFromDom(element) : '';
}

// 只报告作答区位置，给 CDP 真实点击用
if (method === 'rect') {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

// 清空作答区：写入失败换备用实现之前，先把内容全部删掉
if (method === 'clear') {
  if (picked.best) {
    picked.best.view.dispatch({ changes: { from: 0, to: picked.best.view.state.doc.length, insert: '' } });
    return { ok: picked.best.view.state.doc.length === 0, method, detail: '已清空', length: 0 };
  }
  if (!element) return { ok: false, method, detail: '页面上没有可清空的作答区', length: -1 };
  element.focus();
  const selection = document.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  let deleted = false;
  try { deleted = document.execCommand('delete'); } catch (e) { deleted = false; }
  const empty = readFromDom(element).length === 0;
  return { ok: deleted && empty, method, detail: empty ? '已清空' : '清空后仍有内容', length: -1 };
}

// ---------- 可用的四种写法 ----------
const view = picked.best ? picked.best.view : null;
if (!view) {
  // 只找到只读实例时说明白那是题面的样例框，别含糊地说「编辑器是只读的」
  const message = picked.readOnlyCount > 0
    ? '页面上只有 ' + picked.readOnlyCount + ' 个只读编辑器（题面的样例框），没找到可写的作答区'
    : '没拿到可写的编辑器实例';
  return json ? { ok: false, method, detail: message, length: -1 } : message;
}
const whole = { from: 0, to: view.state.doc.length };

const moveCursorToEnd = () => {
  // 光标放到文末：用户接手时位置正常，后续的「真实按键戳一下」也不会插进代码中间
  view.dispatch({ selection: { anchor: view.state.doc.length } });
};

if (method === 'dispatchFocus') {
  view.focus();
  view.dispatch({ changes: { ...whole, insert: text } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  moveCursorToEnd();
  return finish('先 focus 再整段 dispatch');
}
if (method === 'dispatch') {
  view.dispatch({ changes: { ...whole, insert: text } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  moveCursorToEnd();
  return finish('整段 dispatch');
}
if (method === 'replaceSelection') {
  view.dispatch(view.state.replaceSelection(text));
  await new Promise((resolve) => setTimeout(resolve, 150));
  moveCursorToEnd();
  return finish('view.state.replaceSelection 后 dispatch');
}
if (method === 'cdpClickTyping') {
  // 输入由 background 的 CDP 逐字按键完成，这里只负责聚焦
  view.focus();
  return { ok: true, method, detail: '已聚焦，等待 CDP 逐字按键', length: view.state.doc.length };
}

return json ? { ok: false, method, detail: '没有实现的方法：' + method, length: -1 } : '没有实现的方法：' + method;
`;
