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

import { scopeNamesAt } from '../shared/code-hints.ts';

/**
 * 把作用域扫描器的源码整段塞进页面脚本。
 *
 * 页面脚本是一整段字符串、没有模块系统，跑不了 import；
 * 而这个函数必须自包含（不引用模块里的任何东西），所以直接把它的源码搬过去最稳，
 * 也保证「页面里的那份」和「Node 单测的那份」永远是同一套逻辑。
 */
const SCOPE_SOURCE = '\nconst scopeNamesAt = ' + scopeNamesAt.toString() + ';\n';

export const EDITOR_AGENT_SOURCE = String.raw`return (() => {
  const ARGS = __args || {};
  const TOKEN = ARGS.token;
  const VERSION = ARGS.version || 0;
  // 标准库注释表按语言分开：C 的文件里不能拿 C++ 的名字（用户报过「C 里提示 std::map」）
  const DOCS_ALL = ARGS.docs || {};
  const docFor = (word, language) => {
    const table = /cpp|\+\+/i.test(language) ? (DOCS_ALL.cpp || DOCS_ALL.c || {}) : (DOCS_ALL.c || {});
    return table[word];
  };
  // 可变：运行中设置页改了开关，隔离世界会推一条 configure 过来
  const FEATURES = Object.assign({}, ARGS.features || {});
  // 代码提示的候选表：{ c: [...], cpp: [...] }，由后台按语言预先生成
  const COMPLETIONS = ARGS.completions || {};
  // 合字字体（连字符靠它渲染）：由后台传扩展内的 web-accessible 地址
  const FONT_URL = ARGS.fontUrl || '';
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

` + SCOPE_SOURCE + String.raw`
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
    barSlot: null,         // 工具栏嵌进底部状态栏时的容器
    barLookupAt: 0,
    resizeObserver: null,
    paintObserver: null,
    layoutFrame: 0,
    squiggleFrame: 0,
    indentLayer: null,     // 缩进引导线所在的层
    tipOwner: '',          // 'hover' / 'param' / 'diag'：谁在用那个提示框
    hint: null,            // 代码提示的下拉框
    hintItems: [],         // 当前候选
    hintIndex: 0,          // 当前高亮第几个
    hintFrom: 0,           // 这个前缀从哪个字符开始（补全时替换这段）
    hintOpen: false,
    hintDirty: true,       // 下一轮 tick 要不要重算候选
    freq: {},              // 补全项的历史使用次数
    gutterLayer: null,     // 行号栏图标层（return / 递归）
    geometry: '',          // 上一轮画图时的代码区几何（变了就重画）
    decorRoot: null,       // 缩进线/波浪线/图标的容器（挂在编辑器里）
    repaintTimer: 0,       // 「等 CM 量完再重画」的定时器
    hoverPos: -1,          // 鼠标所在的文档位置（-1 表示鼠标不在代码上）
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

  /**
   * 等 CodeMirror 把坐标缓存重算完之后，把浮层重画一次。
   *
   * 大段粘贴/整段替换之后，CM 要等自己那一轮 measure 跑完才知道每行在哪。
   * 我们在这之前拿 coordsAtPos 取到的是**上一版文档**的坐标——
   * 波浪线就会停在错的那一行（用户看到的「检查没有正确渲染」）。
   * 所以：文档一变就预约一次「量完之后重画」。
   */
  const scheduleMeasureRepaint = () => {
    const view = state.view;
    if (!view) return;
    if (typeof view.requestMeasure === 'function') {
      try {
        view.requestMeasure({
          read: () => { /* 读阶段：什么都不用做 */ },
          write: () => { state.rectDirty = true; },
        });
      } catch (error) { /* 老版本不支持这个参数，退回定时器 */ }
    }
    // 兜底：万一 requestMeasure 的回调没来（版本差异），120ms 后也重画一次
    if (state.repaintTimer) clearTimeout(state.repaintTimer);
    state.repaintTimer = setTimeout(() => {
      state.repaintTimer = 0;
      state.rectDirty = true;
    }, 120);
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

  /**
   * 装饰层的宿主：挂在**编辑器自己身上**，不是整页的浮层。
   *
   * 挂在整页时，缩进线/图标会压在提交弹窗之类的页面弹窗上面（我们的 z-index 比它高）；
   * 就算加一堆「有没有弹窗」的判断，也总有漏网的弹窗类型。放进编辑器里之后，
   * 页面弹窗的层级天然高于编辑器内容，盖住就是盖住，不需要猜。
   * 顺手解决了坐标：容器里用「相对编辑器左上角」的坐标，滚动/布局变化由容器自己跟着走。
   */
  const ensureDecorRoot = () => {
    const view = state.view;
    const host = view && view.dom;
    if (!host || typeof host.appendChild !== 'function') return null;
    if (state.decorRoot && state.decorRoot.isConnected && state.decorRoot.parentElement === host) {
      return state.decorRoot;
    }
    // CodeMirror 的 .cm-editor 一般已经是 relative；万一不是，补一个（只补一次）
    try {
      const position = getComputedStyle(host).position;
      if (!position || position === 'static') host.style.position = 'relative';
    } catch (error) { /* 量不到就算了，绝对定位也还是跟着最近的定位祖先走 */ }
    const root = make('div', 'position:absolute;left:0;top:0;width:100%;height:100%;'
      + 'pointer-events:none;overflow:hidden;z-index:1;');
    root.id = 'pta-assist-decor';
    host.appendChild(root);
    state.decorRoot = root;
    state.indentLayer = null;
    state.squiggleLayer = null;
    state.gutterLayer = null;
    return root;
  };

  const ensureSquiggleLayer = () => {
    const root = ensureDecorRoot();
    if (!root) return null;
    if (state.squiggleLayer && state.squiggleLayer.isConnected) return state.squiggleLayer;
    const layer = make('div', 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;');
    layer.id = 'pta-assist-squiggles';
    root.appendChild(layer);
    state.squiggleLayer = layer;
    return layer;
  };

  const renderSquiggles = () => {
    const layer = ensureSquiggleLayer();
    if (!layer) return;
    layer.textContent = '';
    state.rects = [];
    const view = state.view;
    if (!view || !FEATURES.check || state.boxes.length === 0) return;
    // 装饰层在编辑器内部：画的时候把视口坐标换成「相对编辑器左上角」的坐标。
    // 变量名要跟循环里的诊断分开：同名会被遮蔽，left/top 变成 undefined，
    // 画出来的线全落在 (0,0)——那就是「实时代码检查没有正确渲染」。
    const editorRect = editorBox();

    const doc = view.state.doc;
    for (const diag of state.boxes) {
      // note 只是补充说明，指的还是同一处，不单独画
      if (diag.severity !== 'error' && diag.severity !== 'warning') continue;
      if (doc.length === 0) continue;
      const at = Math.max(0, Math.min(diag.from, doc.length - 1));
      const line = doc.lineAt(at);
      // clang 说「这一行少了分号」时把位置指在行尾，落点就是换行符：
      // 往回退一个字符，否则 start/end 会跨到下一行，被下面的跨行判断吃掉，结果一条都画不出来
      const start = Math.min(Math.max(line.from, at), Math.max(line.from, line.to - 1));
      const end = Math.max(start + 1, Math.min(diag.to, line.to));
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
      const color = SEVERITY_COLOR[diag.severity] || SEVERITY_COLOR.error;
      const isError = diag.severity === 'error';
      // 错误用波浪线，警告用虚线：一眼能分清「必须改」和「最好改」
      const node = isError
        ? make('div', 'position:absolute;height:4px;background-repeat:repeat-x;'
          + 'background-position:left bottom;background-image:' + waveFor(color) + ';')
        : make('div', 'position:absolute;height:0;border-bottom:1px dashed ' + color + ';opacity:.85;');
      node.style.left = Math.round(left - editorRect.left) + 'px';
      node.style.top = Math.round(Math.max(a.top, a.bottom) - (isError ? 3 : 2) - editorRect.top) + 'px';
      node.style.width = Math.round(width) + 'px';
      layer.appendChild(node);

      // 命中区域往外扩一点：波浪线只有 4px 高，鼠标很难刚好压上
      state.rects.push({
        left: left - 3,
        right: left + width + 3,
        top: a.top - 3,
        bottom: a.bottom + 4,
        box: diag,
      });
    }
  };

  /* ---------- 悬浮提示 ---------- */

  // 提示框的样式抽出来：创建时用一次，之后只改内容与位置
  const TIP_CSS = 'position:absolute;display:none;max-width:340px;padding:8px 10px;border:1px solid #d0d3d9;'
    + 'border-radius:8px;background:#fff;color:#1f2329;box-shadow:0 6px 20px rgba(15,23,42,.18);'
    + 'pointer-events:none;white-space:pre-wrap;' + FONT;

  /**
   * 提示框节点。
   *
   * 跟代码提示的下拉框一样，在 bind() 里就建好，之后只改内容与位置。
   * 别改成「第一次要显示时才建」：那样会让节点跟着光标在巡检回调里反复增删，
   * 真机上观察起来更麻烦，也没有任何收益。
   */
  const ensureTip = () => {
    const root = ensureRoot();
    if (state.tip && state.tip.isConnected) return state.tip;
    const tip = make('div', TIP_CSS);
    tip.id = 'pta-assist-tip';
    root.appendChild(tip);
    state.tip = tip;
    return tip;
  };

  const hideTip = () => {
    state.tooltipKey = '';
    state.tipOwner = '';
    if (state.tip) state.tip.style.display = 'none';
  };

  /**
   * 只收起自己那一条：提示框是共用的（悬停注释、参数提示都往里写），
   * 鼠标移开时不能把光标那边的参数提示一起打掉。
   */
  const hideTipFrom = (owner) => {
    if (state.tipOwner && state.tipOwner !== owner) return;
    hideTip();
  };

  const showTip = (x, y, title, body, owner) => {
    const tip = ensureTip();
    const key = title + '|' + body;
    state.tipOwner = owner || 'hover';
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

  // 单词匹配的正则提到外面：每次新建正则会重新编译（同一个正则反复 exec 又有 lastIndex 的坑，
  // 所以用完要把 lastIndex 归零）
  const WORD_PATTERN = /[A-Za-z_][A-Za-z_0-9]*/g;

  // 光标落在哪个标识符上：返回词本身与它在文档里的区间。
  // 悬停高亮要区间（判断是不是函数调用要看词后面那个字符），只给词不够。
  const wordInfoAt = (pos) => {
    const view = state.view;
    if (!view) return null;
    const doc = view.state.doc;
    if (pos < 0 || pos > doc.length) return null;
    const line = doc.lineAt(pos);
    const text = line.text;
    const offset = Math.min(Math.max(pos - line.from, 0), text.length);
    WORD_PATTERN.lastIndex = 0;
    let match = WORD_PATTERN.exec(text);
    while (match) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        return { word: match[0], from: line.from + start, to: line.from + end };
      }
      match = WORD_PATTERN.exec(text);
    }
    return null;
  };

  const wordAt = (pos) => {
    const info = wordInfoAt(pos);
    return info ? info.word : null;
  };

  // 悬停注释：mousemove 一秒能来上百次，而 posAtCoords 要量位置（强制同步布局），
  // 每次都算一遍的话，在编辑器里挪鼠标就卡。所以把事件攒到下一帧再算：
  // 一帧最多算一次，视觉上察觉不出来。
  let hoverFrame = 0;
  let hoverX = 0;
  let hoverY = 0;

  const updateHover = (x, y) => {
    const view = state.view;
    const pos = view && typeof view.posAtCoords === 'function' ? view.posAtCoords({ x: x, y: y }) : null;
    const word = pos === null || pos === undefined ? '' : (wordAt(pos) || '');
    // 记住鼠标压在哪：Alt+Enter 要「鼠标优先」，不能只认输入光标
    state.hoverPos = word ? pos : -1;
    // 没 include 的标准库函数：最该给的是「一键导入」，比编译器的英文报错好用，
    // 所以压在警告上也优先显示它
    const header = word ? missingHeaderFor(word) : '';

    // 1) 压在波浪线上：报错比函数注释更要紧，先判它
    for (const rect of state.rects) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        if (header) {
          showTip(x, y, '缺 #include <' + header + '>',
            '这个函数在 <' + header + '> 里，按 Alt+Enter 一键导入。\n' + rect.box.advice, 'hover');
          return;
        }
        showTip(x, y, rect.box.message, rect.box.advice, 'hover');
        return;
      }
    }
    if (!FEATURES.hover) { hideTipFrom('hover'); return; }
    if (pos === null || pos === undefined || !word) { hideTipFrom('hover'); return; }
    if (header) {
      showTip(x, y, '缺 #include <' + header + '>',
        '这个函数在 <' + header + '> 里，按 Alt+Enter 一键导入。', 'hover');
      return;
    }
    const doc = docFor(word, readLanguage());
    if (!doc) { hideTipFrom('hover'); return; }
    showTip(x, y, word + '：' + doc.summary, doc.signature + (doc.note ? '\n' + doc.note : ''), 'hover');
  };

  const onMove = (event) => {
    hoverX = event.clientX;
    hoverY = event.clientY;
    if (hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      updateHover(hoverX, hoverY);
    });
  };

  // 鼠标移出代码框：把还没算的那一帧撤掉，别在离开之后又冒出个提示
  const onLeave = () => {
    if (hoverFrame) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
    }
    hideTipFrom('hover');
    state.hoverPos = -1;
  };

  /* ---------- 缩进线 ---------- */

  const INDENT_WIDTH = 4;

  /**
   * 代码区在视口里的矩形。
   *
   * 用整个编辑器（.cm-editor，含左侧行号栏）而不是 scrollDOM：
   * scrollDOM 只是正文的滚动容器，从它左边开始算，行号栏里的图标就会被挤到正文里。
   */
  const editorBox = () => {
    const candidates = [state.view && state.view.dom, state.view && state.view.scrollDOM, state.view && state.view.contentDOM, state.el];
    for (const node of candidates) {
      if (!node || typeof node.getBoundingClientRect !== 'function') continue;
      const rect = node.getBoundingClientRect();
      // 高度为 0 说明这个节点还没布局（或者测试环境里根本量不到），换下一个
      if (rect && rect.height > 0) return rect;
    }
    return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  };

  /** 代码区几何指纹：位置、尺寸、滚动位置任何一样变了都要重画浮层 */
  const geometrySignature = () => {
    const view = state.view;
    if (!view) return '';
    const box = editorBox();
    const scrollTop = view.scrollDOM ? Math.round(view.scrollDOM.scrollTop) : 0;
    return [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom), scrollTop].join(',');
  };

  const geometryChanged = () => {
    const now = geometrySignature();
    if (now === state.geometry) return false;
    state.geometry = now;
    return true;
  };

  /**
   * 一行在视口里的矩形。
   *
   * 优先读这一行**渲染出来的 DOM 元素**：coordsAtPos 用的是 CodeMirror 缓存的测量值，
   * 滚动之后要等它自己重算，中间那段时间图标/缩进线就停在旧位置上
   * （用户看到的「滚动时图标错位」）。DOM 矩形是同步的，不会晚一拍。
   */
  const lineRect = (line) => {
    const view = state.view;
    if (!view) return null;
    try {
      const info = view.domAtPos(line.from);
      let node = info && info.node;
      if (node && node.nodeType === 3) node = node.parentElement;
      let element = node;
      while (element && element.classList && !element.classList.contains('cm-line')) element = element.parentElement;
      if (element && typeof element.getBoundingClientRect === 'function') {
        const rect = element.getBoundingClientRect();
        if (rect && rect.height > 0) return rect;
      }
    } catch (error) { /* 拿不到就退回 coordsAtPos */ }
    try {
      const coords = view.coordsAtPos(line.from);
      if (coords) {
        return {
          top: coords.top,
          bottom: coords.bottom,
          height: coords.bottom - coords.top,
          left: coords.left,
          right: coords.right,
        };
      }
    } catch (error) { /* 都没有就算了 */ }
    return null;
  };

  /** 不要代码折叠：把折叠槽整个藏掉，行号栏只剩行号，图标也不会被箭头挤歪 */
  const FOLD_STYLE_ID = 'pta-assist-fold';
  const hideFoldGutter = () => {
    let style = document.getElementById(FOLD_STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = FOLD_STYLE_ID;
      document.head.appendChild(style);
    }
    // 选择器要压过 CodeMirror 自己的 [.ͼ1 .cm-gutter]{display:flex!important}：
    // 两边都是 !important 时比特异性，单类名赢不了，所以按层级写足
    const css = '.cm-editor .cm-gutters .cm-gutter.cm-foldGutter{display:none !important}';
    if (style.textContent !== css) style.textContent = css;
  };

  const ensureIndentLayer = () => {
    const root = ensureDecorRoot();
    if (!root) return null;
    if (state.indentLayer && state.indentLayer.isConnected) return state.indentLayer;
    const layer = make('div', 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;');
    layer.id = 'pta-assist-indent-guides';
    // 插到最前面：波浪线与工具栏都得盖在引导线上面
    root.insertBefore(layer, root.firstChild);
    state.indentLayer = layer;
    return layer;
  };

  const renderIndentGuides = () => {
    const layer = ensureIndentLayer();
    if (!layer) return;
    layer.textContent = '';
    const view = state.view;
    if (!view || !FEATURES.indentGuides) return;
    const doc = view.state.doc;
    // 代码区在视口里的位置：缩进线必须裁到这个矩形里，
    // 否则滚出视口的行、或者代码框被拖小以后，线会画到框外面去
    const box = editorBox();
    const ranges = view.visibleRanges && view.visibleRanges.length
      ? view.visibleRanges
      : [{ from: 0, to: doc.length }];

    // 先把可见行收成数组：空行要「借用」下面第一个非空行的缩进继续画线，
    // 否则 def bill(): 下面那种「空行 + Tab」的写法，线就断在有空行的地方
    const rows = [];
    const seen = {};
    for (const range of ranges) {
      let pos = Math.max(0, range.from);
      while (pos <= doc.length) {
        const line = doc.lineAt(pos);
        const key = String(line.from);
        if (!seen[key]) {
          seen[key] = true;
          rows.push({ line: line, blank: /^\s*$/.test(line.text) });
        }
        if (line.to >= doc.length) break;
        pos = line.to + 1;
      }
    }

    // 一行的每一层引导线画在哪个 x：按行首空白算，一个 Tab 算一个缩进宽度
    const guideXs = (line) => {
      const lead = /^[ \t]*/.exec(line.text)[0];
      if (!lead) return [];
      let columns = 0;
      for (let i = 0; i < lead.length; i += 1) columns += lead.charAt(i) === '\t' ? INDENT_WIDTH : 1;
      const levels = Math.floor(columns / INDENT_WIDTH);
      const xs = [];
      for (let level = 1; level <= levels; level += 1) {
        // 贴左：第一层在行首往后一格（一个空格宽），之后每层再往右一个缩进宽度
        const column = Math.min(lead.length, (level - 1) * INDENT_WIDTH + 1);
        let coords = null;
        try { coords = view.coordsAtPos(line.from + column); } catch (error) { coords = null; }
        if (coords) xs.push({ x: coords.left, level: level });
      }
      return xs;
    };

    // 从下往上算：空行拿不到自己的缩进，就沿用下面最近的、有缩进的那一行的线；
    // 但**画**的时候按从上到下的顺序，节点顺序跟行顺序一致（否则排查时看着是乱的）
    let nextXs = [];
    const draws = [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (!row.blank) nextXs = guideXs(row.line);
      if (!nextXs.length) continue;
      draws.push({ index: index, line: row.line, xs: nextXs });
    }
    draws.sort((a, b) => a.index - b.index);
    for (const item of draws) {
      const rect = lineRect(item.line);
      if (!rect) continue;
      const top = Math.max(rect.top, box.top);
      const bottom = Math.min(rect.bottom || rect.top + rect.height, box.bottom);
      if (bottom <= top + 1) continue;
      for (const guide of item.xs) {
        if (guide.x < box.left - 4 || guide.x > box.right + 4) continue;
        // 每层一个颜色，跟彩虹括号同一张色表：层级一眼分得清
        const node = make('div', 'position:absolute;width:1px;opacity:.55;background:'
          + COLORS[(guide.level - 1) % COLORS.length] + ';');
        node.style.left = Math.round(guide.x - box.left) + 'px';
        node.style.top = Math.round(top - box.top) + 'px';
        node.style.height = Math.round(bottom - top) + 'px';
        layer.appendChild(node);
      }
    }
  };

  /* ---------- 代码提示 ---------- */

  const ensureHint = () => {
    const root = ensureRoot();
    if (state.hint && state.hint.isConnected) return state.hint;
    const box = make('div', 'position:absolute;display:none;min-width:130px;max-height:200px;overflow:auto;'
      + 'border:1px solid #d0d3d9;border-radius:6px;background:#fff;color:#1f2329;padding:2px 0;'
      + 'box-shadow:0 6px 20px rgba(15,23,42,.18);pointer-events:auto;' + FONT);
    box.id = 'pta-assist-hint';
    root.appendChild(box);
    state.hint = box;
    return box;
  };

  const hideHints = () => {
    state.hintOpen = false;
    state.hintItems = [];
    state.hintIndex = 0;
    if (state.hint) {
      state.hint.style.display = 'none';
      // 内容也清掉：留着上一轮的候选，下次打开会先闪一下旧内容
      state.hint.textContent = '';
    }
  };

  /** 排序优先级：代码块 0、当前作用域的名字 1、常量 2、关键字 3、标准库 4 */
  const hintKindRank = (entry) => {
    if (!entry) return 4;
    if (entry.kind === 'block') return 0;
    if (entry.kind === 'variable' || entry.kind === 'function') return 1;
    if (entry.kind === 'constant') return 2;
    if (entry.kind === 'keyword') return 3;
    return 4;
  };

  // 光标左边那一段「词」：英文/数字/下划线，补全就是拿它当前缀
  const prefixAt = (pos) => {
    const view = state.view;
    if (!view) return '';
    const doc = view.state.doc;
    let start = pos;
    while (start > 0) {
      const ch = doc.sliceString(start - 1, start);
      if (!/[A-Za-z0-9_]/.test(ch)) break;
      start -= 1;
    }
    return doc.sliceString(start, pos);
  };

  // 前缀匹配：只管「开头对得上」。
  // 「整词打全就不再提示」这条规则放在调用处判断——带结构的代码块是例外
  // （for 打全了还要提示，因为它要展开成 for (;;) { }）。
  const matchesPrefix = (label, prefix) => {
    return label.toLowerCase().indexOf(prefix.toLowerCase()) === 0;
  };

  /** 补全项的分组标题（跟 IDEA 一样分块显示） */
  const hintGroupLabel = (item) => {
    const kind = item && item.kind;
    if (kind === 'block') return '代码块';
    if (kind === 'variable') return '变量';
    if (kind === 'function') return '函数';
    if (kind === 'constant') return '常量';
    if (kind === 'keyword') return '关键字';
    return '标准库';
  };

  const drawHints = () => {
    const box = ensureHint();
    box.textContent = '';
    let group = '';
    for (let i = 0; i < state.hintItems.length; i += 1) {
      const item = state.hintItems[i];
      const label = hintGroupLabel(item);
      if (label !== group) {
        group = label;
        const head = make('div', 'padding:3px 10px 1px;color:#8a93a6;font-size:11px;'
          + 'border-top:1px solid #eef0f4;margin-top:2px;', label);
        head.style.pointerEvents = 'none';
        box.appendChild(head);
      }
      const on = i === state.hintIndex;
      const row = make('div', 'padding:2px 10px;cursor:pointer;white-space:nowrap;font-size:12px;'
        + (on ? 'background:#2f6bff;color:#fff;' : ''), item.label);
      row.addEventListener('mousedown', (event) => {
        // 用 mousedown 而不是 click：click 之前焦点会先跑走，光标位置就变了
        event.preventDefault();
        event.stopPropagation();
        state.hintIndex = i;
        acceptHint();
      });
      box.appendChild(row);
    }
    box.style.display = 'block';
  };


  const updateHints = () => {
    if (!FEATURES.codeHints || !state.view) { hideHints(); return; }
    const language = readLanguage();
    const kind = language === 'cpp' ? 'cpp' : language === 'c' ? 'c' : '';
    const base = kind ? (COMPLETIONS[kind] || []) : [];
    const constants = COMPLETIONS.constants || [];
    const view = state.view;
    const head = view.state.selection.main.head;
    const prefix = prefixAt(head);
    // 打第一个字符就提示（IDE 就是这样）：太长的前缀反而让用户等
    if (!prefix) { hideHints(); return; }

    // 当前作用域里能看见的名字：用户自己的函数、变量、宏、常量
    let scope = [];
    try {
      scope = scopeNamesAt(view.state.doc.toString(), head) || [];
    } catch (error) { scope = []; }
    const scopeEntries = scope.map((item) => ({
      label: item.name,
      header: item.header || null,
      kind: item.kind === 'function' ? 'function' : (item.kind === 'constant' ? 'constant' : (item.kind === 'macro' ? 'constant' : 'variable')),
    }));

    const seen = {};
    const candidates = [];
    for (const item of scopeEntries.concat(base).concat(constants)) {
      if (!item || typeof item.label !== 'string') continue;
      // 整词打全的普通候选不再提示（否则每敲完一个词都弹一条一模一样的，纯噪音）；
      // 但**带结构的代码块**还要提示：for → for (;;) { }，正是要的那一下
      if (item.label === prefix && !item.snippet) continue;
      if (!matchesPrefix(item.label, prefix)) continue;
      if (seen[item.label]) continue;
      seen[item.label] = true;
      candidates.push(item);
    }
    if (!candidates.length) { hideHints(); return; }
    // 优先级：代码块 > 当前作用域的名字 > 常量 > 关键字 > 标准库；
    // 同档里按历史使用次数，再按名字（顺序稳定，不会每次跳）
    candidates.sort((a, b) => {
      const rankA = hintKindRank(a);
      const rankB = hintKindRank(b);
      if (rankA !== rankB) return rankA - rankB;
      const left = state.freq[a.label] || 0;
      const right = state.freq[b.label] || 0;
      if (left !== right) return right - left;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
    state.hintItems = candidates.slice(0, 25);
    state.hintFrom = head - prefix.length;
    if (state.hintIndex >= state.hintItems.length) state.hintIndex = 0;
    state.hintOpen = true;
    drawHints();
    const box = state.hint;
    if (!box) return;
    let coords = null;
    try { coords = view.coordsAtPos(head); } catch (error) { coords = null; }
    if (!coords) { hideHints(); return; }
    const width = box.offsetWidth || 140;
    const height = box.offsetHeight || 120;
    let left = coords.left;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    let top = coords.bottom + 4;
    if (top + height > window.innerHeight - 8) top = Math.max(8, coords.top - height - 4);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
  };



  // 补全时缺的头文件顺手补上：只补「已经确定属于这个头」的那些名字
  const ensureInclude = (header) => {
    const view = state.view;
    if (!view) return;
    const doc = view.state.doc;
    const text = doc.toString();
    if (text.indexOf('#include <' + header + '>') >= 0) return;
    if (text.indexOf('#include "' + header + '"') >= 0) return;
    let insertAt = 0;
    for (let i = 1; i <= doc.lines; i += 1) {
      const line = doc.line(i);
      if (/^\s*#\s*include\b/.test(line.text)) insertAt = line.to;
    }
    if (insertAt > 0) {
      view.dispatch({ changes: { from: insertAt, to: insertAt, insert: '\n#include <' + header + '>' } });
    } else {
      view.dispatch({ changes: { from: 0, to: 0, insert: '#include <' + header + '>\n' } });
    }
  };

  /**
   * 这个名字属于哪个标准库头文件——**而且文件里还没 include**。
   * 返回 null 表示不需要提示（本来就有、或者不是标准库名字）。
   */
  const missingHeaderFor = (word) => {
    const view = state.view;
    if (!view || !word) return '';
    const lang = readLanguage();
    const list = /\+\+|cpp/i.test(lang) ? (COMPLETIONS.cpp || []) : (COMPLETIONS.c || []);
    let header = '';
    for (const item of list) {
      if (item && item.label === word && item.header) { header = item.header; break; }
    }
    if (!header) return '';
    const text = view.state.doc.toString();
    if (text.indexOf('#include <' + header + '>') >= 0) return '';
    if (text.indexOf('#include "' + header + '"') >= 0) return '';
    return header;
  };

  /**
   * Alt+Enter：把「鼠标下面那个函数」（没鼠标时用输入光标那个）缺的头文件补上。
   *
   * 鼠标优先：用户盯着某个函数按快捷键时，输入光标往往还在别处（甚至没点进代码框），
   * 只认光标会修错地方。
   */
  const importHeaderAtCursor = () => {
    const view = state.view;
    if (!view) return false;
    const head = view.state.selection.main.head;
    const spots = [];
    if (typeof state.hoverPos === 'number' && state.hoverPos >= 0) spots.push(state.hoverPos);
    spots.push(head, Math.max(0, head - 1));
    for (const spot of spots) {
      const word = wordAt(spot);
      if (!word) continue;
      const header = missingHeaderFor(word);
      if (!header) continue;
      ensureInclude(header);
      hideTipFrom('hover');
      toast('已导入 #include <' + header + '>');
      state.paintDirty = true;
      state.rectDirty = true;
      return true;
    }
    return false;
  };

  /** 停用（或重新启用）PTA 自带的补全：开着我们的补全时，两个下拉框会叠在一起 */
  const PTA_COMPLETION_STYLE_ID = 'pta-assist-pta-completion';
  const syncPtaCompletionStyle = () => {
    let style = document.getElementById(PTA_COMPLETION_STYLE_ID);
    if (!FEATURES.codeHints) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = PTA_COMPLETION_STYLE_ID;
      document.head.appendChild(style);
    }
    // 只藏 DOM 不够：它还会抢 Enter/Tab（见 onKeyDown 的按键拦截），否则用户回车会
    // 悄悄接受一个看不见的候选（"private" 这种 C++ 词就是这么进 C 文件的）
    const css = '.cm-tooltip-autocomplete{display:none !important}';
    if (style.textContent !== css) style.textContent = css;
  };

  /** PTA 自己的补全下拉正开着（DOM 里存在就说明它还在等按键） */
  const ptaCompleting = () => {
    const view = state.view;
    const dom = view && view.dom;
    return !!(dom && typeof dom.querySelector === 'function' && dom.querySelector('.cm-tooltip-autocomplete'));
  };

  /** 自己插入一个换行（带当前行的缩进；行尾是左花括号时多缩一层） */
  const insertNewline = () => {
    const view = state.view;
    if (!view) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const before = line.text.slice(0, Math.max(0, head - line.from));
    const indent = /^[ \t]*/.exec(before)[0];
    const extra = /\{[ \t]*$/.test(before) ? ' '.repeat(4) : '';
    const insert = '\n' + indent + extra;
    view.dispatch({ changes: { from: head, insert: insert }, selection: { anchor: head + insert.length } });
  };

  /**
   * 把模板按当前缩进铺开。
   *
   * 模板本身是相对缩进（第一行 0、第二行 +4），插到有缩进的位置时，
   * 后续每一行都要补上当前行的缩进，光标位置也要跟着挪。
   */
  const buildSnippetText = (text, caret, indent) => {
    const lines = String(text).split('\n');
    let out = '';
    let position = caret;
    let original = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (index > 0) {
        out += '\n';
        // 补进来的缩进会把后面的字符往后推，光标也要跟着挪
        if (position >= original) position += indent.length;
        out += indent;
      }
      out += line;
      original += line.length + 1;
    }
    return { text: out, caret: position };
  };

  const acceptHint = () => {
    if (!state.hintOpen || !state.view) return;
    const item = state.hintItems[state.hintIndex];
    if (!item) { hideHints(); return; }
    const view = state.view;
    const head = view.state.selection.main.head;
    const from = Math.min(state.hintFrom, head);
    hideHints();
    const snippet = item.snippet;
    if (snippet && snippet.text) {
      // 关键字模板：整段结构一次插好，光标停在模板标注的位置（比如 while 的条件括号里）。
      // 模板的后续行要按**当前行的缩进**对齐：在缩进 8 格的地方插 for 模板，
      // 模板里的收尾花括号与空行也得缩进 8 格，否则就是
      //     for (;;) {
      //         ← 没缩进
      // }                        ← 跑到最左边
      const line = view.state.doc.lineAt(head);
      const indent = /^[ \t]*/.exec(line.text)[0];
      const built = buildSnippetText(snippet.text, snippet.caret, indent);
      const anchor = from + built.caret;
      view.dispatch({
        changes: { from: from, to: head, insert: built.text },
        selection: { anchor: anchor },
      });
    } else {
      view.dispatch({ changes: { from: from, to: head, insert: item.label } });
    }
    if (item.header) ensureInclude(item.header);
    // 让隔离世界给这个名字记一次使用，下次它排前面
    post({ kind: 'hint-used', label: item.label });
    state.hintDirty = true;
    state.paintDirty = true;
    state.rectDirty = true;
  };


  // 键盘：挂在 window 的捕获阶段。CodeMirror 自己的 keymap 也在 contentDOM 上监听 keydown，
  // 同样挂在一个节点上时按注册顺序跑（它先注册），拦截不到；捕获阶段才一定在它前面。
  const onKeyDown = (event) => {
    if (!state.el || !event.target || !state.el.contains(event.target)) return;
    if (event.isComposing) return;
    // Alt+Enter：标准库函数缺头文件时一键导入（下拉没开也要能用）
    if (event.key === 'Enter' && event.altKey && !event.ctrlKey && !event.metaKey) {
      if (importHeaderAtCursor()) { event.preventDefault(); event.stopPropagation(); return; }
    }
    // 我们的下拉没开、PTA 的却开着：它的下拉框被我们藏起来了，但它还会抢 Enter/Tab
    // （用户回车会接受一个看不见的候选）。这些键自己处理，别让它吃。
    if (!state.hintOpen && FEATURES.codeHints && ptaCompleting()
      && (event.key === 'Enter' || event.key === 'Tab' || event.key === 'ArrowDown'
        || event.key === 'ArrowUp' || event.key === 'Escape')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') insertNewline();
      return;
    }
    if (!state.hintOpen) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const count = state.hintItems.length || 1;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.hintIndex = (state.hintIndex + delta + count) % count;
      drawHints();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      acceptHint();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      hideHints();
    }
  };

  /* ---------- 连字符（>= 变 ⩾） ---------- */

  /* ---------- 连字符（合字字体渲染，代码文本不变） ---------- */

  const LIGATURE_STYLE_ID = 'pta-assist-ligature';
  const LIGATURE_FAMILY = 'PTA Assist Ligatures';

  /**
   * 连字符不再改写输入的字符，而是给代码区换一套**带合字的等宽字体**：
   * 大于等于画成 ⩾、不等于画成 ≠、双等号、箭头、逻辑与或也各自成合字，
   * 编辑器里的文本仍然是 ASCII——复制出去、提交给编译器都不受影响。
   *
   * 样式挂在页面 head 上（不是浮层里）：要影响的是 CodeMirror 自己的节点。
   * 必须显式打开 font-variant-ligatures / calt：不少编辑器主题会把它关掉。
   */
  const syncLigatureFont = () => {
    const existing = document.getElementById(LIGATURE_STYLE_ID);
    if (!FEATURES.hyphenate || !FONT_URL) {
      if (existing) existing.remove();
      return;
    }
    let style = existing;
    if (!style) {
      style = document.createElement('style');
      style.id = LIGATURE_STYLE_ID;
      document.head.appendChild(style);
    }
    const stack = '"' + LIGATURE_FAMILY + '", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const css = '@font-face{font-family:"' + LIGATURE_FAMILY + '";src:url("' + FONT_URL + '") format("woff2");'
      + 'font-weight:400;font-style:normal;font-display:swap;}'
      + '.cm-editor .cm-content,.cm-editor .cm-line,.cm-editor .cm-content *{'
      + 'font-family:' + stack + ' !important;'
      + 'font-variant-ligatures:normal !important;'
      + 'font-feature-settings:"calt" 1,"liga" 1 !important;}';
    if (style.textContent === css) return;
    style.textContent = css;

    // 字体是异步加载的：换字体会改变字宽，加载完让 CodeMirror 重新量一次，
    // 否则光标/波浪线的位置会按旧字宽算，错开一点
    const fonts = document.fonts;
    if (fonts && typeof fonts.load === 'function') {
      fonts.load('14px "' + LIGATURE_FAMILY + '"').then(() => {
        state.paintDirty = true;
        state.rectDirty = true;
        try { if (state.view) state.view.requestMeasure(); } catch (error) { /* 量不了就算了 */ }
      }).catch(() => undefined);
    }
  };

  /* ---------- 行号栏图标：return / 递归 ---------------- */

  const GUTTER_ICON_STYLE = 'position:absolute;pointer-events:none;font:11px/1 -apple-system,sans-serif;'
    + 'color:#8a93a6;text-align:right;';

  const ensureGutterLayer = () => {
    const root = ensureDecorRoot();
    if (!root) return null;
    if (state.gutterLayer && state.gutterLayer.isConnected) return state.gutterLayer;
    const layer = make('div', 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;');
    layer.id = 'pta-assist-gutter-icons';
    root.insertBefore(layer, root.firstChild);
    state.gutterLayer = layer;
    return layer;
  };

  /**
   * 找出这一行所在的函数：往上按花括号配对，跳过 if/for/while 这些块，
   * 最后读「{ 前面的那段」里的最后一个 名字(……)。返回函数名和定义那一行。
   */
  const enclosingFunctionName = (doc, lineStart) => {
    const text = doc.toString();
    const KEYWORDS = /^(if|for|while|switch|do|else|catch|sizeof)$/;
    let depth = 0;
    for (let i = lineStart; i >= 0; i -= 1) {
      const ch = text.charAt(i);
      if (ch === '}') { depth += 1; continue; }
      if (ch !== '{') continue;
      if (depth > 0) { depth -= 1; continue; }
      const before = text.slice(Math.max(0, i - 200), i).replace(/\s+$/, '');
      const match = /([A-Za-z_]\w*)\s*\([^()]*\)$/.exec(before);
      const name = match ? match[1] : '';
      if (name && !KEYWORDS.test(name)) return { name: name, header: doc.lineAt(i).number };
    }
    return { name: '', header: 0 };
  };

  /**
   * 行号栏图标：return 画「回车」，递归调用画「刷新」。
   *
   * 递归的判定是启发式的：这一行调用了「所在函数自己的名字」就算。
   * 同一行既是 return 又是递归时按用户要求只画刷新图标。
   */
  const renderGutterIcons = () => {
    const layer = ensureGutterLayer();
    if (!layer) return;
    layer.textContent = '';
    const view = state.view;
    if (!view) return;
    const dom = view.dom;
    const pick = (selector) => (dom && typeof dom.querySelector === 'function' ? dom.querySelector(selector) : null);
    // 贴着**行号栏**的右缘：锚在整个 .cm-gutters 上时，右边还有折叠槽，
    // 折叠槽宽度一变（展开/收起代码）图标就跟着漂
    const gutter = pick('.cm-lineNumbers') || pick('.cm-gutters');
    if (!gutter) return;
    const gutterRect = gutter.getBoundingClientRect();
    const box = editorBox();
    const left = Math.min(Math.max(gutterRect.right - 16, box.left), Math.max(box.left, box.right - 16));
    const doc = view.state.doc;
    const ranges = view.visibleRanges && view.visibleRanges.length ? view.visibleRanges : [{ from: 0, to: doc.length }];
    const seen = {};
    for (const range of ranges) {
      let pos = Math.max(0, range.from);
      while (pos <= doc.length) {
        const line = doc.lineAt(pos);
        const key = String(line.from);
        if (!seen[key]) {
          seen[key] = true;
          const hasReturn = /\breturn\b/.test(line.text);
          const fn = enclosingFunctionName(doc, line.from);
          const isRecursive = !!fn.name
            && new RegExp('\\b' + fn.name + '\\s*\\(').test(line.text)
            // 函数自己那一行（定义/声明）不算递归调用
            && fn.header !== line.number;
          if (hasReturn || isRecursive) {
            const rect = lineRect(line);
            if (rect && rect.top >= box.top - 2 && rect.top < box.bottom) {
              const node = make('div', GUTTER_ICON_STYLE + 'width:14px;', isRecursive ? '\u21BB' : '\u21B5');
              node.title = isRecursive ? '递归调用' : 'return 语句';
              node.style.left = Math.round(left - box.left) + 'px';
              node.style.top = Math.round(rect.top - box.top) + 'px';
              node.style.height = Math.round(rect.height || 18) + 'px';
              node.style.display = 'flex';
              node.style.alignItems = 'center';
              node.style.justifyContent = 'flex-end';
              layer.appendChild(node);
            }
          }
        }
        if (line.to >= doc.length) break;
        pos = line.to + 1;
      }
    }
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

  /**
   * 把工具栏真正塞进「Test Case」所在的那条状态栏，而不是浮在它上面。
   * 找不到 Test Case 按钮时退化为追加到栏尾；PTA 重渲染把 slot 删掉时会重建。
   */
  const attachBarToBottomBar = (bottomBar) => {
    if (!state.bar) return;
    let slot = state.barSlot;
    if (!slot || !slot.isConnected || !bottomBar.contains(slot)) {
      slot = make('div', 'display:flex;align-items:center;gap:6px;flex:none;margin-left:8px;pointer-events:auto;');
      slot.id = 'pta-assist-bar-slot';
      const testCase = Array.from(bottomBar.querySelectorAll('button'))
        .find((node) => /^(Test Case|测试用例)$/.test((node.innerText || '').trim()));
      if (testCase && testCase.parentElement) testCase.after(slot);
      else bottomBar.appendChild(slot);
      state.barSlot = slot;
    }
    if (state.bar.parentElement !== slot) {
      slot.appendChild(state.bar);
      state.bar.style.position = 'static';
      state.bar.style.left = '';
      state.bar.style.top = '';
      state.bar.style.margin = '0';
      state.bar.style.pointerEvents = 'auto';
      state.bar.style.visibility = 'visible';
    }
  };

  /** 底部状态栏不可用时，把工具栏还给 fixed 浮层 */
  const detachBarToOverlay = () => {
    if (!state.bar || !state.root) return;
    if (state.barSlot) {
      state.barSlot.remove();
      state.barSlot = null;
    }
    if (state.bar.parentElement !== state.root) {
      state.root.appendChild(state.bar);
      state.bar.style.position = 'absolute';
      state.bar.style.left = '';
      state.bar.style.top = '';
      state.bar.style.margin = '';
      state.bar.style.pointerEvents = 'none';
    }
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
      attachBarToBottomBar(bar);
      state.bar.style.visibility = 'visible';
      return;
    }
    // 没有那条状态栏（面板收起之类）就退回代码框右下角内部
    detachBarToOverlay();
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
    state.hintDirty = true;
    // 文档变了：CM 的坐标缓存还没更新，先约一次「量完之后重画」
    scheduleMeasureRepaint();
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
      state.el.removeEventListener('mouseleave', onLeave);
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
    if (state.indentLayer) state.indentLayer.textContent = '';
    if (state.gutterLayer) state.gutterLayer.textContent = '';
    hideHints();
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
    ensureIndentLayer();
    ensureHint();
    ensureTip();
    hideHints();
    if (state.bar && state.bar.childElementCount > 0) state.bar.style.display = 'flex';

    const onScroll = () => {
      state.paintDirty = true;
      state.rectDirty = true;
      hideTip();
      // 缩进线/波浪线都是按视口坐标摆的：滚动要同帧重排，不能等下一轮巡检
      scheduleLayout();
    };
    state.listeners = { onScroll: onScroll, onMove: onMove };
    if (found.view.scrollDOM) found.view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    state.el.addEventListener('mousemove', onMove);
    state.el.addEventListener('mouseleave', onLeave);

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
    state.hintDirty = true;
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
      renderIndentGuides();
      renderGutterIcons();
    }
    // 页面布局变了（侧栏收起、面板打开、Test Case 展开…）却没有任何事件通知我们：
    // 行号图标 / 缩进线 / 波浪线就会停在旧位置。这里每轮比一次几何签名，变了就重画。
    if (geometryChanged()) state.rectDirty = true;
    if (state.hintDirty) {
      state.hintDirty = false;
      updateHints();
    }

  };

  /* ---------- 来自隔离世界的指令 ---------- */

  const onMessage = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.__ptaEditorAssist !== TOKEN) return;

    if (data.kind === 'configure') {
      // 设置页改了开关：就地生效，不重新注入（重新注入会丢光标与文档状态）
      if (data.features && typeof data.features === 'object') Object.assign(FEATURES, data.features);
      if (data.freq && typeof data.freq === 'object') state.freq = data.freq;
      syncPtaCompletionStyle();
      if (!FEATURES.codeHints) hideHints();
      syncLigatureFont();
      state.hintDirty = true;
      state.rectDirty = true;
      state.paintDirty = true;
      // 工具栏按钮是安装时按功能建好的：check / format 没变，不用重建
      return;
    }

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
      scheduleMeasureRepaint();
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
      // 改代码框大小、滚动、切题都在这里同帧重排：缩进线和行号图标必须跟着重画，
      // 否则会停在旧位置（用户看到的「错位、画到框外」）
      renderIndentGuides();
      renderGutterIcons();
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
    window.removeEventListener('keydown', onKeyDown, true);
    const ligatureStyle = document.getElementById(LIGATURE_STYLE_ID);
    if (ligatureStyle) ligatureStyle.remove();
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
    if (state.barSlot) {
      state.barSlot.remove();
      state.barSlot = null;
    }
    if (state.bar && state.bar.parentElement && state.bar.parentElement !== state.root) {
      state.bar.remove();
    }
    if (state.root) state.root.remove();
    state.root = null;
    state.bar = null;
    state.badge = null;
    state.squiggleLayer = null;
    state.tip = null;
    state.toastNode = null;
    state.indentLayer = null;
    state.gutterLayer = null;
    state.hint = null;
    state.hintItems = [];
    state.hintOpen = false;
    state.hintDirty = true;
    state.freq = {};
    state.tipOwner = '';
    state.painted = [];
    state.el = null;
    state.view = null;
    if (globalThis[KEY] && globalThis[KEY].token === TOKEN) delete globalThis[KEY];
  };

  window.addEventListener('message', onMessage);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onPageScroll, true);
  // 补全的按键与 >= 的替换都要抢在 CodeMirror 前面，所以用捕获阶段
  window.addEventListener('keydown', onKeyDown, true);
  syncLigatureFont();
  syncPtaCompletionStyle();
  hideFoldGutter();
  state.tickTimer = setInterval(tick, 500);
  // state 挂出来只为排查（真机上「染色为什么丢了」这类问题，没有它只能靠猜）
  globalThis[KEY] = { token: TOKEN, version: VERSION, destroy: destroy, state: state };

  tick();
  return { status: 'installed', token: TOKEN, version: VERSION };
})();`;
