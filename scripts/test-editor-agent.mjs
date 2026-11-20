// 「作答区增强」页面 agent（src/background/editor-agent.ts 里的 EDITOR_AGENT_SOURCE）的 jsdom 测试。
//
// 思路和 scripts/test-pta-tools.mjs 一致：在 jsdom 里搭一个假 CodeMirror 6，
// EditorView 挂在 .cm-content 的 cmTile.view 上（PTA 页面的真实位置），
// 源码用页面 realm 的 AsyncFunction 执行（先注入 __args 再跑源码字符串），
// 和插件里 injectScript 的注入方式同构。
// 隔离世界 ↔ agent 的来回都走 window.postMessage / window.dispatchEvent('message')。
//
// 用法：node scripts/test-editor-agent.mjs
import { JSDOM } from 'jsdom';
import { EDITOR_AGENT_SOURCE } from '../src/background/editor-agent.ts';
import { RAINBOW_COLORS } from '../src/shared/code-brackets.ts';
import { completionsFor, constantEntries } from '../src/shared/code-hints.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 下标 1 必须是括号：rainbow 消息只给「真的是括号字符」的位置上色
const INITIAL_TEXT = 'f(1);\nf(2);';
const TOKEN = 'test-token-editor-agent';
const NOTE = '内置编译器只支持 C，其他语言不做实时检查';
const ERROR_BOX = { from: 0, to: 1, severity: 'error', message: "expected ';'", advice: '少分号' };
const WARN_BOX = { from: 0, to: 1, severity: 'warning', message: 'w', advice: 'a' };

const INSTALL_ARGS = {
  token: TOKEN,
  version: 1,
  docs: { printf: { signature: 'int printf(const char *fmt, ...);', summary: '按格式串输出' } },
  features: { format: true, rainbow: true, check: true, hover: true },
};

/**
 * 假 CodeMirror 6。只实现 agent 真正用到的那几个接口：
 *   state.doc（length / toString / sliceString / lineAt）、dispatch、domAtPos、
 *   coordsAtPos、posAtCoords、visibleRanges、scrollDOM。
 * DOM 结构按真机：.cm-editor > .cm-scroller > .cm-content[contenteditable]
 * 里面每行一个 .cm-line，行内每个字符一个 span（agent 只给单字符 span 上色）。
 */
function createEditorPage(initialText) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-1 函数题</title></head><body></body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/problems/1150901824503297/description',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = dom.window;
  const document = window.document;

  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  // 真机结构里行号栏在 .cm-editor 里的 .cm-gutters 下：行号图标要挂在它旁边
  const gutters = document.createElement('div');
  gutters.className = 'cm-gutters';
  editor.appendChild(gutters);
  const scroller = document.createElement('div');
  scroller.className = 'cm-scroller';
  const content = document.createElement('div');
  content.className = 'cm-content';
  content.setAttribute('contenteditable', 'true');
  scroller.appendChild(content);
  editor.appendChild(scroller);

  // 真机结构：编辑器在 CodingProblemAnswerForm 里，后面紧跟「Test Case」状态栏。
  // 工具栏应该嵌进这条栏，而不是浮在它上面。
  const form = document.createElement('div');
  form.className = 'CodingProblemAnswerForm';
  form.appendChild(editor);
  const bottomBar = document.createElement('div');
  bottomBar.className = 'testcase-bar';
  bottomBar.id = 'testcase-bar';
  const testCaseButton = document.createElement('button');
  testCaseButton.type = 'button';
  testCaseButton.textContent = 'Test Case';
  bottomBar.appendChild(testCaseButton);
  document.body.append(form, bottomBar);

  const rect = (width, height, top) => ({
    width, height, top, bottom: top + height, left: 0, right: width, x: 0, y: top,
    toJSON: () => ({}),
  });
  form.getBoundingClientRect = () => rect(600, 240, 0);
  editor.getBoundingClientRect = () => rect(600, 200, 0);
  gutters.getBoundingClientRect = () => rect(28, 200, 0);
  bottomBar.getBoundingClientRect = () => rect(600, 32, 200);

  let doc = initialText;
  // 光标位置：真 CM6 里在 state.selection.main.head，新功能（补全）要用
  let head = initialText.length;
  let lines = [];
  // 每个字符下标对应的 span 与其单字符文本节点；换行位置留 null
  let chars = [];

  const splitLines = (value) => {
    const out = [];
    let from = 0;
    let number = 0;
    for (const text of value.split('\n')) {
      number += 1;
      out.push({ from, to: from + text.length, text, number });
      from += text.length + 1;
    }
    return out;
  };
  const lineIndexAt = (pos) => {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (pos >= lines[index].from) return index;
    }
    return 0;
  };

  // 真 CM6 在事务之后重建视图 DOM。这里同样重建 cm-content 的子节点，
  // 但保留 .cm-content 元素本身：agent 靠 el/view 的引用判断「换没换编辑器」，
  // 换掉节点就会被当成 SPA 换题重新 bind，噪声很大。
  const render = () => {
    content.textContent = '';
    lines = splitLines(doc);
    chars = new Array(doc.length).fill(null);
    for (const line of lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'cm-line';
      for (let index = 0; index < line.text.length; index += 1) {
        const span = document.createElement('span');
        span.textContent = line.text[index];
        lineEl.appendChild(span);
        chars[line.from + index] = { span, text: span.firstChild };
      }
      content.appendChild(lineEl);
    }
  };

  const docFacade = () => ({
    length: doc.length,
    lines: lines.length,
    toString: () => doc,
    sliceString: (from, to) => doc.slice(from, to),
    lineAt: (pos) => lines[lineIndexAt(pos)],
    line: (n) => lines[Math.max(0, Math.min(lines.length - 1, n - 1))],
  });

  const view = {
    get state() {
      return { doc: docFacade(), readOnly: false, selection: { main: { head } } };
    },
    // 缩进线要用它拿行高
    lineBlockAt: (pos) => {
      const top = lineIndexAt(pos) * 18;
      return { top, height: 18 };
    },
    get visibleRanges() {
      return [{ from: 0, to: doc.length }];
    },
    // agent 在上面挂 scroll 监听；顺便给个尺寸，缩进线/行号图标要按它裁
    scrollDOM: Object.assign(new window.EventTarget(), { getBoundingClientRect: () => rect(600, 200, 0) }),
    dom: editor,
    dispatch: (transaction) => {
      const change = transaction && transaction.changes;
      if (!change || typeof change.from !== 'number') return;
      // 和 test-pta-tools 一样：{from, insert} 不写 to 就表示在 from 处插入
      const to = typeof change.to === 'number' ? change.to : change.from;
      const inserted = change.insert ?? '';
      doc = doc.slice(0, change.from) + inserted + doc.slice(to);
      // 光标跟着事务走：真 CM6 里 dispatch 之后 selection 就是这个新位置；
      // 事务里显式给了 selection（模板补全要落在大括号中间）就按它来
      const explicit = transaction.selection;
      head = explicit && typeof explicit.anchor === 'number'
        ? explicit.anchor
        : change.from + inserted.length;
      render();
    },
    domAtPos: (pos) => {
      const char = chars[pos];
      if (char) return { node: char.text, offset: 0 };
      // 换行位置没有 span：交出所在行元素，agent 见到多字符节点会自己跳过
      const index = Math.min(lineIndexAt(pos), content.children.length - 1);
      return { node: content.children[index], offset: 0 };
    },
    coordsAtPos: (pos) => {
      const top = lineIndexAt(pos) * 18;
      return { left: pos * 7, right: pos * 7 + 7, top, bottom: top + 18 };
    },
    // coordsAtPos 的逆：x/7 就是字符下标（含换行，反正是近似）
    posAtCoords: (coords) => Math.max(0, Math.min(doc.length, Math.floor(coords.x / 7))),
  };
  // agent 就是从 .cm-content 的 cmTile 上拿 EditorView（PTA 的实际位置）
  content.cmTile = { view };

  render();

  return {
    window,
    document,
    content,
    bottomBar,
    text: () => doc,
    // 直接摆光标（真机上是用户点/敲字）
    setHead: (value) => { head = Math.max(0, Math.min(doc.length, value)); },
    // 整段换掉正文（等价于用户全选后粘贴），head 一起摆好
    setDoc: (value, at) => {
      doc = value;
      head = Math.max(0, Math.min(value.length, at ?? value.length));
      render();
    },
    head: () => head,
    dispatch: (event) => content.dispatchEvent(event),
    close: () => window.close(),
  };
}

/** 跟 injectScript 一样：先挂 __args，再用页面 realm 的 AsyncFunction 跑源码 */
async function runAgent(page, args) {
  const AsyncFunction = Object.getPrototypeOf(page.window.eval('(async function () {})')).constructor;
  const body = 'globalThis.__ptaAborted = false; const __args = ' + JSON.stringify(args) + '; ' + EDITOR_AGENT_SOURCE;
  return await new AsyncFunction(body)();
}

/** 收 agent → 隔离世界的消息 */
function listen(window) {
  const inbox = [];
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && data.__ptaEditorAssist === TOKEN) inbox.push(data);
  });
  return inbox;
}

/** 发 隔离世界 → agent 的消息（agent 会检查 event.source === window） */
function send(window, payload) {
  window.dispatchEvent(new window.MessageEvent('message', {
    data: { __ptaEditorAssist: TOKEN, ...payload },
    source: window,
  }));
}

// jsdom 会把 #b06d00 这类颜色序列化成 rgb(...)，用同一个元素换算，避免手写期望值
function cssColor(window, value) {
  const probe = window.document.createElement('div');
  probe.style.color = value;
  return probe.style.color;
}

async function runScenario(page) {
  const { window, document } = page;
  const inbox = listen(window);

  const first = await runAgent(page, INSTALL_ARGS);
  check(
    '第一次注入返回 installed 与 token',
    !!first && first.status === 'installed' && first.token === TOKEN,
    first,
  );

  await sleep(120);
  check('绑定编辑器后立刻发出 hello', inbox.some((message) => message.kind === 'hello'));

  // hello 之后 syncDoc(true) 用 setTimeout(350) 防抖，再留一点 postMessage 排队的时间
  await sleep(600);
  const docSyncs = inbox.filter((message) => message.kind === 'doc');
  check(
    '停手后同步一次全文',
    docSyncs.length === 1 && docSyncs[0].text === INITIAL_TEXT,
    docSyncs.map((message) => message.text),
  );

  // 装饰层现在挂在编辑器内部（弹窗天然盖住），不再在整页浮层里
  const layer = document.getElementById('pta-assist-squiggles')
    ?? document.getElementById('pta-assist-decor');

  const toolbar = document.getElementById('pta-assist-bar');
  const buttons = toolbar ? [...toolbar.querySelectorAll('button')].map((node) => node.textContent.trim()) : [];
  check('工具栏里有「整理代码」按钮', !!layer && !!toolbar && buttons.includes('整理代码'), buttons);

  const bar = toolbar;
  const badge = bar ? bar.querySelector('div') : null;
  check('工具栏上有诊断徽标', !!badge);

  // ── 彩虹括号 ──────────────────────────────────────────────────────────
  send(window, { kind: 'rainbow', text: page.text(), marks: [{ at: 1, depth: 1 }] });
  // 上色发生在 agent 的定时巡检里（每 500ms 一次），等一轮
  await sleep(650);
  const marked = page.content.querySelectorAll('.cm-line span')[1];
  const expectedColor = cssColor(window, RAINBOW_COLORS[1 % RAINBOW_COLORS.length]);
  check(
    '彩虹括号给下标 1 的括号上了对应层的颜色',
    !!marked && marked.textContent === '(' && marked.style.color === expectedColor,
    marked && { text: marked.textContent, color: marked.style.color },
  );

  // ── 整理代码：过期保护 / 正常应用 ──────────────────────────────────────
  send(window, { kind: 'format-apply', source: '不匹配的原文', text: 'X', summary: 's' });
  check('source 对不上的整理结果被丢掉（不覆盖用户刚敲的内容）', page.text() === INITIAL_TEXT, page.text());

  send(window, { kind: 'format-apply', source: INITIAL_TEXT, text: 'Y', summary: '已整理 1 行' });
  check('source 对得上时把整理结果写回编辑器', page.text() === 'Y', page.text());

  // agent 的 state.text 要等下一轮巡检才更新成 'Y'；不更新的话下一批诊断会被当成过期消息扔掉
  await sleep(650);

  // ── 诊断：波浪线 + 徽标 ───────────────────────────────────────────────
  send(window, { kind: 'diagnostics', text: 'Y', boxes: [ERROR_BOX, WARN_BOX] });
  check(
    '徽标报出 1 个错误和 1 个警告',
    badge.textContent.includes('1 个错误') && badge.textContent.includes('1 个警告'),
    badge.textContent,
  );

  await sleep(650);
  // jsdom 把 `background:#fff` 这种简写序列化成 backgroundImage: 'none'，
  // 只判「非空」会把徽标也算进来；按 url(...) 判才是真的「有图片背景」，也就是波浪线
  const isWave = (node) => node.tagName === 'DIV' && node.style.backgroundImage.startsWith('url(');
  const isDashed = (node) => node.tagName === 'DIV' && node.style.borderBottomStyle === 'dashed';
  const squiggles = layer ? [...layer.querySelectorAll('div')].filter(isWave) : [];
  const dashed = layer ? [...layer.querySelectorAll('div')].filter(isDashed) : [];
  // 错误画波浪线、警告画虚线：两条都要落在正确的位置上
  check('错误画波浪线', squiggles.length === 1, squiggles.length);
  check('警告画虚线（不再只进徽标）', dashed.length === 1, dashed.length);
  // 位置必须是有效的像素值：坐标换算时变量被遮蔽会算出 NaN，
  // 那样线会全落在 (0,0)——就是「实时代码检查没有正确渲染」
  const positioned = [...squiggles, ...dashed];
  check(
    '波浪线/虚线的坐标是有效像素（不是 NaN）',
    positioned.length > 0 && positioned.every((node) => /^\-?\d+px$/.test(node.style.left) && /^\-?\d+px$/.test(node.style.top)),
    positioned.map((node) => ({ left: node.style.left, top: node.style.top })),
  );
  check(
    '波浪线落在编辑器范围内',
    positioned.length > 0 && positioned.every((node) => Number.parseInt(node.style.left, 10) >= 0),
    positioned.map((node) => node.style.left),
  );

  send(window, { kind: 'diagnostics', text: 'Y', boxes: [], note: NOTE });
  check('没做检查时徽标换成 note 文案', badge.textContent === NOTE, badge.textContent);

  // 空 boxes 会把波浪线和命中矩形一起清掉。真机上下一批编译结果几百毫秒内就回来，
  // 这里补发一次带诊断的结果来等价模拟「等下一批结果」，再测悬停命中。
  send(window, { kind: 'diagnostics', text: 'Y', boxes: [ERROR_BOX, WARN_BOX] });
  await sleep(650);
  page.content.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 5, clientY: 5, bubbles: true }));
  // 悬停是攒到下一帧才算的（mousemove 一秒上百次，逐个算会把编辑器拖卡）
  await sleep(50);
  const tip = document.getElementById('pta-assist-tip');
  check(
    '鼠标压在波浪线上弹出报错原文与中文建议',
    !!tip
      && tip.style.display !== 'none'
      && tip.textContent.includes("expected ';'")
      && tip.textContent.includes('少分号'),
    tip && { display: tip.style.display, text: tip.textContent },
  );

  // ── 重复注入 ─────────────────────────────────────────────────────────
  const second = await runAgent(page, INSTALL_ARGS);
  check('同一个 token 再注入一次直接复用', !!second && second.status === 'already', second);
  check(
    '页面上只有一层浮层（没有叠出第二层工具栏）',
    document.querySelectorAll('#pta-assist-editor-layer').length === 1,
    document.querySelectorAll('#pta-assist-editor-layer').length,
  );
  const attachedBar = document.getElementById('pta-assist-bar');
  const toolbarSlot = document.getElementById('pta-assist-bar-slot');
  check(
    '工具栏嵌进 Test Case 父状态栏',
    !!attachedBar && !!toolbarSlot &&
      attachedBar.parentElement === toolbarSlot &&
      toolbarSlot.parentElement === page.bottomBar &&
      attachedBar.style.position === 'static',
    attachedBar && { parent: attachedBar.parentElement?.id, position: attachedBar.style.position },
  );
}

/**
 * v8 的页面增强：连字符 / 缩进线 / 代码提示。
 * 单独开一个页面跑：这些功能开着会改变输入的键盘行为，别和上一轮混在一起。
 */
async function runNewFeaturesScenario(page) {
  const { window, document } = page;
  const inbox = listen(window);

  const args = {
    token: TOKEN,
    version: 2,
    docs: {
      c: {
        printf: { signature: 'int printf(const char *fmt, ...);', summary: '按格式串输出' },
        malloc: { signature: 'void *malloc(size_t n);', summary: '申请内存' },
      },
      cpp: {
        printf: { signature: 'int printf(const char *fmt, ...);', summary: '按格式串输出' },
      },
    },
    features: {
      format: true, rainbow: true, check: true, hover: true,
      hyphenate: true, indentGuides: true, codeHints: true,
    },
    completions: {
      c: completionsFor('c'),
      cpp: completionsFor('cpp'),
      constants: constantEntries(),
    },
    fontUrl: 'chrome-extension://test/fonts/JetBrainsMono-Regular.woff2',
  };
  const installed = await runAgent(page, args);
  check('新功能场景能装上', !!installed && installed.status === 'installed', installed);
  await sleep(650);

  const beforeInput = (data, inputType = 'insertText') => new window.InputEvent('beforeinput', {
    inputType, data, bubbles: true, cancelable: true,
  });

  // ── 连字符：靠合字字体渲染，代码文本不改 ─────────────────────────────
  const ligature = () => document.getElementById('pta-assist-ligature');
  check('连字符：注入了合字字体样式', Boolean(ligature()));
  check(
    '连字符：样式里有 @font-face 与传入的字体地址',
    (ligature()?.textContent ?? '').includes('@font-face') &&
      (ligature()?.textContent ?? '').includes('chrome-extension://test/fonts/JetBrainsMono-Regular.woff2'),
    ligature()?.textContent?.slice(0, 120),
  );
  check(
    '连字符：显式打开合字（font-variant-ligatures / calt）',
    (ligature()?.textContent ?? '').includes('font-variant-ligatures:normal') &&
      (ligature()?.textContent ?? '').includes('"calt" 1'),
    ligature()?.textContent?.slice(0, 200),
  );

  // 文本必须保持 ASCII：>= 不被替换成 ⩾
  page.setDoc('a =', 3);
  page.dispatch(beforeInput('>'));
  check('连字符：输入 >= 时文本仍是 ASCII（不改写字符）', page.text() === 'a =', page.text());

  // 关掉功能就把样式摘掉，打开再挂回来
  send(window, { kind: 'configure', features: { hyphenate: false } });
  check('连字符：关掉后字体样式被移除', ligature() === null);

  send(window, { kind: 'configure', features: { hyphenate: true } });
  check('连字符：重新打开后字体样式回来了', Boolean(ligature()));

  // ── 缩进线：每层一根，颜色分层 ────────────────────────────────────────
  page.setDoc('int main() {\n    int x;\n        int y;\n}', 0);
  await sleep(650);
  const guideLayer = document.getElementById('pta-assist-indent-guides');
  const guides = guideLayer ? [...guideLayer.children] : [];
  check('缩进线：缩进的行画出了引导线', guides.length === 3, guides.length);
  const levelColors = guides.map((node) => node.style.background);
  check(
    '缩进线：第二层与第一层颜色不同',
    levelColors.length === 3 && levelColors[0] === levelColors[1] && levelColors[1] !== levelColors[2],
    levelColors,
  );
  check(
    '缩进线：一层比一层靠右',
    guides.length === 3 && Number.parseFloat(guides[0].style.left) < Number.parseFloat(guides[2].style.left),
    guides.map((node) => node.style.left),
  );

  // ── 行号栏图标：return 画回车，递归画刷新（同一行时递归优先）──────────
  page.setDoc('int fact(int n) {\n    if (n <= 1) return 1;\n    return n * fact(n - 1);\n}', 0);
  await sleep(900);
  const icons = [...(document.getElementById('pta-assist-gutter-icons')?.children ?? [])].map((n) => n.textContent);
  check('行号栏：return 行画回车、递归行画刷新', icons.length === 2 && icons[0] === '\u21B5' && icons[1] === '\u21BB', icons);

  // ── 悬停变量：作用域内同名高亮，跨函数不点亮 ─────────────────────────
  const scopeCode = 'int f(int a) {\n    return a + a;\n}\nint g(int a) {\n    return a;\n}';
  page.setDoc(scopeCode, 0);
  await sleep(800);
  // ── Alt+Enter：鼠标优先，光标在别处也修鼠标指的那个 ───────────────────
  page.setDoc('void f(void) {\n    int x = 1;\n    char *p = malloc(4);\n}', 20);
  await sleep(800);
  const mallocPos = page.text().indexOf('malloc');
  page.dispatch(new window.MouseEvent('mousemove', { clientX: (mallocPos + 2) * 7, clientY: 5, bubbles: true }));
  await sleep(200);
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
  await sleep(200);
  check(
    'Alt+Enter：修的是鼠标指的函数（不是光标所在）',
    page.text().includes('#include <stdlib.h>'),
    page.text(),
  );

  // ── 缩进线：空行沿用下一处非空行的缩进（Tab 缩进也一样）──────────────
  page.setDoc('def bill():\n\n\tx = 1', 0);
  await sleep(800);
  const blankLayer = document.getElementById('pta-assist-indent-guides');
  const blankGuides = blankLayer ? [...blankLayer.children] : [];
  check('缩进线：空行也画（沿用下面的 Tab 缩进）', blankGuides.length >= 2, blankGuides.length);

  // ── 缺头文件：悬停提示 + Alt+Enter 一键导入 ───────────────────────────
  page.setDoc('malloc(4)', 0);
  await sleep(800);
  page.dispatch(new window.MouseEvent('mousemove', { clientX: 3, clientY: 5, bubbles: true }));
  await sleep(200);
  const includeTip = document.getElementById('pta-assist-tip');
  check(
    '缺头文件：悬停提示「缺 #include」并说明 Alt+Enter',
    !!includeTip && includeTip.style.display !== 'none'
      && includeTip.textContent.includes('缺 #include <stdlib.h>')
      && includeTip.textContent.includes('Alt+Enter'),
    includeTip && includeTip.textContent,
  );
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
  await sleep(200);
  check('缺头文件：Alt+Enter 补上 include', page.text().includes('#include <stdlib.h>'), page.text());
  // 已经有了就不再提示
  page.setDoc('#include <stdlib.h>\nmalloc(4)', 0);
  await sleep(500);
  page.dispatch(new window.MouseEvent('mousemove', { clientX: 3, clientY: 5, bubbles: true }));
  await sleep(200);
  const afterTip = document.getElementById('pta-assist-tip');
  check('缺头文件：已导入后不再提示', !afterTip || afterTip.style.display === 'none', afterTip && afterTip.textContent);

  // ── 代码提示：打第一个字符就提示 ─────────────────────────────────────
  page.setDoc('w', 1);
  await sleep(700);
  const oneChar = document.getElementById('pta-assist-hint');
  const oneCharRows = oneChar ? [...oneChar.children].map((n) => n.textContent) : [];
  check('代码提示：一个字符就弹（w → while）', oneCharRows.includes('while'), oneCharRows);
  check(
    '代码提示：下拉按分组显示',
    oneCharRows.some((t) => t === '代码块' || t === '关键字' || t === '变量' || t === '标准库'),
    oneCharRows,
  );

  // ── 代码提示：常量候选，选中后自动补 include ─────────────────────────
  page.setDoc('INT_M', 5);
  await sleep(700);
  const constHint = document.getElementById('pta-assist-hint');
  const constRows = constHint ? [...constHint.children].map((n) => n.textContent) : [];
  check('代码提示：常量候选（INT_MAX）', constRows.includes('INT_MAX'), constRows);
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(250);
  check('代码提示：选中常量后自动补 limits.h', page.text().includes('#include <limits.h>'), page.text());
  check('代码提示：常量本身也补上了', page.text().includes('INT_MAX'), page.text());

  // ── 代码提示：别的函数里的变量不出现 ────────────────────────────────
  const scopeText = 'int f(int alpha) {\n    return alpha;\n}\nint g(void) {\n    int beta = 1;\n    be';
  page.setDoc(scopeText, scopeText.length);
  await sleep(700);
  const scopeHint = document.getElementById('pta-assist-hint');
  const scopeRows = scopeHint ? [...scopeHint.children].map((n) => n.textContent) : [];
  check('代码提示：当前作用域的变量能补', scopeRows.includes('beta'), scopeRows);
  check('代码提示：别的函数的变量不补', !scopeRows.includes('alpha'), scopeRows);

  // ── 代码提示：关键字带结构（while () { }，光标落在括号里）────────────
  page.setDoc('whi', 3);
  await sleep(700);
  const kwHint = document.getElementById('pta-assist-hint');
  const kwRows = kwHint ? [...kwHint.children].map((n) => n.textContent) : [];
  check('代码提示：输入 whi 提示 while', kwRows.includes('while'), kwRows);
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(200);
  check(
    '代码提示：while 自动展开成结构',
    page.text() === 'while () {\n    \n}',
    JSON.stringify(page.text()),
  );
  check(
    '代码提示：光标落在 while 的条件括号里',
    page.content.cmTile.view.state.selection.main.head === 7,
    page.content.cmTile.view.state.selection.main.head,
  );

  // 模板要按当前缩进铺开：在缩进 8 格的地方插 for，收尾花括号也得缩进 8 格
  // 整词打全的代码块仍然提示（while → while () { }）
  page.setDoc('while', 5);
  await sleep(700);
  const wholeWord = document.getElementById('pta-assist-hint');
  const wholeRows = wholeWord ? [...wholeWord.children].map((n) => n.textContent) : [];
  check('代码提示：整词打全的代码块仍提示（while）', wholeRows.includes('while'), wholeRows);
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(250);
  check(
    '代码提示：整词打全的代码块展开成结构',
    page.text() === 'while () {\n    \n}',
    JSON.stringify(page.text()),
  );

  const indentText = 'int main(void) {\n        fo';
  page.setDoc(indentText, indentText.length);
  await sleep(700);
  page.dispatch(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(250);
  check(
    '代码提示：模板按当前缩进铺开（收尾花括号对齐）',
    page.text() === 'int main(void) {\n        for (;;) {\n            \n        }',
    JSON.stringify(page.text()),
  );

  // ── 代码提示：当前文件里的变量名也能补全 ─────────────────────────────
  page.setDoc('int counter = 0;\n    cou', 24);
  await sleep(700);
  const varHint = document.getElementById('pta-assist-hint');
  const varRows = varHint ? [...varHint.children].map((n) => n.textContent) : [];
  check('代码提示：补全当前文件里的变量名', varRows.includes('counter'), varRows);

  // ── 代码提示：开着时把 PTA 自带的补全藏掉 ─────────────────────────────
  const ptaStyle = document.getElementById('pta-assist-pta-completion');
  check(
    '代码提示：开着时停用 PTA 自带补全',
    !!ptaStyle && ptaStyle.textContent.includes('.cm-tooltip-autocomplete'),
    ptaStyle && ptaStyle.textContent,
  );

  // ── 代码提示：前缀补全 + 自动 include + 记一次使用 ─────────────────────
  page.setDoc('prin', 4);
  await sleep(650);
  const hint = document.getElementById('pta-assist-hint');
  const rows = hint ? [...hint.children].map((node) => node.textContent) : [];
  check('代码提示：输入 prin 弹出 printf 候选', hint && hint.style.display !== 'none' && rows.includes('printf'), rows);

  const key = (name) => new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
  page.dispatch(key('Enter'));
  // hint-used 是 postMessage 过去的，排队要一会儿
  await sleep(80);
  check('代码提示：回车补全成 printf', page.text().startsWith('#include <stdio.h>\nprintf'), page.text());
  check('代码提示：顺手补上了 stdio.h 头文件', page.text().includes('#include <stdio.h>'));
  check('代码提示：补全后下拉收起', hint.style.display === 'none', hint.style.display);
  check(
    '代码提示：把这次使用报给隔离世界（用来排序）',
    inbox.some((message) => message.kind === 'hint-used' && message.label === 'printf'),
    inbox.filter((message) => message.kind === 'hint-used'),
  );

  // 已经 include 过就不再重复加
  page.setDoc('#include <stdio.h>\nprin', 23);
  await sleep(650);
  page.dispatch(key('Tab'));
  check('代码提示：已有同一个 include 时不重复加', page.text() === '#include <stdio.h>\nprintf', page.text());

  // ── configure：运行中关掉补全，立刻不再弹 ─────────────────────────────
  send(window, { kind: 'configure', features: { codeHints: false } });
  page.setDoc('sca', 3);
  await sleep(650);
  check('configure 关掉补全后不再弹下拉', hint.style.display === 'none', hint.style.display);

  // 缩进线也能运行中关掉
  send(window, { kind: 'configure', features: { indentGuides: false } });
  page.setDoc('if (1) {\n    int x;\n}', 0);
  await sleep(650);
  check('configure 关掉缩进线后引导线清空', guideLayer.children.length === 0, guideLayer.children.length);

  // 再打开又能画出来
  send(window, { kind: 'configure', features: { indentGuides: true, codeHints: true } });
  page.setDoc('if (1) {\n    int x;\n}', 0);
  await sleep(650);
  check('configure 重新打开缩进线后又能画出来', guideLayer.children.length === 1, guideLayer.children.length);
}

const page = createEditorPage(INITIAL_TEXT);
const featurePage = createEditorPage('a =');
try {
  await runScenario(page);
  await runNewFeaturesScenario(featurePage);
} finally {
  // agent 起了 500ms 的巡检 interval，不关窗 node 不会退出
  page.close();
  featurePage.close();
}
console.log('\n页面 agent 的行为通过。');
