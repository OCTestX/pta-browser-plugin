/**
 * 注入 PTA 页面主世界（MAIN world）的「编辑器增强」agent。
 *
 * 为什么必须是主世界：PTA 作答区的 CodeMirror 6 实例只挂在页面的 DOM 节点上
 * （`.cm-content` 上的 `cmTile.view`），隔离世界的 content script 拿到的是
 * `undefined`。也就是说，读全文、写回代码、算字符坐标这些事只有这里能做。
 *
 * 这里只放**页面侧才能做**的事：找编辑器、画浮层、定位、命中检测。
 * 纯逻辑（格式化、括号层数、诊断中文建议、标准库注释表）在 `src/shared/`，
 * 由隔离世界的 content script 算好以后用 `window.postMessage` 送进来。
 *
 * 契约见 `src/shared/editor-assist-protocol.ts`。注意这个文件是一段**字符串**，
 * 页面里没有模块系统，所以：
 *   · 标记字段名 `__ptaEditorAssist` 与消息形状要在下面各抄一份（改协议时要同步）；
 *   · 整段源码被 `String.raw` 包着，**里面不能出现反引号和 `${`**，
 *     字符串拼一律用加号，否则外层模板字符串会被提前截断。
 */

export const EDITOR_AGENT_SOURCE = String.raw`return (() => {
  const ARGS = __args || {};
  const TOKEN = ARGS.token;
  const VERSION = ARGS.version || 0;
  const DOCS = ARGS.docs || {};
  const FEATURES = ARGS.features || {};
  const KEY = '__ptaEditorAssist';

  if (!TOKEN) return { status: 'no-token', token: '' };

  // 同一个页面可能被装两次（SPA 换题时 content script 重新要了一遍）。
  // 版本和 token 都一样就直接复用，别在页面上叠两层工具栏。
  const previous = globalThis[KEY];
  if (previous && typeof previous.destroy === 'function') {
    if (previous.token === TOKEN && previous.version === VERSION) {
      return { status: 'already', token: TOKEN, version: VERSION };
    }
    try { previous.destroy(); } catch (error) { /* 拆不干净也不能挡住重装 */ }
  }

  const COLORS = ['#d1373f', '#b06d00', '#2f7d32', '#17599b', '#7a3fa8', '#a34a12'];
  const SEVERITY_COLOR = { error: '#d1373f', warning: '#b06d00', note: '#17599b' };
  const Z_INDEX = '2147483001';
  const FONT = 'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;';

  const state = {
    el: null,
    view: null,
    text: '',
    marks: null,        // Map<字符下标, 层数>，null 表示还没算出来
    painted: [],        // 上一次上过色的 span：换文档时要把颜色复原
    boxes: [],          // 当前要画的诊断
    rects: [],          // 波浪线的屏幕矩形（hover 命中用）
    note: '',           // 非空表示这次没做检查（比如语言不是 C）
    root: null,
    bar: null,
    badge: null,
    squiggleLayer: null,
    tip: null,
    toastNode: null,
    toastTimer: 0,
    tickTimer: 0,
    docTimer: 0,
    listeners: null,
    paintDirty: false,
    rectDirty: false,
    tooltipKey: '',
    paintGeneration: 0,
    bottomBar: null,       // 代码框底部状态栏（缓存，别每轮全量找）
    barLookupAt: 0,
    resizeObserver: null,
    paintObserver: null,
    layoutFrame: 0,
    squiggleFrame: 0,
  };

  const post = (payload) => {
    try {
      window.postMessage(Object.assign({ __ptaEditorAssist: TOKEN }, payload), '*');
    } catch (error) { /* 页面卸载时 postMessage 也可能抛，忽略 */ }
  };

  const make = (tag, css, text) => {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text) node.textContent = text;
    return node;
  };

  /* ---------- 找可写编辑器 ---------- */

  // 题面的「输入样例 / 输出样例」也是 CodeMirror，但是只读的
  const isEditable = (node) => {
    if (!node) return false;
    if (node.getAttribute('aria-readonly') === 'true') return false;
    const attr = node.getAttribute('contenteditable');
    if (attr === 'false') return false;
    return node.isContentEditable || attr === '' || attr === 'true' || attr === 'plaintext-only';
  };

  const looksLikeView = (value) => !!value
    && typeof value.dispatch === 'function'
    && value.state && value.state.doc
    && typeof value.state.doc.toString === 'function'
    && typeof value.coordsAtPos === 'function';

  // CM6 把 EditorView 挂在不同位置（版本之间不一样），挨个试
  const viewOf = (node) => {
    const tiles = [];
    if (node.cmTile) tiles.push(node.cmTile);
    if (node.cmView) tiles.push(node.cmView);
    let parent = node.parentElement;
    for (let step = 0; step < 5 && parent; step += 1) {
      if (parent.cmTile) tiles.push(parent.cmTile);
      if (parent.cmView) tiles.push(parent.cmView);
      parent = parent.parentElement;
    }
    for (const tile of tiles) {
      if (!tile) continue;
      if (looksLikeView(tile)) return tile;
      if (looksLikeView(tile.view)) return tile.view;
    }
    return null;
  };

  const findEditor = () => {
    const nodes = document.querySelectorAll('.cm-content');
    let best = null;
    let bestScore = -1;
    for (const node of nodes) {
      if (!isEditable(node)) continue;
      const view = viewOf(node);
      if (!view) continue;
      // 展开「Test Case」之后页面上会多出第二个可写编辑器（测试输入框），
      // 只按文本长度挑，它长起来就会绑错对象。所以先看「在不在作答表单里」，
      // 再看有没有实际尺寸，最后才比文本长度。
      const rect = node.getBoundingClientRect();
      const inAnswerForm = node.closest('[class*="CodingProblemAnswerForm"]') ? 1 : 0;
      const visible = rect.width > 0 && rect.height > 0 ? 1 : 0;
      const score = inAnswerForm * 1e9 + visible * 1e6 + view.state.doc.length;
      if (score > bestScore) {
        best = { el: node, view: view };
        bestScore = score;
      }
    }
    return best;
  };

  // 代码填空 / 多文件题的作答区是题面裁判程序的一部分，实时检查要带常用头
  const isFragmentProblem = () => /\/problems\/type\/(6|9)(?:\/|$|\?)/.test(location.pathname);

  // 作答区的语言下拉框。认不出就当 C（PTA 的结构题、填空题基本只有 C）
  const readLanguage = () => {
    const form = state.el ? state.el.closest('[class*="CodingProblemAnswerForm"]') : null;
    const scope = form || document;
    const controls = scope.querySelectorAll('.select__control, select');
    for (const control of controls) {
      const text = (control.innerText || control.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!text) continue;
      if (text.indexOf('javascript') >= 0 || text.indexOf('node') >= 0) return 'javascript';
      if (text.indexOf('c++') >= 0 || text.indexOf('cpp') >= 0 || text.indexOf('cxx') >= 0) return 'cpp';
      if (text.indexOf('python') >= 0) return 'python';
      if (text.indexOf('c#') >= 0 || text.indexOf('csharp') >= 0) return 'csharp';
      if (text.indexOf('java') >= 0) return 'java';
      if (text.indexOf('golang') >= 0 || text.indexOf('go语言') >= 0) return 'go';
      if (text.indexOf('rust') >= 0) return 'rust';
      if (text.indexOf('kotlin') >= 0) return 'kotlin';
      if (text.indexOf('swift') >= 0) return 'swift';
      if (text.indexOf('php') >= 0) return 'php';
      if (text.indexOf('ruby') >= 0) return 'ruby';
      if (text.indexOf('c') >= 0) return 'c';
    }
    return 'c';
  };

  /* ---------- 浮层（工具栏 / 波浪线 / 提示框） ---------- */

  // 一层铺满视口的 fixed 容器：所有子元素都用客户端坐标定位，
  // 页面滚动、React 重渲染都不会把它删掉（它挂在 body 上，不在 React 树里）
  const ensureRoot = () => {
    if (state.root && state.root.isConnected) return state.root;
    const root = make('div', 'position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:' + Z_INDEX + ';');
    root.id = 'pta-assist-editor-layer';
    document.body.appendChild(root);
    state.root = root;
    return root;
  };

  const ensureBar = () => {
    const root = ensureRoot();
    if (state.bar && state.bar.isConnected) return state.bar;

    const bar = make('div', 'position:absolute;display:flex;align-items:center;gap:6px;pointer-events:none;' + FONT);
    // 固定 id：真机排查和自动验证都靠它定位浮层里的节点
    bar.id = 'pta-assist-bar';

    if (FEATURES.format) {
      const button = make('button', 'pointer-events:auto;cursor:pointer;border:1px solid #d0d3d9;border-radius:6px;'
        + 'background:#fff;color:#1f2329;font:inherit;padding:3px 9px;box-shadow:0 1px 3px rgba(15,23,42,.12);');
      button.type = 'button';
      button.textContent = '整理代码';
      button.title = '去掉多余空白、把缩进整理成统一风格（不动字符串和注释里的内容）';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const view = state.view;
        if (!view) return;
        // 点的时候现读一次正文：巡检是 500ms 一轮，刚敲完就点会读到旧文本，
        // 回来时 source 对不上就被当成「代码刚变过」白白取消一次整理
        const text = view.state.doc.toString();
        state.text = text;
        post({ kind: 'format-request', text: text, language: readLanguage() });
      });
      button.id = 'pta-assist-format';
      bar.appendChild(button);
    }

    if (FEATURES.check) {
      const badge = make('div', 'pointer-events:auto;border:1px solid #d0d3d9;border-radius:6px;background:#fff;'
        + 'color:#5b616e;padding:3px 9px;box-shadow:0 1px 3px rgba(15,23,42,.12);white-space:nowrap;');
      badge.id = 'pta-assist-badge';
      badge.textContent = '检查中…';
      bar.appendChild(badge);
      state.badge = badge;
    }

    if (!bar.childElementCount) bar.style.display = 'none';
    root.appendChild(bar);
    state.bar = bar;
    return bar;
  };

  const updateBadge = () => {
    if (!state.badge) return;
    if (state.note) {
      state.badge.textContent = state.note;
      state.badge.style.color = '#8a6d3b';
      state.badge.title = state.note;
      return;
    }
    let errors = 0;
    let warnings = 0;
    for (const box of state.boxes) {
      if (box.severity === 'error') errors += 1;
      else if (box.severity === 'warning') warnings += 1;
    }
    if (!errors && !warnings) {
      state.badge.textContent = '✓ 没有语法错误';
      state.badge.style.color = '#2f7d32';
      return;
    }
    const parts = [];
    if (errors) parts.push(errors + ' 个错误');
    if (warnings) parts.push(warnings + ' 个警告');
    state.badge.textContent = parts.join('，');
    state.badge.style.color = errors ? '#d1373f' : '#b06d00';
  };

  /* ---------- 彩虹括号 ---------- */

  // 只改 CodeMirror 自己的单字符 span 的颜色，不盖字形遮罩：
  // 不遮挡文本、不影响选区，也不用复制字体度量。
  //
  // 每轮在 span 上盖一个「本轮代号」：没被盖到的（行被重渲染、括号被删、滚出视口）
  // 恢复默认样式。这样不需要「先全清再全刷」，也就不会闪一下再回来。
  const BRACKETS = '()[]{}';

  const clearSpan = (span) => {
    if (!span || !span.style) return;
    span.style.color = '';
    span.style.fontWeight = '';
  };

  const resetPaint = () => {
    for (const span of state.painted) clearSpan(span);
    state.painted = [];
  };

  // 逐行定位：每行只问一次「这一行起点在文档里的下标」，再按 span 的字符数往后累加。
  // 早先是给每个括号单独调 domAtPos（布局查询）：一屏几十个括号就是几十次查询，
  // 每 500ms 一次，滚动 / 光标移动引起重渲染还各来一次——这就是「染色慢、一动就掉色」的来源。
  const paintByLines = (view, marks, generation, painted) => {
    const content = view.contentDOM;
    if (!content || typeof view.posAtDOM !== 'function') return false;
    for (const line of content.querySelectorAll('.cm-line')) {
      let at = -1;
      try { at = view.posAtDOM(line, 0); } catch (error) { at = -1; }
      if (at < 0) continue;
      // 按**子节点逐字符**累加：CM6 会把每个 token 包成一个 span，但等号、分号、逗号
      // 这类标点是裸文本节点。早先只累加 span 的文字长度，一行里出现裸标点之后，
      // 后面所有括号的下标就整体偏了——表现就是「光标一动、行一重渲染，颜色整片消失」。
      for (const child of line.childNodes) {
        const nodeType = child.nodeType;
        if (nodeType !== 3 && nodeType !== 1) continue;
        const text = (nodeType === 3 ? child.nodeValue : child.textContent) || '';
        // 只有「单字符、且没有子元素」的节点才能直接上色：多字符节点上色会染到邻居
        const single = nodeType === 1 && text.length === 1 && child.childElementCount === 0;
        for (let index = 0; index < text.length; index += 1) {
          if (BRACKETS.indexOf(text[index]) < 0) continue;
          const depth = marks.get(at + index);
          if (typeof depth === 'number' && single) {
            const color = COLORS[depth % COLORS.length];
            // 值没变就不写：写 style 会触发下面的 MutationObserver，来回自激
            if (child.style.color !== color) child.style.color = color;
            // 加粗：代码里括号和别的东西一个粗细时，颜色分层不够一眼看出来
            if (child.style.fontWeight !== '600') child.style.fontWeight = '600';
            child.__ptaPaint = generation;
            painted.push(child);
          }
        }
        at += text.length;
      }
      at += 1; // 行尾那个换行符
    }
    return true;
  };

  // 退路：页面的 CM6 没有 posAtDOM 时按字符下标反查（慢，但别让功能整块失效）
  const paintByMarks = (view, marks, generation, painted) => {
    const doc = view.state.doc;
    const ranges = view.visibleRanges || [];
    marks.forEach((depth, at) => {
      if (painted.length >= 4000) return;
      if (at < 0 || at >= doc.length) return;
      if (ranges.length > 0) {
        let visible = false;
        for (const range of ranges) {
          if (at >= range.from && at < range.to) { visible = true; break; }
        }
        if (!visible) return;
      }
      if (BRACKETS.indexOf(doc.sliceString(at, at + 1)) < 0) return;
      let info = null;
      try { info = view.domAtPos(at); } catch (error) { return; }
      if (!info || !info.node || info.node.nodeType !== 3) return;
      if ((info.node.nodeValue || '').charAt(info.offset) !== doc.sliceString(at, at + 1)) return;
      const span = info.node.parentElement;
      if (!span || (span.textContent || '').length !== 1) return;
      span.style.color = COLORS[depth % COLORS.length];
      span.style.fontWeight = '600';
      span.__ptaPaint = generation;
      painted.push(span);
    });
  };

  const paintRainbow = () => {
    const view = state.view;
    if (!view || !state.marks) return;
    const generation = state.paintGeneration + 1;
    state.paintGeneration = generation;
    const painted = [];
    if (!paintByLines(view, state.marks, generation, painted)) {
      paintByMarks(view, state.marks, generation, painted);
    }
    for (const span of state.painted) {
      if (span && span.__ptaPaint !== generation) clearSpan(span);
    }
    state.painted = painted;
  };

  /* ---------- 波浪线 ---------- */

  const WAVE_CACHE = {};

  const waveFor = (color) => {
    if (WAVE_CACHE[color]) return WAVE_CACHE[color];
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="6" height="4">'
      + '<path d="M0 3 Q 1.5 0.6 3 3 T 6 3" fill="none" stroke="' + color + '" stroke-width="1.2"/></svg>';
    const url = 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")';
    WAVE_CACHE[color] = url;
    return url;
  };

  const ensureSquiggleLayer = () => {
    const root = ensureRoot();
    if (state.squiggleLayer && state.squiggleLayer.isConnected) return state.squiggleLayer;
    const layer = make('div', 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;');
    layer.id = 'pta-assist-squiggles';
    root.appendChild(layer);
    state.squiggleLayer = layer;
    return layer;
  };

  const renderSquiggles = () => {
    const layer = ensureSquiggleLayer();
    layer.textContent = '';
    state.rects = [];
    const view = state.view;
    if (!view || !FEATURES.check || state.boxes.length === 0) return;

    const doc = view.state.doc;
    for (const box of state.boxes) {
      // 只有 error 画波浪线：warning 多是「变量没用过」这类提示，满屏波浪线会把真正的错盖住
      if (box.severity !== 'error') continue;
      if (doc.length === 0) continue;
      const at = Math.max(0, Math.min(box.from, doc.length - 1));
      const line = doc.lineAt(at);
      // clang 说「这一行少了分号」时把位置指在行尾，落点就是换行符：
      // 往回退一个字符，否则 start/end 会跨到下一行，被下面的跨行判断吃掉，结果一条都画不出来
      const start = Math.min(Math.max(line.from, at), Math.max(line.from, line.to - 1));
      const end = Math.max(start + 1, Math.min(box.to, line.to));
      if (end <= start) continue;
      let a = null;
      let b = null;
      try {
        a = view.coordsAtPos(start);
        b = view.coordsAtPos(end);
      } catch (error) { continue; }
      if (!a || !b) continue;
      if (Math.abs(b.top - a.top) > 2) continue; // 跨行只画第一行那一段

      const left = Math.min(a.left, b.left);
      const width = Math.max(2, Math.abs(b.left - a.left));
      const color = SEVERITY_COLOR[box.severity] || SEVERITY_COLOR.error;
      const node = make('div', 'position:absolute;height:4px;background-repeat:repeat-x;'
        + 'background-position:left bottom;background-image:' + waveFor(color) + ';');
      node.style.left = Math.round(left) + 'px';
      node.style.top = Math.round(Math.max(a.top, a.bottom) - 3) + 'px';
      node.style.width = Math.round(width) + 'px';
      layer.appendChild(node);

      // 命中区域往外扩一点：波浪线只有 4px 高，鼠标很难刚好压上
      state.rects.push({
        left: left - 3,
        right: left + width + 3,
        top: a.top - 3,
        bottom: a.bottom + 4,
        box: box,
      });
    }
  };

  /* ---------- 悬浮提示 ---------- */

  const ensureTip = () => {
    const root = ensureRoot();
    if (state.tip && state.tip.isConnected) return state.tip;
    const tip = make('div', 'position:absolute;display:none;max-width:340px;padding:8px 10px;border:1px solid #d0d3d9;'
      + 'border-radius:8px;background:#fff;color:#1f2329;box-shadow:0 6px 20px rgba(15,23,42,.18);'
      + 'pointer-events:none;white-space:pre-wrap;' + FONT);
    tip.id = 'pta-assist-tip';
    root.appendChild(tip);
    state.tip = tip;
    return tip;
  };

  const hideTip = () => {
    state.tooltipKey = '';
    if (state.tip) state.tip.style.display = 'none';
  };

  const showTip = (x, y, title, body) => {
    const tip = ensureTip();
    const key = title + '|' + body;
    if (state.tooltipKey !== key) {
      state.tooltipKey = key;
      tip.textContent = '';
      // 一律用 textContent：报错文本来自编译器、注释来自静态表，
      // 都不该有机会被当成 HTML 解析
      tip.appendChild(make('div', 'font-weight:600;margin-bottom:2px;', title));
      if (body) tip.appendChild(make('div', 'color:#5b616e;', body));
    }
    tip.style.display = 'block';
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = x + 12;
    let top = y + 16;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) top = Math.max(8, y - height - 10);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  };

  const wordAt = (pos) => {
    const view = state.view;
    if (!view) return null;
    const doc = view.state.doc;
    if (pos < 0 || pos > doc.length) return null;
    const line = doc.lineAt(pos);
    const text = line.text;
    const offset = Math.min(Math.max(pos - line.from, 0), text.length);
    // 每次新建正则：同一个正则反复 exec 会带着 lastIndex
    const pattern = /[A-Za-z_][A-Za-z_0-9]*/g;
    let match = pattern.exec(text);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) return match[0];
      match = pattern.exec(text);
    }
    return null;
  };

  const onMove = (event) => {
    const x = event.clientX;
    const y = event.clientY;

    // 1) 压在波浪线上：报错比函数注释更要紧，先判它
    for (const rect of state.rects) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        showTip(x, y, rect.box.message, rect.box.advice);
        return;
      }
    }
    if (!FEATURES.hover) { hideTip(); return; }

    const view = state.view;
    if (!view || typeof view.posAtCoords !== 'function') { hideTip(); return; }
    const pos = view.posAtCoords({ x: x, y: y });
    if (pos === null || pos === undefined) { hideTip(); return; }
    const word = wordAt(pos);
    if (!word || !Object.prototype.hasOwnProperty.call(DOCS, word)) { hideTip(); return; }
    const doc = DOCS[word];
    if (!doc) { hideTip(); return; }
    showTip(x, y, word + '：' + doc.summary, doc.signature + (doc.note ? '\n' + doc.note : ''));
  };

  /* ---------- 轻提示 ---------- */

  const toast = (message) => {
    const root = ensureRoot();
    if (state.toastNode) state.toastNode.remove();
    if (state.toastTimer) clearTimeout(state.toastTimer);
    const node = make('div', 'position:absolute;right:16px;bottom:16px;padding:6px 12px;border-radius:8px;'
      + 'background:rgba(31,35,41,.92);color:#fff;pointer-events:none;'
      + 'box-shadow:0 6px 20px rgba(15,23,42,.3);' + FONT);
    node.textContent = message;
    root.appendChild(node);
    state.toastNode = node;
    state.toastTimer = setTimeout(() => {
      state.toastTimer = 0;
      if (state.toastNode) { state.toastNode.remove(); state.toastNode = null; }
    }, 1800);
  };

  /* ---------- 排版 ---------- */

  const place = (node, left, top) => {
    if (!node) return;
    const l = Math.round(left) + 'px';
    const t = Math.round(top) + 'px';
    if (node.style.left !== l) node.style.left = l;
    if (node.style.top !== t) node.style.top = t;
  };

  // 代码框底部那条状态栏（左端是「Test Case」按钮）：实测它的右侧是一大片空白，
  // 把工具栏放这儿既不挡代码，也不用去挤头部行（头部行全是语言选择器和 PTA 自己的图标）。
  //
  // 找法：**按结构**——状态栏就是作答表单后面紧跟的那一个 div。早先按几何扫整片 div，
  // 展开「Test Case」之后面板里也有 24~64px 高的行（连代码行 .cm-line 都符合），
  // 会撞上它们；结构优先、几何只做退路。
  const findBottomBar = () => {
    const form = state.el.closest('[class*="CodingProblemAnswerForm"]');
    if (form) {
      const formWidth = form.getBoundingClientRect().width;
      let node = form.nextElementSibling;
      for (let step = 0; node && step < 4; step += 1) {
        const rect = node.getBoundingClientRect();
        if (rect.height >= 24 && rect.height <= 64 && rect.width >= formWidth * 0.6) return node;
        node = node.nextElementSibling;
      }
      const last = form.lastElementChild;
      if (last && last !== form) {
        const rect = last.getBoundingClientRect();
        if (rect.height >= 24 && rect.height <= 64 && rect.width >= formWidth * 0.6) return last;
      }
    }
    // 退路：在表单的父节点里按几何找，但编辑器内部的节点一律不算
    const box = (state.el.closest('.cm-editor') || state.el).getBoundingClientRect();
    const scope = (form && form.parentElement) || document.body;
    let best = null;
    let bestWidth = 0;
    for (const node of scope.querySelectorAll('div')) {
      if (node.closest('.cm-editor')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height < 24 || rect.height > 64) continue;
      if (Math.abs(rect.top - box.bottom) > 8) continue;
      if (rect.width < box.width * 0.6) continue;
      if (rect.width <= bestWidth) continue;
      best = node;
      bestWidth = rect.width;
    }
    return best;
  };

  // 找到的那条必须真的贴着代码框下沿：否则宁可不放（退回代码框内部），
  // 也别把工具栏摆到面板里某个碰巧同高的行上
  const barFitsEditor = (bar) => {
    if (!bar || !bar.isConnected) return false;
    const box = (state.el.closest('.cm-editor') || state.el).getBoundingClientRect();
    const rect = bar.getBoundingClientRect();
    return rect.height >= 24 && rect.height <= 64
      && Math.abs(rect.top - box.bottom) <= 8
      && rect.width >= box.width * 0.5;
  };

  const ensureBottomBar = () => {
    if (state.bottomBar && barFitsEditor(state.bottomBar)) return state.bottomBar;
    state.bottomBar = null;
    const found = findBottomBar();
    if (!barFitsEditor(found)) return null;
    state.bottomBar = found;
    if (state.resizeObserver) {
      try { state.resizeObserver.observe(found); } catch (error) { /* 观察不了就算了 */ }
    }
    return found;
  };

  const layout = () => {
    if (!state.el || !state.bar) return;
    const editor = state.el.closest('.cm-editor') || state.el;
    const box = editor.getBoundingClientRect();
    const visible = box.bottom > 8 && box.top < window.innerHeight - 8 && box.width > 0;
    state.bar.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;

    const width = state.bar.offsetWidth || 160;
    const height = state.bar.offsetHeight || 27;

    const bar = ensureBottomBar();
    if (bar) {
      const barRect = bar.getBoundingClientRect();
      // 「Test Case」按钮右边开始摆；右边还有 PTA 自己的 ? 和折叠箭头，别压上去
      const button = bar.querySelector('button');
      const buttonBox = button ? button.getBoundingClientRect() : null;
      const start = buttonBox && buttonBox.width > 0 ? buttonBox.right + 12 : barRect.left + 12;
      const left = Math.min(start, barRect.right - width - 60);
      place(state.bar, Math.max(barRect.left + 8, left), barRect.top + (barRect.height - height) / 2);
      return;
    }
    // 没有那条状态栏（面板收起之类）就退回代码框右下角内部
    place(state.bar, box.right - width - 22, box.bottom - height - 10);
  };

  /* ---------- 正文同步 ---------- */

  const syncDoc = (force) => {
    const view = state.view;
    if (!view) return;
    const text = view.state.doc.toString();
    if (!force && text === state.text) return;
    state.text = text;
    // 旧的诊断位置在编辑之后就不对了，先清掉；括号颜色保留，
    // 等新的层数回来再整体重刷（这样敲字时不会整片闪一下）
    state.boxes = [];
    state.rectDirty = true;
    updateBadge();
    if (state.docTimer) clearTimeout(state.docTimer);
    // 停手再算：每敲一下就编译一次会把引擎队列排满
    state.docTimer = setTimeout(() => {
      state.docTimer = 0;
      if (!state.view) return;
      post({ kind: 'doc', text: state.text, language: readLanguage(), check: !!FEATURES.check, fragment: isFragmentProblem() });
    }, 350);
  };

  /* ---------- 绑定 / 解绑 ---------- */

  const removeListeners = () => {
    const listeners = state.listeners;
    if (!listeners) return;
    if (state.view && state.view.scrollDOM) {
      state.view.scrollDOM.removeEventListener('scroll', listeners.onScroll);
    }
    if (state.el) {
      state.el.removeEventListener('mousemove', listeners.onMove);
      state.el.removeEventListener('mouseleave', hideTip);
    }
    state.listeners = null;
  };

  const unbind = () => {
    removeListeners();
    if (state.resizeObserver) {
      try { state.resizeObserver.disconnect(); } catch (error) { /* 已经断了 */ }
    }
    if (state.paintObserver) {
      try { state.paintObserver.disconnect(); } catch (error) { /* 已经断了 */ }
    }
    state.bottomBar = null;
    state.barLookupAt = 0;
    if (state.docTimer) { clearTimeout(state.docTimer); state.docTimer = 0; }
    resetPaint();
    state.el = null;
    state.view = null;
    state.text = '';
    state.marks = null;
    state.boxes = [];
    state.rects = [];
    state.note = '';
    if (state.bar) state.bar.style.display = 'none';
    if (state.squiggleLayer) state.squiggleLayer.textContent = '';
    hideTip();
    post({ kind: 'editor-lost' });
  };

  const bind = (found) => {
    state.el = found.el;
    state.view = found.view;
    state.text = '';
    state.marks = null;
    state.boxes = [];
    state.rects = [];
    state.note = '';
    resetPaint();
    ensureBar();
    ensureSquiggleLayer();
    if (state.bar && state.bar.childElementCount > 0) state.bar.style.display = 'flex';

    const onScroll = () => {
      state.paintDirty = true;
      state.rectDirty = true;
      hideTip();
    };
    state.listeners = { onScroll: onScroll, onMove: onMove };
    if (found.view.scrollDOM) found.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    state.el.addEventListener('mousemove', onMove);
    state.el.addEventListener('mouseleave', hideTip);

    // 代码框尺寸一变就立刻重排：展开/收起「Test Case」、拖动分栏、字体变化都走这里，
    // 不等 500ms 巡检，否则工具栏会明显滞后一截
    state.bottomBar = null;
    state.barLookupAt = 0;
    // 编辑器自己的 DOM 一变（重画行、改选区、换主题）就同帧重刷颜色：
    // CM6 会把 span 上的内联样式清掉，只靠 isConnected 判断不出来
    if (typeof MutationObserver === 'function') {
      if (state.paintObserver) state.paintObserver.disconnect();
      state.paintObserver = new MutationObserver(() => scheduleLayout());
      try {
        state.paintObserver.observe(found.view.contentDOM, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'], characterData: true });
      } catch (error) { /* 观察不了就算了 */ }
    }
    if (typeof ResizeObserver === 'function') {
      if (!state.resizeObserver) state.resizeObserver = new ResizeObserver(() => scheduleLayout());
      try { state.resizeObserver.observe(found.el.closest('.cm-editor') || found.el); } catch (error) { /* 观察不了就算了 */ }
      const bar = ensureBottomBar();
      if (bar) {
        try { state.resizeObserver.observe(bar); } catch (error) { /* 观察不了就算了 */ }
      }
    }

    updateBadge();
    post({ kind: 'hello', version: VERSION, language: readLanguage() });
    syncDoc(true);
    state.paintDirty = true;
    state.rectDirty = true;
  };

  /* ---------- 定时巡检 ---------- */

  const tick = () => {
    // PTA 是 SPA：换题只换 DOM，不刷新页面。所以编辑器被换掉这件事
    // 只能靠比对当前节点发现（500ms 一次，代价可以忽略）
    const found = findEditor();
    if (!found) {
      if (state.view) unbind();
      return;
    }
    if (found.el !== state.el || found.view !== state.view) bind(found);
    if (!state.view) return;

    syncDoc(false);
    layout();
    // CM6 重新渲染行（移动光标会重画当前行）之后旧 span 会被丢掉，颜色跟着没了。
    // 只要发现**任何**一个上过色的节点掉出文档就重刷一次：重刷本身很便宜（每行一次
    // posAtDOM），但漏掉的话看起来就是「光标一动颜色就没了」。
    if (!state.paintDirty && state.painted.some((span) => !span.isConnected || !span.style.color)) {
      state.paintDirty = true;
    }
    if (state.paintDirty) {
      state.paintDirty = false;
      paintRainbow();
    }
    if (state.rectDirty) {
      state.rectDirty = false;
      renderSquiggles();
    }
  };

  /* ---------- 来自隔离世界的指令 ---------- */

  const onMessage = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.__ptaEditorAssist !== TOKEN) return;

    if (data.kind === 'rainbow') {
      if (!FEATURES.rainbow || !state.view) return;
      // 文档在这几百毫秒里又变过：这批层数作废，等下一批
      if (data.text !== state.text) return;
      const marks = new Map();
      const list = Array.isArray(data.marks) ? data.marks : [];
      for (const mark of list) {
        if (!mark || typeof mark.at !== 'number' || typeof mark.depth !== 'number') continue;
        marks.set(mark.at, mark.depth);
      }
      state.marks = marks;
      state.paintDirty = true;
      return;
    }

    if (data.kind === 'format-apply') {
      if (!FEATURES.format || !state.view) return;
      // 用户在这几百毫秒里又敲了字：整条丢掉，绝不覆盖新内容
      if (data.source !== state.text) { toast('代码刚变过，这次整理取消了'); return; }
      const view = state.view;
      if (typeof data.text !== 'string' || data.text === state.text) {
        toast(data.summary || '代码已经是整齐的');
        return;
      }
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: data.text } });
      toast(data.summary || '已整理代码');
      state.paintDirty = true;
      state.rectDirty = true;
      return;
    }

    if (data.kind === 'diagnostics') {
      if (!FEATURES.check || !state.view) return;
      if (data.text !== state.text) return;
      state.boxes = Array.isArray(data.boxes) ? data.boxes : [];
      state.note = typeof data.note === 'string' ? data.note : '';
      updateBadge();
      state.rectDirty = true;
      return;
    }
  };

  const onResize = () => {
    state.paintDirty = true;
    state.rectDirty = true;
    hideTip();
  };

  // 统一的「尽快重排」入口：rAF 合帧，避免一次交互里连做好几次布局。
  // 点「Test Case」展开面板时页面不滚、窗口不变，只有代码框变矮——
  // 光靠 scroll/resize 事件是收不到的，所以下面还会挂 ResizeObserver。
  const scheduleLayout = () => {
    hideTip();
    // CM6 重画一行时会顺手清掉 span 上的内联样式，所以「重排」和「重刷颜色」一起做，
    // 否则就得等下一轮巡检才补回来——那就是用户看到的「颜色闪一下才回来」
    state.paintDirty = true;
    if (state.layoutFrame) return;
    state.layoutFrame = requestAnimationFrame(() => {
      state.layoutFrame = 0;
      if (state.paintDirty) {
        state.paintDirty = false;
        paintRainbow();
      }
      layout();
      renderSquiggles();
    });
  };

  // 整页滚动（整个作答面板一起动）不会触发编辑器自己的 scroll 事件，
  // 但波浪线和工具栏都是按视口坐标摆的，必须跟着重排
  const onPageScroll = () => {
    scheduleLayout();
  };

  /* ---------- 起停 ---------- */

  const destroy = () => {
    removeListeners();
    if (state.docTimer) clearTimeout(state.docTimer);
    if (state.toastTimer) clearTimeout(state.toastTimer);
    if (state.tickTimer) clearInterval(state.tickTimer);
    state.docTimer = 0;
    state.toastTimer = 0;
    state.tickTimer = 0;
    window.removeEventListener('message', onMessage);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onPageScroll, true);
    if (state.layoutFrame) cancelAnimationFrame(state.layoutFrame);
    if (state.resizeObserver) {
      try { state.resizeObserver.disconnect(); } catch (error) { /* 已经断了 */ }
      state.resizeObserver = null;
    }
    if (state.paintObserver) {
      try { state.paintObserver.disconnect(); } catch (error) { /* 已经断了 */ }
      state.paintObserver = null;
    }
    state.layoutFrame = 0;
    state.bottomBar = null;
    if (state.root) state.root.remove();
    state.root = null;
    state.bar = null;
    state.badge = null;
    state.squiggleLayer = null;
    state.tip = null;
    state.toastNode = null;
    state.painted = [];
    state.el = null;
    state.view = null;
    if (globalThis[KEY] && globalThis[KEY].token === TOKEN) delete globalThis[KEY];
  };

  window.addEventListener('message', onMessage);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onPageScroll, true);
  state.tickTimer = setInterval(tick, 500);
  // state 挂出来只为排查（真机上「染色为什么丢了」这类问题，没有它只能靠猜）
  globalThis[KEY] = { token: TOKEN, version: VERSION, destroy: destroy, state: state };

  tick();
  return { status: 'installed', token: TOKEN, version: VERSION };
})();`;
