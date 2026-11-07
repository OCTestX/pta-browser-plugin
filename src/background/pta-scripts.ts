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

  // PTA 的题型是固定的几个，题目集合地址里带着：/problems/type/N
  // 1=判断题 2=选择题 6=代码填空 7=编程题 9=多文件
  const PROBLEM_TYPE_NAMES = {
    1: '判断题（True or False）',
    2: '选择题（Multiple Choice）',
    6: '代码填空（Code Completion）',
    7: '编程题（Programming）',
    9: '多文件（Multiple Files）',
  };

  const detectProblemType = () => {
    const fromUrl = location.pathname.match(/\\/problems\\/type\\/(\\d+)/);
    const radios = document.querySelectorAll('input[type=radio]').length;
    const editors = Array.from(document.querySelectorAll('.cm-content')).filter(isEditableElement).length;
    let id = fromUrl ? Number(fromUrl[1]) : 0;
    if (!id) {
      // 地址里没带题型就按页面结构猜：有单选框的是选择/判断题，有可写编辑器的是编程/填空题
      if (radios > 0) id = 2;
      else if (editors > 0) id = 7;
    }
    return {
      id,
      name: PROBLEM_TYPE_NAMES[id] || ('未知题型（type=' + id + '）'),
      radios,
      editors,
      isChoice: id === 1 || id === 2,
    };
  };

  // 选择题/判断题的题干里混着两类噪音：页面的 UI 文案，以及代码块行号槽里的数字
  const cleanChoiceStem = (text) => {
    const NOISE = ['复制内容', '格式', '全屏', '收起', 'Toggle Sidebar', '复制', 'Copy'];
    const raw = String(text || '').split('\\n').map((line) => line.trim());
    const kept = [];
    for (let index = 0; index < raw.length; index += 1) {
      const line = raw[index];
      if (!line) { kept.push(''); continue; }
      if (NOISE.indexOf(line) >= 0) continue;
      // 连续的数字行是代码块的行号槽；单独一个数字可能是题面内容，留下
      if (/^\\d{1,3}$/.test(line)) {
        const prev = raw[index - 1] ?? '';
        const next = raw[index + 1] ?? '';
        if (/^\\d{1,3}$/.test(prev) || /^\\d{1,3}$/.test(next)) continue;
      }
      kept.push(line);
    }
    return kept.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
  };

  // 选择题/判断题：作答区是一堆单选框，题干与选项要按「题」分组抠出来
  const readChoiceQuestions = () => {
    const groups = new Map();
    for (const radio of document.querySelectorAll('input[type=radio]')) {
      const key = radio.name || radio.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(radio);
    }
    const questions = [];
    for (const [key, radios] of groups) {
      const options = radios.map((radio) => {
        const label = radio.closest('label');
        return {
          value: radio.value || '',
          id: radio.id || '',
          text: (label ? textOf(label) : '').replace(/\\s+/g, ' ').trim(),
        };
      });
      // 结构：input → label → span → span(选项区) → div(本题正文) → …
      const optionsWrap = radios[0].closest('label')?.parentElement?.parentElement;
      const body = optionsWrap ? optionsWrap.parentElement : null;
      let stem = body ? textOf(body) : '';
      if (optionsWrap) stem = stem.split(textOf(optionsWrap)).join(' ');
      stem = cleanChoiceStem(stem);
      // 再上一层是题号、分数、作者这些信息
      let title = '';
      const meta = body && body.parentElement ? body.parentElement.parentElement : null;
      if (meta && body) {
        const head = textOf(meta).split(textOf(body)).join(' ').replace(/\\s+/g, ' ').trim();
        const match = head.match(/^(\\S+)/);
        title = match ? match[1] : '';
      }
      questions.push({ key, title, stem, options });
    }
    return questions;
  };

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
  //
  // 英文也要认：PTA 的判题结果页是英文的（Accepted / Wrong Answer / Time Limit Exceeded…），
  // 只认中文的话整页都读不出结论，只能干等到超时。
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
    // 英文结论（unaccepted 必须在 accepted 前面：它是包含关系；
    // partially accepted 也要排在 accepted 前面 —— PTA 的部分得分判题原文就是
    // "Partially Accepted"，只认 accepted 会把这题报成 AC）
    ['unaccepted', '未通过'],
    ['partially accepted', 'PC'],
    ['partly accepted', 'PC'],
    ['partial accepted', 'PC'],
    ['wrong answer', 'WA'],
    ['compile error', 'CE'],
    ['time limit exceeded', 'TLE'],
    ['memory limit exceeded', 'MLE'],
    ['output limit exceeded', 'OLE'],
    ['runtime error', 'RE'],
    ['presentation error', 'PE'],
    ['accepted', 'AC'],
  ];

  // rank 越小越具体，挑结论时取 rank 最小的那个
  const JUDGE_RANKS = { PC: 10, CE: 20, TLE: 20, MLE: 20, OLE: 20, RE: 20, PE: 20, WA: 20, '未通过': 20, AC: 30 };

  // 「通过」太泛：PTA 会在结论旁边写「通过测试点 6/10」「通过率 60%」，
  // 这些是在说统计，不是在说结论。只有真正在讲结论的「通过」才算 AC。
  const isVerdictPass = (value) => {
    const hit = /(?<![未不非部])通过(?![率测的])/.exec(value);
    return Boolean(hit);
  };

  // 归一化判题文字，并给出优先级（rank 越小越具体）：跨容器挑结论时按 rank 取最好的那个
  const judgeHit = (text) => {
    const value = String(text || '');
    // 结论文字都很短（一行）。长文本一律不当结论：
    // 页面上随便一段脚本源码里就可能有个孤零零的 RE/AC
    // （实测 PTA 那段「不再支持旧浏览器」的提示脚本里的 you're 会被当成 RE）
    if (value.trim().length > 120) return null;
    const lower = value.toLowerCase();
    for (let index = 0; index < JUDGE_WORDS.length; index += 1) {
      if (!lower.includes(JUDGE_WORDS[index][0])) continue;
      return { status: JUDGE_WORDS[index][1], rank: JUDGE_RANKS[JUDGE_WORDS[index][1]] };
    }
    // 裸状态码（AC/WA/…）更严格：只在很短的一行里才算
    if (value.trim().length <= 24) {
      const code = value.match(/\\b(AC|WA|RE|TLE|MLE|CE|PE|OLE)\\b/i);
      if (code) return { status: code[1].toUpperCase(), rank: JUDGE_RANKS[code[1].toUpperCase()] };
    }
    if (isVerdictPass(value)) return { status: 'AC', rank: 40 };
    return null;
  };

  // 整体结论块：PTA 的结果页是「Status」标签和结论值放在同一个块里
  // （<div class="space-y-1">Status / Accepted</div>），标签本身是叶子节点，值在旁边的按钮里。
  // 往上找几层祖先，取第一个「能读出结论」的小块。
  // 题面列表的表头里也有个 Status，但那一块里没有结论，不会被误认成整体结论。
  const readStatusBlock = () => {
    const labels = document.querySelectorAll('span, td, th, p, li, div');
    for (const label of labels) {
      if (label.children.length > 0) continue; // 只看真正写着字的叶子节点
      const labelText = textOf(label).trim();
      if (!/^(status|状态|判题结果|评测结果|judge result|结果)$/i.test(labelText)) continue;
      let node = label.parentElement;
      for (let depth = 0; node && depth < 5; depth += 1) {
        const blockText = textOf(node).trim();
        if (blockText.length > 200) break;
        const hit = judgeHit(blockText);
        if (hit) return { text: blockText, status: hit.status, rank: 5 };
        node = node.parentElement;
      }
    }
    return null;
  };

  // 判题文字可能挂在弹窗里，也可能直接出现在页面上。
  // 一条一条地判再按优先级取最好的那个：把多个容器拼成一大段再匹配会先撞上谁算谁
  // （实测把「部分正确 通过测试点 6/10」报成了 AC）。
  const readJudgeText = () => {
    // 整体结论最优先：它才是「这次提交」的结论，页面上其它地方（题面列表、提交记录）
    // 也可能有 Accepted / Wrong Answer，不能盖过它
    const block = readStatusBlock();
    if (block) return { text: block.text.slice(0, 400), status: block.status };

    const containers = ['[class*=judge]', '[class*=result]', '[class*=status]', '[role=alert]', '.el-message', '.ant-message', '[class*=modal]', '[class*=dialog]'];
    const chunks = [];
    let best = null;
    for (const selector of containers) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
      for (const node of nodes) {
        // 脚本/样式里的文字不是判题结论（PTA 页面里就有一段弃用提示的脚本源码）
        if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.tagName === 'NOSCRIPT') continue;
        const text = shortText(node);
        if (!text || text.length >= 200) continue;
        chunks.push(text);
        const hit = judgeHit(text);
        if (hit && (!best || hit.rank < best.rank)) best = { text, status: hit.status };
      }
    }
    if (best) return { text: best.text.slice(0, 400), status: best.status };

    const lines = (document.body.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    let lineBest = null;
    for (const line of lines) {
      if (line.length > 120) continue; // 太长的是脚本源码/整段说明，不是结论
      const hit = judgeHit(line);
      if (hit && (!lineBest || hit.rank < lineBest.rank)) lineBest = { text: line, status: hit.status };
    }
    if (lineBest) return { text: lineBest.text.slice(0, 400), status: lineBest.status };

    // innerText 只算「看得见」的部分：结果区被折叠/藏起来时读不到，
    // 退到 textContent 再扫一遍（textContent 含隐藏文字）
    const rawLines = (document.body.textContent || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    for (const line of rawLines) {
      if (line.length > 120) continue;
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
    const labels = ['提交本题作答', '提交答案', '提交', '提交评测', 'Submit For This Problem', 'Submit'];
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
    const dialogSelectors = ['[class*=modal]', '[class*=dialog]', '[class*=overlay]', '[class*=popup]', '.el-dialog', '.ant-modal', '.pc-modal'];
    // PTA 的界面有中英文两套（考试页是英文的），关闭按钮的文案两种都要认
    const CLOSE_TEXTS = ['关闭', '确定', '我知道了', '知道了', '取消', 'OK', 'Close', 'Cancel', 'Confirm'];
    for (let round = 0; round < 3; round++) {
      let did = false;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));

      const dialogs = [];
      for (const selector of dialogSelectors) {
        try { document.querySelectorAll(selector).forEach((node) => dialogs.push(node)); } catch (e) {}
      }
      for (const dialog of dialogs) {
        const closers = Array.from(dialog.querySelectorAll(
          '[class*=close], [class*=dismiss], [aria-label*=close i], .pc-close, button',
        ));
        for (const closer of closers) {
          const text = textOf(closer);
          const isTextButton = CLOSE_TEXTS.includes(text);
          // PTA 的关闭按钮是个纯图标：<svg><use xlink:href="#pat-close"></use></svg>，
          // 没有文字也没有 close 类名，只能从 use 的引用里认
          const iconClose = !!closer.querySelector('use[*|href*="close" i]');
          const looksClose = /close|dismiss/i.test(closer.className || '')
            || /close/i.test(closer.getAttribute('aria-label') || '')
            || iconClose;
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

  // ---- 题面里的公式与图片 ----

  // KaTeX / MathML 公式：annotation 里存着原始 LaTeX，直接取出来最准
  // （PTA 的题面用 KaTeX 渲染公式，innerText 只会得到一堆排版后的碎片字符）
  const katexLatex = (node) => {
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation && annotation.textContent) return annotation.textContent.trim();
    const math = node.querySelector('math');
    if (math) {
      const alt = math.getAttribute('alt') || math.getAttribute('alttext');
      if (alt) return alt.trim();
    }
    return '';
  };

  // 题面里的图片：多数是公式图。src 可能是 data: URI，也可能是普通链接。
  // 能从 alt / title 里拿到文字就带出来，拿不到就告诉模型「这里有一张图」
  const imagePlaceholder = (node) => {
    const alt = (node.getAttribute('alt') || '').trim();
    const title = (node.getAttribute('title') || '').trim();
    let src = (node.getAttribute('src') || '').trim();
    if (src.startsWith('data:')) {
      // data: URI 太长，只留个类型标记
      const mime = /^data:([^;,]+)/.exec(src);
      src = mime ? 'data:' + mime[1] : 'data:…';
    }
    const label = alt || title;
    const width = node.getAttribute('width');
    const height = node.getAttribute('height');
    const size = width && height ? '（' + width + '×' + height + '）' : '';
    return '[图片' + size + (label ? '：' + label : '（图片，题面里没有可读的文字说明）') + (src ? ' <' + src + '>' : '') + ']';
  };

  // 把题面 DOM 摊平成纯文本：公式换回 LaTeX，图片换成占位说明，
  // 只读编辑器（样例框）跳过（样例单独读，不掺进正文）
  const flattenStatement = (root) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        // 源码里的换行与缩进不是内容：压成空格，段落分隔交给块级元素
        const value = (node.nodeValue || '').replace(/\\s+/g, ' ');
        if (value.trim()) parts.push(value);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
      if (tag === 'IMG') {
        parts.push(imagePlaceholder(node));
        return;
      }
      // KaTeX：取 LaTeX 源码，不再展开排版碎片
      if (node.classList && node.classList.contains('katex')) {
        const latex = katexLatex(node);
        parts.push(latex ? '$' + latex + '$' : '[公式]');
        return;
      }
      // 只读的 CodeMirror 是样例框，正文里不要它
      if (node.classList && node.classList.contains('cm-content')) {
        const readonly = node.getAttribute('aria-readonly') === 'true'
          || node.getAttribute('contenteditable') === 'false';
        if (readonly) return;
      }
      if (tag === 'BR') { parts.push('\\n'); return; }
      const isBlock = /^(P|DIV|LI|UL|OL|TABLE|TR|TD|TH|H1|H2|H3|H4|H5|H6|PRE|BLOCKQUOTE|SECTION|ARTICLE|HR)$/.test(tag);
      if (isBlock) parts.push('\\n');
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      if (isBlock) parts.push('\\n');
    };
    walk(root);
    return parts.join('')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n[ \\t]+/g, '\\n')
      .replace(/[ \\t]{2,}/g, ' ')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  };

  // 页面上选的编程语言：自动检查要按它挑编译器，
  // 否则 Python 题会被按 C 编译，报出来的「编译失败」是假的
  const detectLanguage = () => {
    const candidates = [];
    for (const node of document.querySelectorAll('select')) {
      const option = node.selectedOptions && node.selectedOptions[0];
      if (option) candidates.push((option.textContent || '').trim());
    }
    for (const node of document.querySelectorAll(
      '[class*=select__control], [class*=select__value-container], [role=combobox]',
    )) {
      candidates.push((node.innerText || node.textContent || '').trim());
    }
    for (const value of candidates) {
      const text = value.toLowerCase();
      if (!text || text.length > 40) continue;
      // Python 要分版本：页面选的是 python2 时，插件内置的运行器（Python 3）
      // 跑出来的结果跟 PTA 实际编译的不是一回事
      if (/python/.test(text)) {
        // 页面上的写法是「Python (python3)」这种，版本号在括号里
        const version = /python[^0-9]*([23])/.exec(text);
        if (version) return version[1] === '2' ? 'python2' : 'python3';
        return 'python';
      }
      if (/^c\\b|\\bc\\s*\\(|c语言|gcc/.test(text)) return 'c';
      if (/javascript|js语言|node/.test(text)) return 'js';
      if (/c\\+\\+|cpp/.test(text)) return 'cpp';
      if (/java/.test(text)) return 'java';
      if (/golang|go语言/.test(text)) return 'go';
    }
    return '';
  };

  // 换掉作答区选定的语言。
  // 有些题被题组配置成了 Python 2（页面上写「Python (python2)」），
  // 而插件内置的 Python 运行器是 Python 3，写 Python 3 的代码提交过去会直接报
  // 「Non-zero Exit Code」。这里把页面上的语言切到 Python 3（题组允许的话）。
  const switchLanguage = (target) => {
    const wanted = String(target || '').toLowerCase();
    if (!wanted) return { ok: false, detail: '没说要切到哪个语言' };

    const control = document.querySelector('.select__control');
    if (!control) return { ok: false, detail: '页面上找不到语言选择器' };

    // 先记下现在的选择，切完要对比
    const before = textOf(control).trim();
    control.click();
    const options = Array.from(document.querySelectorAll('.select__option, [role=option]'));
    const match = options.find((option) => {
      const text = textOf(option).trim().toLowerCase();
      if (!text || text.length > 40) return false;
      if (option.classList.contains('select__option--is-disabled')) return false;
      if (wanted === 'python3') return /python[^0-9]*3/.test(text);
      if (wanted === 'python2') return /python[^0-9]*2/.test(text);
      return text.indexOf(wanted) >= 0;
    });
    if (!match) {
      // 把下拉收起来，别留个遮在页面上的菜单
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
      return { ok: false, detail: '这个题不允许切到 ' + wanted + '（可选：' + options.map((o) => textOf(o).trim()).filter(Boolean).slice(0, 6).join(' / ') + '）' };
    }
    const label = textOf(match).trim();
    match.click();
    return { ok: true, detail: '作答语言已从「' + before + '」切到「' + label + '」' };
  };

  // PTA 有个 bug：提交后判题结果不会自己更新，页面上会出现一个「刷新 / Reload」按钮，
  // 不点它就一直停在「评测中 / Waiting」。提交后要定时点它
  const findReloadButton = () => {
    const labels = ['刷新', 'Reload', 'Refresh', '重新加载'];
    for (const label of labels) {
      for (const node of document.querySelectorAll('button, [role=button], a')) {
        if (buttonLabel(node) === label) return node;
      }
    }
    for (const label of labels) {
      for (const node of document.querySelectorAll('button, [role=button], a')) {
        if (buttonLabel(node).includes(label)) return node;
      }
    }
    return null;
  };

  // 测试面板里的「输入」框：它是可写编辑器，但不是作答区那个。
  // 靠祖先里有没有 CodingProblemAnswerForm 区分（作答区在这个表单里）
  const findTestInputEditor = () => {
    const editors = Array.from(document.querySelectorAll('.cm-content'));
    const writable = editors.filter((e) => (
      isEditableElement(e) && !e.closest('[class*=CodingProblemAnswerForm]')
    ));
    if (writable.length === 0) return null;
    // 多个时取内容最长的那个（通常是当前测试用例的输入）
    return writable.reduce((a, b) => ((b.innerText || '').length > (a.innerText || '').length ? b : a));
  };

  // 把一段文本写进可写的 CodeMirror：优先用编辑器实例（能整段原子写入），
  // 拿不到实例就退回选中原内容再插入
  const writeIntoEditor = (element, text) => {
    let view = null;
    try { view = element.cmTile && element.cmTile.view ? element.cmTile.view : null; } catch (e) {}
    if (view && view.state && view.state.doc && typeof view.dispatch === 'function') {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      return '编辑器实例';
    }
    element.focus();
    const selection = document.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    try { document.execCommand('insertText', false, text); } catch (e) {}
    return 'DOM 插入';
  };
`;

/** 定位并抠出题面 */
export const READ_PROBLEM_SCRIPT = `${HELPERS}
const problemType = detectProblemType();

// 只要题型信息（写入前判断该往代码框还是单选框里填）
if (__args.typeOnly === true) {
  return { type: problemType, title: document.title, url: location.href };
}

// 选择题/判断题：一页上排着好几小题，没有「一个题面容器」这回事，按题分组抠
if (problemType.isChoice && problemType.radios > 0) {
  const questions = readChoiceQuestions();
  const out = ['题目类型：' + problemType.name + '（本页共 ' + questions.length + ' 小题）', '地址：' + location.href, ''];
  questions.forEach((question, index) => {
    out.push('第 ' + (index + 1) + ' 题' + (question.title ? '（' + question.title + '）' : ''));
    if (question.stem) out.push('题干：' + question.stem);
    if (question.options.length) {
      out.push('选项：');
      question.options.forEach((option) => out.push('  ' + option.text));
    }
    out.push('');
  });
  out.push('作答方式：用 write_editor_code 把答案写进去，多个答案之间用空格分隔（第一个对第一题，第二个对第二题，以此类推）；');
  out.push('可以写选项字母（如 A B C D），也可以直接写选项原文。');
  return out.join('\\n');
}

const maxChars = typeof __args.maxChars === 'number' ? __args.maxChars : 6000;
const MARKERS = ['题目描述', '题目背景', '题目要求', '问题描述', '输入格式', '输出格式', '样例输入', '样例输出', '输入样例', '输出样例'];

// 一、找题面容器。PTA 现在的考试页把题面渲染进 .rendered-markdown，
//    公式（KaTeX）和样例框（只读 CodeMirror）都在这个容器里面
const specific = [
  '.rendered-markdown',
  '.problem-content', '.problem-statement', '.pt12-problem-content', '.problem-description',
  '[class*=problem-statement]', '[class*=statement]', '[class*=problem-content]',
];
let hit = null;
for (const selector of specific) {
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll(selector)); } catch (e) { continue; }
  for (const node of nodes) {
    // 用摊平后的长度比：innerText 会把 KaTeX 的排版碎片算进去，长度不可靠
    const text = flattenStatement(node);
    if (text.length > 40 && (!hit || text.length > hit.text.length)) hit = { selector, text, node };
  }
}

// 二、类名对不上时按小标题定位：同时出现两个以上小标题标记的「最小」容器。
//    只在没找到已知类名的容器时才用，否则会把已经找好的 .rendered-markdown 换掉
if (!hit) {
  let best = null;
  let nodes = [];
  try { nodes = Array.from(document.querySelectorAll('div, section, article, main, form')); } catch (e) {}
  for (const node of nodes) {
    const text = textOf(node);
    if (text.length < 80 || text.length > 30000) continue;
    const marks = MARKERS.filter((m) => text.indexOf(m) >= 0).length;
    if (marks < 2) continue;
    if (!best || marks > best.marks || (marks === best.marks && text.length < best.text.length)) {
      best = { selector: '按小标题定位的容器（含 ' + marks + ' 个小标题）', text, marks, node };
    }
  }
  if (best) {
    // 同样要摊平：公式得还原成 LaTeX，不能留排版碎片
    best.text = flattenStatement(best.node);
    hit = best;
  }
}

let text = hit ? hit.text : textOf(document.body);
let source = hit ? hit.selector : '整页正文';
if (!hit) {
  // 退到整页正文时，从第一个小标题开始截，把前面的导航和侧栏丢掉
  const positions = MARKERS.map((m) => text.indexOf(m)).filter((i) => i >= 0);
  if (positions.length > 0) {
    text = text.slice(Math.min.apply(null, positions));
    source = '整页正文（只取小标题之后的部分）';
  }
}

// 三、把纯 UI 文案行滤掉。注意不能按「纯数字行」过滤 —— 样例输出经常就是一行数字（比如 "7"），
// 会连带把样例答案删掉；侧栏题号在按容器/小标题定位时本来就被排除在外了
const NOISE = [
  '题目总览', '作答', '题数', '编程题', '图例', 'Toggle Sidebar', '上一题', '下一题',
  '全屏浏览', '切换布局', '复制内容', '格式', '全屏', '题目描述', '我的提交', '提交本题作答', '复制',
  'Problem Description', 'View In Fullscreen', 'Switch Layout', '收起', '[ in ]', '[ out ]',
];
const lines = text.split('\\n').map((line) => line.replace(/[ \\t]+$/, '')).filter((line) => {
  const value = line.trim();
  if (!value) return true;
  if (NOISE.indexOf(value) >= 0) return false;
  if (/^当前\\d+\\s*-\\s*\\d+项/.test(value)) return false;
  return true;
});
text = lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();

// 四、抠出样例。PTA 的样例是只读的 CodeMirror（题面里那块只读编辑器），
//    不是正文里的纯文本行——按文本行去猜会把「复制内容」「1」「2」这些 UI 碎片也捞进来
const sampleValues = [];
if (hit && hit.node) {
  let editors = [];
  try { editors = Array.from(hit.node.querySelectorAll('.cm-content')); } catch (e) {}
  for (const editor of editors) {
    const readonly = editor.getAttribute('aria-readonly') === 'true'
      || editor.getAttribute('contenteditable') === 'false';
    if (!readonly) continue;
    const value = readFromDom(editor).trim();
    if (value) sampleValues.push(value);
  }
}

const pairs = [];
if (sampleValues.length >= 2) {
  // 只读编辑器在页面里的顺序就是「输入、输出、输入、输出……」
  for (let index = 0; index + 1 < sampleValues.length; index += 2) {
    pairs.push({ input: sampleValues[index], output: sampleValues[index + 1] });
  }
} else {
  // 退路：题面是纯文本的老页面，按小标题分组
  const blocks = [];
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
}

const title = (document.title || textOf(document.querySelector('h1')) || '').trim();
const idMatch = location.pathname.match(/\\/(\\d{6,})/);
const language = detectLanguage();

// 只取样例：给 write_editor_code 的自动检查用，返回结构化数据
if (__args.samplesOnly === true) {
  return { title, url: location.href, samples: pairs, language };
}

const out = ['题目：' + (title || '（没取到标题）'), '地址：' + location.href];
if (idMatch) out.push('题目 ID：' + idMatch[1]);
if (language) out.push('题目语言：' + language);
if (pairs.length > 0) {
  out.push('', '样例（共 ' + pairs.length + ' 组，可以直接当 compile_and_run_* 的 stdin）：');
  pairs.slice(0, 5).forEach((pair, index) => {
    out.push('样例 ' + (index + 1) + ' 输入：' + fence + '\\n' + (pair.input || '（空）') + '\\n' + fence);
    out.push('样例 ' + (index + 1) + ' 输出：' + fence + '\\n' + (pair.output || '（空）') + '\\n' + fence);
  });
}
if (text.length > maxChars) text = text.slice(0, maxChars) + '\\n…（题面过长，已截断）';
out.push('', '题面（来源：' + source + '，' + text.length + ' 字）：', text);
return out.join('\\n');
`;

/**
 * 选择题/判断题的作答：作答区是一堆单选框，不是代码编辑器。
 * 答案按空格分隔，第一个对第一题，第二个对第二题……
 * 可以写选项字母（A/B/C/D），也可以直接写选项原文。
 */
export const WRITE_ANSWERS_SCRIPT = `${HELPERS}
const tokens = String(__args.text === undefined ? '' : __args.text)
  .split(/\\s+/)
  .map((token) => token.trim())
  .filter(Boolean);
const groups = new Map();
for (const radio of document.querySelectorAll('input[type=radio]')) {
  const key = radio.name || radio.id;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(radio);
}
if (!groups.size) return { ok: false, filled: [], problems: ['页面上没有单选框，这不是选择题/判断题'], total: 0 };

const keys = Array.from(groups.keys());
const filled = [];
const problems = [];
for (let index = 0; index < keys.length; index += 1) {
  const token = tokens[index];
  if (!token) {
    problems.push('第 ' + (index + 1) + ' 题没有答案（只给了 ' + tokens.length + ' 个）');
    continue;
  }
  const radios = groups.get(keys[index]);
  // 先按字母找（单选框的 id 形如 input-radio-option-<题号>-A）
  const letter = token.replace(/^[A-Za-z]\\s*[.．、)）]\\s*/, '').trim();
  let hit = radios.find((radio) => String(radio.id || '').toUpperCase().endsWith('-' + letter.toUpperCase()));
  if (!hit) {
    // 再按选项原文找
    hit = radios.find((radio) => {
      const label = radio.closest('label');
      const text = String(label ? textOf(label) : '').replace(/^\\s*[A-Za-z]\\s*[.．、)）]?\\s*/, '').trim();
      return text === token || text.includes(token);
    });
  }
  if (!hit) {
    problems.push('第 ' + (index + 1) + ' 题的答案「' + token + '」没对上任何选项');
    continue;
  }
  hit.click();
  hit.dispatchEvent(new Event('change', { bubbles: true }));
  const label = hit.closest('label');
  filled.push({
    index: index + 1,
    token,
    text: String(label ? textOf(label) : '').replace(/\\s+/g, ' ').trim(),
  });
}
return { ok: problems.length === 0, filled, problems, total: keys.length };
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
let reloadClicks = 0;
let lastReloadAt = 0;
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
  // PTA 的老毛病：判题结果不会自己刷新，页面上有「刷新 / Reload」按钮时必须点它，
  // 否则永远停在「评测中 / Waiting」。每隔五秒点一次。
  const reload = findReloadButton();
  if (reload && Date.now() - lastReloadAt >= 5000) {
    lastReloadAt = Date.now();
    try { reload.click(); reloadClicks += 1; } catch (e) {}
  }
}

const reloadNote = reloadClicks > 0 ? '（期间点了 ' + reloadClicks + ' 次「刷新」按钮）' : '';
return '已点击提交（' + found.how + '）。\\n等了 ' + waitSeconds + ' 秒还没出结论' + reloadNote + '，当前页面上看到的是：' + (latest.text || '（没读到判题文字）') + '\\n你可以调用 refresh_page 刷新页面后再调 read_judge_result 看结果（拿到结论之前不要关弹窗）。';
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

// 拿到结论后顺手把判题弹窗关掉：弹窗一直挡着作答区，用户没法继续改代码、也没法再次提交。
// 关不掉不算失败（结论已经读到了），只在返回值里说明一下，让用户知道可能要手动关。
const describe = (hit, source) => {
  const closed = dismissOverlays();
  const head = hit.status ? '判题结论：' + hit.status + '\\n' : '还没出结论（页面上只有中间状态）。\\n';
  const tail = closed > 0
    ? '\\n（已自动关掉 ' + closed + ' 层弹窗）'
    : (hit.status ? '\\n（判题弹窗没有自动关掉，如果接下来无法提交，请你手动关闭它）' : '');
  return head + source + '原文：' + hit.text.slice(0, 400) + tail;
};

const deadline = Date.now() + waitSeconds * 1000;
let latest = rememberJudge(readJudgeText());
let lastReloadAt = 0;
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
  // 判题结果不会自己更新：页面上有「刷新 / Reload」按钮就点它，每隔五秒点一次
  const reload = findReloadButton();
  if (reload && Date.now() - lastReloadAt >= 5000) {
    lastReloadAt = Date.now();
    try { reload.click(); } catch (e) {}
  }
}

return '等了 ' + waitSeconds + ' 秒还没读到能归一化成状态码的判题结论。\\n页面上现在看到的是：' + (latest.text || '（没读到判题文字，弹窗可能已经被关掉了）') + '\\n你可以调用 refresh_page 刷新页面后再读一次。';
`;

/** 读作答区选定的语言，或者把它换成另一个 */
export const LANGUAGE_SCRIPT = `${HELPERS}
const current = detectLanguage();
if (!__args.target) return { language: current };
const switched = switchLanguage(__args.target);
return { language: detectLanguage(), ...switched };
`;

/** 关掉挡在前面的弹窗（判题结果弹窗、提交结果 dialog 等） */
export const CLOSE_DIALOGS_SCRIPT = `${HELPERS}
const closed = dismissOverlays();
return closed > 0 ? '已关掉 ' + closed + ' 层弹窗' : '没找到需要关的弹窗（页面上没有挡路的 dialog）';
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
if (method === 'insert') {
  // 「内置粘贴」：在光标处插入，不覆盖用户已有的代码。
  // 但用户如果选中了东西（全选也算），就该替换掉选区——
  // 只按光标插会把内容接在后面，而不是像正常粘贴那样替换。
  view.focus();
  const before = view.state.doc.length;
  const selection = view.state.selection.main;
  const from = selection.from;
  const to = selection.to;
  const replaced = to - from;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = view.state.doc.length;
  const ok = after === before - replaced + text.length;
  const how = replaced > 0
    ? '已替换选中的 ' + replaced + ' 个字符为 ' + text.length + ' 个字符'
    : '已在光标处插入 ' + text.length + ' 个字符';
  return json
    ? { ok, method, detail: ok ? how : '插入后长度对不上（' + before + ' → ' + after + '）', length: after }
    : (ok ? how : '插入失败');
}
if (method === 'cdpClickTyping') {
  // 输入由 background 的 CDP 逐字按键完成，这里只负责聚焦
  view.focus();
  return { ok: true, method, detail: '已聚焦，等待 CDP 逐字按键', length: view.state.doc.length };
}

return json ? { ok: false, method, detail: '没有实现的方法：' + method, length: -1 } : '没有实现的方法：' + method;
`;

/**
 * 读取 PTA 页面上「编译器输出」区域的内容（最近一次运行/编译的输出）。
 *
 * 实测结构：点开「测试用例」后，页面上有一块标题为「编译器输出」的区域，
 * 里面是若干个 pre/code 块（stdout、stderr、异常堆栈各一块）。
 * 找不到「编译器输出」标题时，退到通用选择器，把页面上像输出的块都收回来。
 */
export const READ_PTA_COMPILE_RESULT_SCRIPT = `${HELPERS}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 结果区在新版页面上是页签：Test Case / Running Result / Compiler's Log。
// 先点开目标页签，再按标题找容器，最后只收只读编辑器里的内容。
const OUTPUT_LABELS = ['Running Result', '运行结果', '运行输出', '编译器输出', '编译输出', "Compiler's Log", '编译日志', '编译信息'];

const findLabelNode = (label) => {
  for (const node of document.querySelectorAll('span, div, p, label, button, h1, h2, h3, h4')) {
    if (node.children.length > 0) continue;
    if (textOf(node) === label) return node;
  }
  return null;
};

const readFromHolder = (holder) => {
  // 结果是只读的 CodeMirror：按编辑器内容读，不要按 innerText（会带上行号槽）
  const editors = Array.from(holder.querySelectorAll('.cm-content')).filter((e) => {
    const readonly = e.getAttribute('aria-readonly') === 'true' || e.getAttribute('contenteditable') === 'false';
    return readonly;
  });
  if (editors.length > 0) {
    const text = editors.map((e) => readFromDom(e)).filter(Boolean).join('\\n---\\n');
    if (text) return text;
  }
  const blocks = Array.from(holder.querySelectorAll('pre, code, [class*=output], [class*=stdout], [class*=stderr]'));
  return blocks.map((b) => textOf(b)).filter(Boolean).join('\\n---\\n');
};

const out = [];
const seen = new Set();
for (const label of OUTPUT_LABELS) {
  const node = findLabelNode(label);
  if (!node) continue;
  // 页签按钮：点一下把内容切出来（已经是当前页签时点一下也无副作用）
  const tab = node.closest('button, [role=button]');
  if (tab) {
    tab.click();
    await wait(200);
  }
  let holder = node.parentElement;
  for (let depth = 0; holder && depth < 10; depth += 1) {
    const value = readFromHolder(holder);
    if (value) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
      break;
    }
    holder = holder.parentElement;
  }
  if (out.length > 0) break;
}

// 退路：页面上所有像输出的块（排除作答区自己的代码）
if (out.length === 0) {
  const selectors = ['pre', 'code', 'textarea', '[class*=output]', '[class*=stdout]', '[class*=stderr]', '[class*=console]', '[class*=log]'];
  for (const sel of selectors) {
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
    for (const node of nodes) {
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue;
      if (node.closest('[class*=CodingProblemAnswerForm]')) continue;
      const t = textOf(node);
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
}

if (out.length === 0) {
  return '没读到编译器输出。页面上可能还没跑过测试：先点「测试用例 / Test Case」展开测试区，再点「运行测试 / Run Test Case」。';
}
return out.join('\\n---\\n');
`;

/**
 * 在 PTA 页面上跑一次测试：点开测试面板 → 填入数据集 → 点「运行测试」→ 读回结果。
 *
 * 实测结构（中文页与英文考试页两套文案）：
 *   - 作答区下方有个「测试用例 / Test Case」按钮，点它才展开测试区
 *   - 测试区里有个「运行测试 / Run Test Case」按钮（class 里带 pc-color-pass）
 *   - 结果落在「编译器输出 / Running Result」区域里（英文页还有 Expected Result 对照）
 */
export const SIMULATE_PTA_RUN_SCRIPT = `${HELPERS}
const waitSeconds = Math.min(Math.max(Number(__args.waitSeconds) || 60, 5), 120);
const pollMs = Math.min(Math.max(Number(__args.pollMs) || 500, 50), 5000);
const stdin = typeof __args.stdin === 'string' ? __args.stdin : '';

const visible = (node) => {
  // 真实浏览器里有布局：隐藏元素的 rect 列表是空的
  if (typeof node.getClientRects === 'function' && node.getClientRects().length > 0) return true;
  if (node.offsetParent) return true;
  // 没有布局引擎的环境（测试用的 jsdom）：退回看显式的 display:none / hidden
  const hiddenAncestor = node.closest && node.closest('[hidden], [style*="display:none"], [style*="display: none"]');
  return !hiddenAncestor;
};

const findButtonByText = (labels) => {
  for (const label of labels) {
    const nodes = Array.from(document.querySelectorAll('button, [role=button], a'));
    for (const node of nodes) {
      if (textOf(node) === label && visible(node)) return node;
    }
  }
  return null;
};

const RUN_LABELS = ['运行测试', 'Run Test Case', '模拟运行'];
const PANEL_LABELS = ['测试用例', 'Test Case'];

// 一、测试区没展开就先展开：作答区下面那个「测试用例 / Test Case」按钮
let runButton = findButtonByText(RUN_LABELS);
if (!runButton) {
  const panelButton = findButtonByText(PANEL_LABELS);
  if (panelButton) {
    panelButton.click();
    // 等测试区渲染出来
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await sleepOrAbort(150);
      runButton = findButtonByText(RUN_LABELS);
      if (runButton) break;
    }
  }
}

if (!runButton) {
  return '没找到「运行测试 / Run Test Case」按钮。页面上可能有「测试用例 / Test Case」按钮，点开它就能看到运行入口；也可能这个页面（考试模式）不支持运行测试。';
}

// 二、把数据集填进测试输入框（不传 stdin 就沿用面板里原有的输入）
let filled = '';
if (stdin) {
  const input = findTestInputEditor();
  if (!input) {
    return '找到了「运行测试」按钮，但没找到测试面板里的输入框，没法填入数据集。'
      + '（面板里应该有一个可写的输入框，不是作答区那个）';
  }
  const how = writeIntoEditor(input, stdin);
  filled = '已把数据集写进测试输入框（' + how + '，' + stdin.length + ' 字符）';
  // 等编辑器把内容渲染出来
  await sleepOrAbort(300);
}

// 三、记下点之前的输出，用来判断「有没有变成新结果」
const readOutput = () => {
  // 英文页：Running Result（实际输出）/ Compiler's Log（编译日志）与 Expected Result（期望输出）
  // 中文页：一块「编译器输出」。新版页面这三块是页签，容器在标题上方第 5 层，
  // 所以祖先链要多找几层（以前卡在 5 层，永远读不到新版页面的输出）。
  const OUTPUT_LABELS = ['Running Result', '运行结果', '运行输出', '编译器输出', '编译输出', "Compiler's Log", '编译日志', '编译信息'];
  for (const label of OUTPUT_LABELS) {
    for (const node of document.querySelectorAll('span, div, p, label, button')) {
      if (node.children.length > 0) continue;
      if (textOf(node) !== label) continue;
      let holder = node.parentElement;
      for (let depth = 0; holder && depth < 10; depth += 1) {
        // 结果是只读的 CodeMirror：按编辑器内容读，不要按 innerText（会带上行号槽）
        const editors = Array.from(holder.querySelectorAll('.cm-content')).filter((e) => {
          const readonly = e.getAttribute('aria-readonly') === 'true' || e.getAttribute('contenteditable') === 'false';
          return readonly;
        });
        if (editors.length > 0) {
          return editors.map((e) => readFromDom(e)).filter(Boolean).join('\\n---\\n');
        }
        const blocks = holder.querySelectorAll('pre, code, [class*=output], [class*=stdout], [class*=stderr]');
        if (blocks.length > 0) {
          return Array.from(blocks).map((b) => textOf(b)).filter(Boolean).join('\\n---\\n');
        }
        holder = holder.parentElement;
      }
    }
  }
  return '';
};

// 期望输出单独读一份，方便 AI 对比
const readExpected = () => {
  for (const node of document.querySelectorAll('span, div, p, label, button')) {
    if (node.children.length > 0) continue;
    if (textOf(node) !== 'Expected Result') continue;
    let holder = node.parentElement;
    for (let depth = 0; holder && depth < 10; depth += 1) {
      const editors = Array.from(holder.querySelectorAll('.cm-content')).filter((e) => {
        const readonly = e.getAttribute('aria-readonly') === 'true' || e.getAttribute('contenteditable') === 'false';
        return readonly;
      });
      if (editors.length > 0) return editors.map((e) => readFromDom(e)).filter(Boolean).join('\\n');
      holder = holder.parentElement;
    }
  }
  return '';
};

// 结果区是页签（Test Case / Running Result / Compiler's Log）：
// 有的页面跑完不会自动切过去，这里显式点一下目标页签。
const activateTab = (labels) => {
  for (const label of labels) {
    for (const node of document.querySelectorAll('button, [role=button]')) {
      if (textOf(node) !== label) continue;
      node.click();
      return label;
    }
  }
  return '';
};

const before = readOutput();
runButton.click();
await sleepOrAbort(500);
const resultTab = activateTab(['Running Result', '运行结果', '运行输出']);

const deadline = Date.now() + waitSeconds * 1000;
let latest = before;
let changed = false;
while (Date.now() < deadline) {
  await sleepOrAbort(pollMs);
  if (aborted()) return '已按用户要求停止等待运行结果';
  const now = readOutput();
  if (now && now !== before) {
    latest = now;
    changed = true;
    break;
  }
  if (now) latest = now;
}

// 运行结果为空时，编译错误/异常通常落在 Compiler's Log 页签里
let logNote = '';
if (!changed) {
  const logTab = activateTab(["Compiler's Log", '编译日志', '编译信息']);
  if (logTab) {
    await sleepOrAbort(300);
    const log = readOutput();
    if (log) {
      latest = log;
      changed = true;
      logNote = '（来自 ' + logTab + '）';
    }
  }
}

const expected = readExpected();
const expectedNote = expected ? '\\n期望输出：\\n' + expected.slice(0, 800) : '';

if (!latest) {
  return '已点击「运行测试」，但没读到输出（可能还在跑，稍后再用 read_pta_compile_result 读一次）';
}
if (!changed) {
  return '已点击「运行测试」，但输出跟运行前一样（可能还在跑或这次没跑起来）。'
    + (filled ? '\\n' + filled : '')
    + '\\n当前输出：\\n' + latest.slice(0, 2000) + expectedNote;
}
const tabNote = (logNote || (resultTab ? '（' + resultTab + '）' : ''));
return (filled ? filled + '\\n' : '')
  + '已点击「运行测试」并读到输出' + tabNote + '：\\n' + latest.slice(0, 2000) + expectedNote;
`;
