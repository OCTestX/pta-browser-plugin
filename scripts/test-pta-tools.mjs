// PTA 三件套与多种输入方法的页面脚本测试：在 jsdom 里搭一个假 CodeMirror 6，
// 实例挂在 #pta-answer-editor 的 cmTile.view 上（和 PTA 一致），脚本用页面 realm 的 AsyncFunction 跑。
// 用法：node scripts/test-pta-tools.mjs
import { JSDOM, VirtualConsole } from 'jsdom';
import { assertDistFresh } from './dist-fresh.mjs';
import {
  CHECK_READY_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  INPUT_METHOD_SCRIPT,
  LANGUAGE_SCRIPT,
  LIST_PROBLEMS_SCRIPT,
  NEXT_PROBLEM_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  READ_PTA_COMPILE_RESULT_SCRIPT,
  SIMULATE_PTA_RUN_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
} from '../src/background/pta-scripts.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

/**
 * jsdom 没有 innerText（块级元素之间不会产生换行），而脚本里的按行解析依赖它。
 * 这里给个近似实现，让测试尽量贴近真实浏览器行为。
 */
function installInnerText(window) {
  const BLOCKS = new Set([
    'DIV', 'P', 'LI', 'TR', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'PRE',
    'BLOCKQUOTE', 'UL', 'OL', 'TABLE', 'FORM', 'MAIN', 'BODY', 'HEADER', 'FOOTER', 'NAV', 'BR',
  ]);
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      const walk = (node) => {
        if (node.nodeType === 3) return node.textContent ?? '';
        if (node.nodeType !== 1) return '';
        if (node.style && node.style.display === 'none') return '';
        if (node.tagName === 'BR') return '\n';
        let out = '';
        for (const child of node.childNodes) out += walk(child);
        return BLOCKS.has(node.tagName) ? '\n' + out + '\n' : out;
      };
      return walk(this)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .replace(/^\n+|\n+$/g, '');
    },
  });
  return window;
}

/** 跑一段脚本：__args 注入 + 页面 realm 的 AsyncFunction（跟插件注入同构） */
async function runScript(window, source, args) {
  const withArgs = args === undefined ? source : `const __args = ${JSON.stringify(args)};\n${source}`;
  const AsyncFunction = Object.getPrototypeOf(window.eval('(async function () {})')).constructor;
  return await new AsyncFunction(withArgs)();
}

function createPage({ withView = true, body = '', sampleBoxes = 0 } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-1 星期几</title></head><body>${body}</body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/problems/1150901824503297/description',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = installInnerText(dom.window);

  if (!window.document.execCommand) window.document.execCommand = () => false;

  // 题面的「输入样例 / 输出样例」也是 CodeMirror，但是只读（contenteditable=false + aria-readonly=true）
  for (let index = 0; index < sampleBoxes; index += 1) {
    const box = window.document.createElement('div');
    box.className = 'cm-editor';
    const content = window.document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'false');
    content.setAttribute('aria-readonly', 'true');
    box.appendChild(content);
    box.cmTile = {
      view: {
        state: {
          readOnly: true,
          doc: { toString: () => (index === 0 ? '3 4' : '7'), length: 3, lines: 1 },
        },
        dispatch: () => {},
      },
    };
    window.document.body.appendChild(box);
  }

  if (withView) {
    const editor = window.document.createElement('div');
    editor.id = 'pta-answer-editor';
    const content = window.document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'true');
    editor.appendChild(content);
    window.document.body.appendChild(editor);

    let doc = '#include <stdio.h>\nint main(void) {\n  return 0;\n}';
    window.__focusCalls = 0;
    editor.cmTile = {
      view: {
        state: {
          get doc() {
            return { toString: () => doc, length: doc.length, lines: doc.split('\n').length };
          },
          readOnly: false,
          replaceSelection: (replacement) => ({ changes: { from: 0, to: doc.length, insert: replacement } }),
        },
        focus: () => {
          window.__focusCalls = (window.__focusCalls ?? 0) + 1;
        },
        dispatch: (transaction) => {
          if (transaction.userEvent) window.__lastUserEvent = transaction.userEvent;
          if (transaction.changes && typeof transaction.changes.from === 'number') {
            const from = transaction.changes.from;
            // 真实 CM6 里 {from, insert} 不写 to 就等于「在 from 处插入」，to 默认取 from
            const to = typeof transaction.changes.to === 'number' ? transaction.changes.to : from;
            doc = doc.slice(0, from) + (transaction.changes.insert ?? '') + doc.slice(to);
          }
          if (transaction.selection) window.__lastSelection = transaction.selection;
        },
        on: () => {},
      },
    };
    window.__doc = () => doc;
  }

  return window;
}

/* ---------- 清单完整性（沿用 smoke 的思路） ---------- */

const manifest = JSON.parse((await import('node:fs')).readFileSync('dist/chrome/manifest.json', 'utf8'));
console.log('✓ manifest 可解析（manifest_version ' + manifest.manifest_version + '）');

/* ---------- 题面 ---------- */

const problemPage = createPage({
  body: `
    <div class="problem-statement">太短</div>
    <div class="problem-content">给定一个年份，先判断这一年是不是闰年，再算出这一天是星期几，按题目要求输出对应的中文星期名称，注意闰年二月有二十九天。</div>
    <div class="pt12-problem-content">优先级更低的容器</div>`,
});
const problem = await runScript(problemPage, READ_PROBLEM_SCRIPT, {});
check('题面按容器优先级取到最合适的那一个', problem.includes('是不是闰年'));
check('题面结果里带上来源选择器', problem.includes('.problem-content'));
check('题面结果里带上标题与题目 ID', problem.includes('7-1 星期几') && problem.includes('1150901824503297'));
check('没有题目容器时退到整页正文且不报错', (await runScript(createPage({ withView: false, body: '<p>整页正文兜底</p>' }), READ_PROBLEM_SCRIPT, {})).includes('整页正文兜底'));
const longProblem = await runScript(problemPage, READ_PROBLEM_SCRIPT, { maxChars: 5 });
check('题面过长会截断并说明', longProblem.includes('已截断'));

// 复刻 PTA 考试页：题面不在任何已知类名里，外围全是导航/侧栏文案
const examPage = new JSDOM(
  `<!doctype html><html><head><title>7-8 计算星期值 - 极码工作室</title></head><body>
     <div class="side-nav">题目总览 作答 / 题数 编程题 8/8 图例 1 2 3 Toggle Sidebar 上一题 下一题</div>
     <div class="page-box">
       <div class="box-a">
         <div>题目描述</div>
         <div>7-8 计算星期值 分数 15 全屏浏览 切换布局 作者 周文俊 单位 西南石油大学</div>
         <div>给定一个整数 n，请算出它是星期几，输出对应的中文名称，注意要考虑闰年的情况，二月的天数会多一天，这一年有 366 天。</div>
         <div>输入格式</div>
         <div>输入一行，包含一个整数 n。</div>
         <div>输出格式</div>
         <div>输出一行，星期几的中文名称。</div>
         <div>样例输入</div>
         <div>复制</div>
         <div>3 4</div>
         <div>样例输出</div>
         <div>复制</div>
         <div>7</div>
       </div>
     </div>
   </body></html>`,
  { url: 'https://pintia.cn/problem-sets/2107307214921076736/exam/problems/type/7?problemSetProblemId=2107310773532155904', runScripts: 'outside-only' },
).window;
installInnerText(examPage);
const examProblem = await runScript(examPage, READ_PROBLEM_SCRIPT, {});
check('类名对不上时按小标题定位到题面容器', examProblem.includes('按小标题定位的容器'));
check('题面正文读到了', examProblem.includes('请算出它是星期几'));
check('导航与侧栏文案被滤掉', !examProblem.includes('Toggle Sidebar') && !examProblem.includes('上一题') && !examProblem.includes('图例'));
check('抠出了样例输入', examProblem.includes('样例 1 输入') && examProblem.includes('3 4'));
check('抠出了样例输出', examProblem.includes('样例 1 输出：' + String.fromCharCode(96).repeat(3) + '\n7\n' + String.fromCharCode(96).repeat(3)));
check('样例里的「复制」按钮文字被滤掉', !examProblem.includes('复制'));

// samplesOnly：给写入后自动检查用的结构化样例
const sampleRaw = await runScript(examPage, READ_PROBLEM_SCRIPT, { samplesOnly: true });
const parsedSamples = typeof sampleRaw === 'string' ? JSON.parse(sampleRaw) : sampleRaw;
check('samplesOnly 返回结构化样例', Array.isArray(parsedSamples.samples) && parsedSamples.samples[0].input === '3 4' && parsedSamples.samples[0].output === '7');

/* ---------- 新版考试页（.rendered-markdown + KaTeX + 只读样例框 + 语言选择器） ---------- */

// 复刻真实页面结构（2026-10-30 实测）：题面在 .rendered-markdown 里，
// 样例是只读的 CodeMirror，公式是 KaTeX，右上角有语言选择器
function createExamUiPage() {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-8 淘淘不喜欢3、6、9 - python基础</title></head><body>
       <div class="select__control">Python (python3)</div>
       <div class="rendered-markdown dark:rendered-markdown-invert">
         <p>淘淘不喜欢数字
           <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>n</mi></mrow>
             <annotation encoding="application/x-tex">n \\le 100</annotation></semantics></math></span></span>
           ，求和如下：</p>
         <p>输入格式:</p>
         <p>输入一个正整数n。</p>
         <p>输出格式:</p>
         <p>输出淘淘数的数之和。</p>
         <p>输入样例1:</p>
         <p>在这里给出一组输入。例如：</p>
         <div class="codeEditor readOnly"><div class="cm-editor"><div class="cm-scroller">
           <div class="cm-gutters"><div class="cm-gutterElement">1</div></div>
           <div class="cm-content" contenteditable="false" aria-readonly="true">
             <div class="cm-line">12</div>
           </div>
         </div></div></div>
         <p>输出样例1:</p>
         <p>在这里给出相应的输出。例如：</p>
         <div class="codeEditor readOnly"><div class="cm-editor"><div class="cm-scroller">
           <div class="cm-gutters"><div class="cm-gutterElement">1</div></div>
           <div class="cm-content" contenteditable="false" aria-readonly="true">
             <div class="cm-line">60</div>
           </div>
         </div></div></div>
       </div>
     </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/2112364537537314816/exam/problems/type/7?problemSetProblemId=2112364537575063568',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  return installInnerText(dom.window);
}

const examUi = createExamUiPage();
const examUiProblem = await runScript(examUi, READ_PROBLEM_SCRIPT, {});
check('新版考试页能找到 .rendered-markdown 题面', examUiProblem.includes('淘淘不喜欢数字'));
check('KaTeX 公式被还原成 LaTeX 源码', examUiProblem.includes('$n \\le 100$'));
check('样例从只读编辑器里读到了（不带行号槽）', examUiProblem.includes('样例 1 输入') && examUiProblem.includes('\n12\n'));
check('样例输出也从只读编辑器里读到', examUiProblem.includes('样例 1 输出') && examUiProblem.includes('\n60\n'));
check('题面里带上了语言', examUiProblem.includes('Python (python3)') || examUiProblem.includes('题目语言：python'));

const examUiSamples = await runScript(examUi, READ_PROBLEM_SCRIPT, { samplesOnly: true });
const examUiParsed = typeof examUiSamples === 'string' ? JSON.parse(examUiSamples) : examUiSamples;
check(
  'samplesOnly 从只读编辑器里取到样例',
  examUiParsed.samples[0].input === '12' && examUiParsed.samples[0].output === '60',
);
check('samplesOnly 带上了页面上的语言（自动检查要按它选编译器）', examUiParsed.language === 'python3', examUiParsed);

// 题面里的公式图片：alt 能读到就给出来，读不到也要说明这里有张图
const imagePage = createExamUiPage();
imagePage.document.querySelector('.rendered-markdown').insertAdjacentHTML(
  'afterbegin',
  '<p>如下图所示：<img src="https://static.pintia.cn/formula/a1b2.png" alt="等差数列求和公式" width="120" height="40"></p>',
);
const imageProblem = await runScript(imagePage, READ_PROBLEM_SCRIPT, {});
check('题面里的图片会给出 alt 与链接', imageProblem.includes('等差数列求和公式') && imageProblem.includes('static.pintia.cn/formula/a1b2.png'));

const noAltPage = createExamUiPage();
noAltPage.document.querySelector('.rendered-markdown').insertAdjacentHTML(
  'afterbegin',
  '<p><img src="data:image/png;base64,iVBORw0KGgo=" width="30" height="20"></p>',
);
const noAltProblem = await runScript(noAltPage, READ_PROBLEM_SCRIPT, {});
check('图片没有 alt 时也说明这里有张图', noAltProblem.includes('[图片') && noAltProblem.includes('data:image/png'));

/* ---------- 题面里的样例框：行号槽 / 工具条不能混进正文 ---------- */

// 复刻真实页面（2026-11 实测）：样例框是 <div data-code data-lang="in">，
// 里面才是只读的 CodeMirror；行号槽（9 / 1 / 2 / ▸）和工具条是它的兄弟节点。
// 只跳过 .cm-content 一个节点的话，这些噪音会被当成题面正文抠出来。
function createSampleBoxPage() {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-12 杨辉三角形</title></head><body>
       <div class="rendered-markdown">
         <h4>输入样例1</h4>
         <div data-code="" data-lang="in">
           <div class="codeEditor_xxx readOnly_yyy">
             <div class="cm-editor cm-focused">
               <div class="cm-scroller">
                 <div class="cm-gutters">
                   <div class="cm-gutterElement">9</div>
                   <div class="cm-gutterElement">1</div>
                   <div class="cm-gutterElement">2</div>
                   <div class="cm-gutterElement">▸</div>
                 </div>
                 <div class="cm-content" contenteditable="false" aria-readonly="true">
                   <div class="cm-line">5</div>
                 </div>
               </div>
             </div>
             <div class="cm-toolbar">复制内容 格式 全屏 收起</div>
           </div>
         </div>
         <p>请输出杨辉三角形的前若干行，每行的数字之间用一个空格隔开，第一行只有一个 1。</p>
       </div>
     </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=2092326321552957459',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  return installInnerText(dom.window);
}

// 题面正文在输出里的位置：'题面（来源：…）' 之后那一段
const statementOf = (output) => output.slice(output.indexOf('题面（来源：'));
const linesOf = (text) => text.split('\n').map((line) => line.trim());

const sampleBoxPage = createSampleBoxPage();
const sampleBoxProblem = await runScript(sampleBoxPage, READ_PROBLEM_SCRIPT, {});
const sampleBoxStatement = statementOf(sampleBoxProblem);
const sampleBoxLines = linesOf(sampleBoxStatement);
check('样例框的行号槽不会混进题面', !sampleBoxStatement.includes('▸') && !sampleBoxLines.includes('9') && !sampleBoxLines.includes('2'));
check('样例框的工具条不会混进题面', !sampleBoxStatement.includes('复制内容') && !sampleBoxStatement.includes('全屏') && !sampleBoxStatement.includes('收起'));
check('样例的真实内容进了题面', sampleBoxStatement.includes('[输入样例]') && sampleBoxLines.includes('5'));
check('样例框的噪音整份输出里都没有', !sampleBoxProblem.includes('▸') && !sampleBoxProblem.includes('复制内容'));

// 输入输出两个框都在时，样例小节按 data-lang 配对（不能靠谁先出现去猜）
const pairedPage = createSampleBoxPage();
pairedPage.document.querySelector('.rendered-markdown').insertAdjacentHTML(
  'beforeend',
  `<h4>输出样例1</h4>
   <div data-code="" data-lang="out">
     <div class="codeEditor_xxx readOnly_yyy">
       <div class="cm-editor">
         <div class="cm-scroller">
           <div class="cm-gutters"><div class="cm-gutterElement">1</div></div>
           <div class="cm-content" contenteditable="false" aria-readonly="true">
             <div class="cm-line">1</div>
             <div class="cm-line">1 1</div>
           </div>
         </div>
       </div>
     </div>
   </div>`,
);
const pairedProblem = await runScript(pairedPage, READ_PROBLEM_SCRIPT, {});
const fence3 = String.fromCharCode(96).repeat(3);
check('样例小节按 data-lang 配出输入与输出', pairedProblem.includes('样例 1 输入：' + fence3 + '\n5\n' + fence3) && pairedProblem.includes('样例 1 输出：' + fence3 + '\n1\n1 1\n' + fence3), pairedProblem);
check('输出样例框也按 [输出样例] 进了题面', statementOf(pairedProblem).includes('[输出样例]'));

// 题面里的「函数接口定义 / 裁判测试程序样例」也是 data-code，只是没有 data-lang；
// 它们不能被当成样例外给模型（真机 6-1 阶乘计算升级版复现过）
pairedPage.document.querySelector('.rendered-markdown').insertAdjacentHTML(
  'beforeend',
  `<h4>函数接口定义</h4>
   <div data-code="">
     <div class="cm-content" contenteditable="false" aria-readonly="true">
       <div class="cm-line">void Print_Factorial(const int N);</div>
     </div>
   </div>`,
);
const filteredProblem = await runScript(pairedPage, READ_PROBLEM_SCRIPT, {});
const samplesSection = filteredProblem.slice(
  filteredProblem.indexOf('样例（共'),
  filteredProblem.indexOf('题面（来源'),
);
check(
  '没有 data-lang 的代码块不会混进样例',
  samplesSection.includes('5') && !samplesSection.includes('Print_Factorial'),
  samplesSection,
);

/* ---------- 切到下一题（/fuck 赶题模式） ---------- */

// 复刻 PTA 考试页的侧栏：顶部是题型分组（带「已答/总数」），下面是当前题型的题目网格。
// 已提交过的题在网格里带 PROBLEM_SUBMITTED 类名（再提交一次 PTA 会拒绝）。
function createProblemListPage(ids, options = {}) {
  // jsdom 不会真的路由跳转，点链接会报「Not implemented」，这里把它吞掉
  const quiet = new VirtualConsole();
  quiet.on('jsdomError', () => {});
  const submitted = new Set(options.submitted ?? []);
  const accepted = new Set(options.accepted ?? []);
  const noAnswer = new Set(options.noAnswer ?? []);
  const links = ids
    .map((id, index) => {
      let mark = '';
      if (submitted.has(id)) mark = '<div class="problemStatusRect_xx PROBLEM_SUBMITTED_xx"></div>';
      else if (accepted.has(id)) mark = '<div class="problemStatusRect_xx PROBLEM_ACCEPTED_xx"></div>';
      else if (noAnswer.has(id)) mark = '<div class="problemStatusRect_xx PROBLEM_NO_ANSWER_xx"></div>';
      return `<a class="inline-flex justify-center items-center relative h" href="/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=${id}"><span>${index + 1}</span>${mark}</a>`;
    })
    .join('');
  const groups = (options.groups ?? [])
    .map((group) => `<a class="py-3 px-4 flex justify-between" href="/problem-sets/2092326321452294144/exam/problems/type/${group.type}">${group.name} ${group.answered}/${group.total}</a>`)
    .join('');
  const dom = new JSDOM(
    `<!doctype html><html><head><title>7-12 杨辉三角形</title></head><body>
       <nav class="side-nav">${groups}</nav>
       <nav class="side-nav">${links}</nav>
     </body></html>`,
    {
      url: options.url ?? `https://pintia.cn/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=${ids[0]}`,
      runScripts: 'outside-only',
      pretendToBeVisual: true,
      virtualConsole: quiet,
    },
  );
  return dom.window;
}

const lastPage = createProblemListPage(['2092326321552957459']);
const lastResult = await runScript(lastPage, NEXT_PROBLEM_SCRIPT, {});
check('已经是最后一题时如实说明', lastResult.ok === false && String(lastResult.reason).includes('已经是最后一题了'), lastResult);
check('最后一题时也报出总数与已做数', lastResult.total === 1 && lastResult.done === 1, lastResult);

// jsdom 不会真的跳转：不能抛异常，要返回一句中文说明
const stuckPage = createProblemListPage(['2092326321552957459', '2092326321552957460']);
const stuckResult = await runScript(stuckPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 400, pollMs: 20 });
check('点完没换题时不会抛异常，而是返回失败说明', Boolean(stuckResult) && stuckResult.ok === false, stuckResult);
check('失败说明是中文', /[一-龥]/.test(String(stuckResult.reason || '')), stuckResult);

// 真跳转：用 pushState 模拟前端路由（地址和标题都换掉）
const jumpPage = createProblemListPage(['2092326321552957459', '2092326321552957460', '2092326321552957461']);
jumpPage.document.querySelectorAll('a')[1].addEventListener('click', (event) => {
  event.preventDefault();
  jumpPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=2092326321552957460');
  jumpPage.document.title = '7-13 另一道题';
});
const jumpResult = await runScript(jumpPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 3000, pollMs: 20 });
check('切到下一题后报出新题的位置与剩余题数', jumpResult.ok === true && jumpResult.index === 1 && jumpResult.total === 3 && jumpResult.remaining === 2, jumpResult);
check('切到下一题后报出新题的标题与地址', jumpResult.title === '7-13 另一道题' && String(jumpResult.url).includes('problemSetProblemId=2092326321552957460'), jumpResult);

// 做过的题要跳过：PTA 不允许重复提交
const submittedPage = createProblemListPage(
  ['2092326321552957459', '2092326321552957460', '2092326321552957461'],
  { submitted: ['2092326321552957460'] },
);
// 脚本应该跳过第 2 题（已提交），直接点第 3 题
submittedPage.document.querySelectorAll('a')[2].addEventListener('click', (event) => {
  event.preventDefault();
  submittedPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=2092326321552957461');
});
const submittedResult = await runScript(submittedPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 3000, pollMs: 20 });
check(
  '已经提交过的题会被跳过',
  submittedResult.ok === true && String(submittedResult.url).includes('problemSetProblemId=2092326321552957461'),
  submittedResult,
);

// 真实考试页画的是 PROBLEM_ACCEPTED / PROBLEM_NO_ANSWER，不是 PROBLEM_SUBMITTED；
// 认不出 ACCEPTED 就会把已经 AC 的题再点一遍，提交时被 PTA 拒绝
const acceptedPage = createProblemListPage(
  ['2092326321552957459', '2092326321552957460', '2092326321552957461'],
  { accepted: ['2092326321552957460'], noAnswer: ['2092326321552957461'] },
);
acceptedPage.document.querySelectorAll('a')[2].addEventListener('click', (event) => {
  event.preventDefault();
  acceptedPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=2092326321552957461');
});
const acceptedResult = await runScript(acceptedPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 3000, pollMs: 20 });
check(
  '真实页面的 PROBLEM_ACCEPTED 标记也会被跳过，只点 NO_ANSWER 的题',
  acceptedResult.ok === true && String(acceptedResult.url).includes('problemSetProblemId=2092326321552957461'),
  acceptedResult,
);

// 题目列表总览：同时给出题型分组与网格里的已提交状态
const listOut = await runScript(submittedPage, LIST_PROBLEMS_SCRIPT, {});
check('list_problems 列出当前题型的题目网格', listOut.includes('题目网格') && listOut.includes('已提交'));
check('list_problems 标出哪道是当前题', listOut.includes('← 当前'));

// skipCurrent=true：这道题不再回来
const skipPage = createProblemListPage(['2092326321552957459', '2092326321552957460']);
skipPage.document.querySelectorAll('a')[1].addEventListener('click', (event) => {
  event.preventDefault();
  skipPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/7?problemSetProblemId=2092326321552957460');
});
const skipResult = await runScript(skipPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 3000, pollMs: 20, skipCurrent: true });
check('skipCurrent 传 true 时这道题被记下', skipResult.ok === true, skipResult);
check('被跳过的题记在页面上', skipPage.__ptaSkippedProblems?.['2092326321552957459'] === true, skipPage.__ptaSkippedProblems);

// 当前题型做完了 → 切到下一个题型分组（点分组链接会先跳到该题型的列表页，再点第一道题）
const typeSwitchPage = createProblemListPage(
  ['2092326321552957459'],
  {
    submitted: ['2092326321552957459'],
    groups: [
      { type: '2', name: 'Multiple Choice', answered: 11, total: 11 },
      { type: '6', name: 'Code Completion', answered: 3, total: 12 },
    ],
  },
);
const groupLink = typeSwitchPage.document.querySelector('a[href*="/problems/type/6"]');
groupLink.addEventListener('click', (event) => {
  event.preventDefault();
  typeSwitchPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/6');
  // 真实页面上侧栏不是同一帧换好的：延后 120ms 再换网格，
  // 插件必须等网格真的出现新题型的链接再点，不能点到旧题型的链接上
  setTimeout(() => {
    typeSwitchPage.document.body.insertAdjacentHTML(
      'beforeend',
      '<a id="newTypeQuestion" href="/problem-sets/2092326321452294144/exam/problems/type/6?problemSetProblemId=2115063246452375554">6-1</a>',
    );
    // 新题型里的第一道题：点了之后地址才真的换掉
    typeSwitchPage.document.getElementById('newTypeQuestion').addEventListener('click', (event) => {
      event.preventDefault();
      typeSwitchPage.history.pushState({}, '', '/problem-sets/2092326321452294144/exam/problems/type/6?problemSetProblemId=2115063246452375554');
      typeSwitchPage.document.title = '6-1 代码填空';
    });
  }, 120);
});
const typeSwitchResult = await runScript(typeSwitchPage, NEXT_PROBLEM_SCRIPT, { timeoutMs: 3000, pollMs: 20 });
check(
  '当前题型做完了会切到下一个题型',
  typeSwitchResult.ok === true && String(typeSwitchResult.url).includes('type/6'),
  typeSwitchResult,
);
check('切题型时会说明是切过了', typeSwitchResult.switchedType === true, typeSwitchResult);

// 列表里找不到当前题时要如实说明，不能瞎切
const orphanPage = createProblemListPage(['2092326321552957460']);
const orphanResult = await runScript(orphanPage, NEXT_PROBLEM_SCRIPT, {});
check('列表里没有当前题时不乱切', orphanResult.ok === false && /[一-龥]/.test(String(orphanResult.reason || '')), orphanResult);

// 页面上根本没有题目列表
const noListPage = new JSDOM(
  '<!doctype html><html><head><title>空页面</title></head><body><div>没有题目列表</div></body></html>',
  { url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=111', runScripts: 'outside-only' },
).window;
installInnerText(noListPage);
const noListResult = await runScript(noListPage, NEXT_PROBLEM_SCRIPT, {});
check('没有题目列表时如实说明', noListResult.ok === false && /[一-龥]/.test(String(noListResult.reason || '')), noListResult);

/* ---------- 读代码 ---------- */

const editorPage = createPage();
const read = await runScript(editorPage, READ_EDITOR_SCRIPT, {});
check('通过编辑器实例读到完整文档', read.includes('cmTile.view') && read.includes('int main(void)'));
check('读代码结果里带上行数', read.includes('4 行'));

const noViewPage = createPage({ withView: false });
noViewPage.document.body.innerHTML = `<div class="cm-content" contenteditable="true"><div class="cm-line">int a;</div><div class="cm-line">int b;</div></div>`;
const domRead = await runScript(noViewPage, READ_EDITOR_SCRIPT, {});
check('拿不到实例时退回 DOM 读，并说明只读到渲染出来的行', domRead.includes('int a;') && domRead.includes('没拿到编辑器实例'));

check('页面上没有作答区时如实告知', (await runScript(createPage({ withView: false }), READ_EDITOR_SCRIPT, {})).includes('没找到作答区'));

// 多文件题：两个可写编辑器，按序号读 / 写
const multiPage = createPage();
const secondEditor = multiPage.document.createElement('div');
secondEditor.id = 'pta-answer-editor-2';
const secondContent = multiPage.document.createElement('div');
secondContent.className = 'cm-content';
secondContent.setAttribute('contenteditable', 'true');
secondEditor.appendChild(secondContent);
multiPage.document.body.appendChild(secondEditor);
let secondDoc = 'int helper(void) { return 1; }';
secondEditor.cmTile = {
  view: {
    state: {
      get doc() {
        return {
          toString: () => secondDoc,
          length: secondDoc.length,
          lines: secondDoc.split('\n').length,
        };
      },
      readOnly: false,
      replaceSelection: (replacement) => ({ changes: { from: 0, to: secondDoc.length, insert: replacement } }),
    },
    focus: () => {},
    dispatch: (transaction) => {
      if (transaction.changes && typeof transaction.changes.from === 'number') {
        const from = transaction.changes.from;
        const to = typeof transaction.changes.to === 'number' ? transaction.changes.to : from;
        secondDoc = secondDoc.slice(0, from) + (transaction.changes.insert ?? '') + secondDoc.slice(to);
      }
    },
    on: () => {},
  },
};
const allEditors = await runScript(multiPage, READ_EDITOR_SCRIPT, { all: true });
check(
  'read_editor_code all=true 列出两个可写编辑器与序号',
  allEditors.includes('编辑器 0') && allEditors.includes('编辑器 1') && allEditors.includes('int helper'),
  allEditors,
);
const writeSecond = await runScript(multiPage, INPUT_METHOD_SCRIPT, {
  method: 'dispatch',
  text: 'int second(void) { return 2; }',
  json: true,
  editorIndex: 1,
});
check(
  'editorIndex=1 只改第二个编辑器',
  writeSecond.ok === true && secondDoc.includes('return 2') && multiPage.__doc().includes('int main'),
  writeSecond,
);
const readSecond = await runScript(multiPage, READ_EDITOR_SCRIPT, { editorIndex: 1 });
check('按序号读回第二个编辑器', readSecond.includes('return 2') && !readSecond.includes('int main'));

// 代码填空题：题面里直接带上作答区模板，模型不用再猜「要补哪段」
const completionPage = createPage();
completionPage.history.replaceState({}, '', '/problem-sets/1/exam/problems/type/6?problemSetProblemId=111');
const completionOut = await runScript(completionPage, READ_PROBLEM_SCRIPT, { maxChars: 500 });
check(
  '代码填空题把作答区模板带进题面',
  completionOut.includes('作答区模板') && completionOut.includes('#include <stdio.h>'),
  completionOut,
);

// 新版多文件题：页面是上传 zip，没有可写编辑器，read_problem 要明确说明
const zipPage = new JSDOM(
  '<!doctype html><html><head><title>实验13-1 文件排序</title></head><body>'
  + '<div class="rendered-markdown"><p>请上传 zip 包，包含 src/ 下的若干文件。</p></div>'
  + '<div class="cm-content" contenteditable="false" aria-readonly="true"><div class="cm-line">in.txt</div></div>'
  + '<div>Problem Folder<br>src/<br>(Submit Folder)<br>a.py<br>main.sh<br>(Entry File)<br>in.txt<br>Please upload a zip file</div>'
  + '<button>Upload Answer Zip</button></body></html>',
  { url: 'https://pintia.cn/problem-sets/1/exam/problems/type/9?problemSetProblemId=222', runScripts: 'outside-only' },
).window;
installInnerText(zipPage);
const zipOut = await runScript(zipPage, READ_PROBLEM_SCRIPT, {});
check(
  '上传 zip 的多文件题会明确说明没有编辑器',
  zipOut.includes('上传 zip') && zipOut.includes('没有可写代码编辑器') && !zipOut.includes('作答区模板'),
  zipOut,
);
check(
  '上传 zip 题会列出 Problem Folder 里的文件清单',
  zipOut.includes('文件清单') && zipOut.includes('a.py') && zipOut.includes('main.sh') && zipOut.includes('in.txt'),
  zipOut,
);
check('上传 zip 题会提醒样例不是 stdin', zipOut.includes('不是标准输入'), zipOut);

/* ---------- 多种输入方法（设置页一个方法一个按钮，只保留实测可用的 4 种） ---------- */

const methodText = 'int main(void) {\n  return 0;\n}';
const runMethod = (window, method) => runScript(window, INPUT_METHOD_SCRIPT, { method, text: methodText });

// A. 编辑器状态（CM6 API）三种写法都要能写进去
for (const method of ['dispatch', 'dispatchFocus', 'replaceSelection']) {
  const page = createPage();
  const result = await runMethod(page, method);
  check(`方法 ${method}：写进去了且回读一致`, page.__doc() === methodText && result.includes('与目标一致'));
}
const focusedPage = createPage();
await runMethod(focusedPage, 'dispatchFocus');
check('方法 dispatchFocus：确实调了 view.focus()', focusedPage.__focusCalls > 0);

// B. 页面侧辅助模式（写入链路依赖它们）
const modePage = createPage();
const jsonResult = await runScript(modePage, INPUT_METHOD_SCRIPT, { method: 'dispatch', text: 'int main(){}', json: true });
check('模式 json：返回结构化的回读比对', jsonResult.ok === true && jsonResult.detail.includes('与目标一致'));

const docResult = await runScript(modePage, INPUT_METHOD_SCRIPT, { method: 'readDoc', text: '' });
check('模式 readDoc：用编辑器实例读到写入后的全文', docResult === 'int main(){}');

const clearResult = await runScript(modePage, INPUT_METHOD_SCRIPT, { method: 'clear', text: '', json: true });
check('模式 clear：通过编辑器实例清空作答区', modePage.__doc() === '' && clearResult.ok === true && clearResult.detail === '已清空');

// 回读不一致要如实报出来：dispatch 被桩成空操作，编辑器内容保持原样，读回必然与目标不符
const mismatchPage = createPage();
mismatchPage.document.querySelector('#pta-answer-editor').cmTile.view.dispatch = () => {};
const mismatch = await runScript(mismatchPage, INPUT_METHOD_SCRIPT, {
  method: 'dispatch',
  text: '#include <stdio.h>\nint main(void) {\n  long long n = 0;\n  return 0;\n}',
});
check(
  '写进去的内容与目标不符时会报出第几行不一致',
  mismatch.includes('不一致') && /第 \d+ 行/.test(mismatch) && mismatch.includes('long long n = 0;'),
);

// 作答区坐标（给 CDP 真实点击用）
const rectPage = createPage();
Object.defineProperty(rectPage.document.querySelector('.cm-content'), 'getBoundingClientRect', {
  value: () => ({ left: 10, top: 20, width: 100, height: 40 }),
  configurable: true,
});
const rectRaw = await runMethod(rectPage, 'rect');
const rect = typeof rectRaw === 'string' ? JSON.parse(rectRaw) : rectRaw;
check('rect：报告作答区中心坐标', rect.x === 60 && rect.y === 40);

// 页面提示要能读出来
const noticePage = createPage();
const toast = noticePage.document.createElement('div');
toast.className = 'el-message';
toast.textContent = '禁止粘贴';
noticePage.document.body.appendChild(toast);
check(
  '页面出现「禁止粘贴」提示时会写进结果',
  (await runMethod(noticePage, 'dispatch')).includes('页面上出现了提示'),
);

check('未知方法如实报告', (await runMethod(createPage(), '???')).includes('没有实现的方法'));
check('空文本直接报错', (await runScript(createPage(), INPUT_METHOD_SCRIPT, { method: 'dispatch', text: '' })).includes('没有给 text'));

/* ---------- 提交与判题 ---------- */

function createJudgePage() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button class="tab">提交</button>
      <button id="real-submit">提交本题作答</button>
      <div class="judge-panel">评测中</div>
    </body></html>`,
    { url: 'https://pintia.cn/problem-sets/1/problems/1', runScripts: 'outside-only' },
  );
  const window = installInnerText(dom.window);
  const clicks = [];
  window.document.querySelector('#real-submit').addEventListener('click', () => clicks.push('real'));
  window.document.querySelector('.tab').addEventListener('click', () => clicks.push('tab'));
  window.__clicks = clicks;
  window.__setJudgeText = (text) => {
    window.document.querySelector('.judge-panel').textContent = text;
  };
  return window;
}

const judgePage = createJudgePage();
await runScript(judgePage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('提交时点的是同名按钮里精确匹配的那个（不是标签页）', judgePage.__clicks.join(',') === 'real');

const stillPending = await runScript(judgePage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('只有「评测中」时不算结论', stillPending.includes('还没出结论'));

judgePage.__setJudgeText('答案正确');
const ac = await runScript(judgePage, READ_JUDGE_SCRIPT, {});
check('read_judge_result 归一化出 AC', ac.includes('AC'));

const compileError = createJudgePage();
compileError.__setJudgeText('编译错误');
check('编译错误归成 CE 而不是 WA', (await runScript(compileError, READ_JUDGE_SCRIPT, {})).includes('CE'));

const notPassed = createJudgePage();
notPassed.__setJudgeText('未通过 部分测试点答案错误');
check('「未通过」不会被当成通过', (await runScript(notPassed, READ_JUDGE_SCRIPT, {})).includes('未通过'));

// 部分正确：PTA 的部分得分弹窗里「部分正确」和「通过测试点 6/10」经常同时出现，
// 只认泛化的「通过」就会把这题误报成 AC，模型以为整题都对就收工了
const partial = createJudgePage();
partial.__setJudgeText('判题结果：部分正确 通过测试点 6/10');
const partialOut = await runScript(partial, READ_JUDGE_SCRIPT, {});
check('部分正确不会因为旁边写着「通过测试点」被当成 AC', partialOut.includes('判题结论：PC') && !partialOut.includes('判题结论：AC'));

const partialPlain = createJudgePage();
partialPlain.__setJudgeText('部分正确 得分 60/100');
check('只写「部分正确」也能读出结论', (await runScript(partialPlain, READ_JUDGE_SCRIPT, {})).includes('PC'));

const partialEnglish = createJudgePage();
partialEnglish.__setJudgeText('Partial Correct');
check('英文的 Partial Correct 也认得', (await runScript(partialEnglish, READ_JUDGE_SCRIPT, {})).includes('PC'));

const statsOnly = createJudgePage();
statsOnly.__setJudgeText('通过测试点 6/10 通过率 60%');
const statsOut = await runScript(statsOnly, READ_JUDGE_SCRIPT, { waitSeconds: 0 });
check('只有通过率之类的统计时不硬报成 AC', !statsOut.includes('判题结论：AC') && statsOut.includes('还没读到'));

// 不同容器里结论不一致时按优先级取最具体的那个
const mixedPage = createJudgePage();
mixedPage.document.querySelector('.judge-panel').insertAdjacentHTML('afterend', '<div class="status">答案正确</div>');
mixedPage.__setJudgeText('部分正确 通过测试点 6/10');
const mixed = await runScript(mixedPage, READ_JUDGE_SCRIPT, {});
check('另一个容器写着「答案正确」也不覆盖更具体的部分正确', mixed.includes('判题结论：PC'));

// PTA 的结果页是英文的、结论不落在弹窗里，而是「Status 标签 + 结论值」放在同一个块里
// （实测 2026-10-22 的真实页面：div.space-y-1 里是 Status / Accepted）
function createEnglishJudgePage(verdict) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div class="legend"><span>Status</span><span>Score</span></div>
      <div class="grid grid-cols-3 gap-x-4 gap-y-3 p-3 rounded-lg bg-bg-light">
        <div class="space-y-1">
          <div class="flex space-x-1">
            <div class="pc-text pc-color-light pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>Status</span></div></div>
            <button class="pc-button pc-button-text pc-sm"><div class="pc-text pc-gap-4"><div class="pc-text-raw flex-auto break-words text-sm"><div class="pc-text inline pc-color-normal"><div class="pc-text-raw flex-auto break-words"><span>${verdict}</span></div></div></div></div></div></button>
          </div>
          <div class="pc-text pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>Score</span></div></div>
        </div>
      </div>
      <div class="border border-border rounded-lg overflow-hidden">
        <div class="flex items-center py-2 px-4 bg-bg-light text-xs font-bold"><span>Submission Detail</span></div>
        <div class="pc-text pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>Status</span></div></div>
        <div class="pc-text pc-gap-4"><div class="pc-text-raw flex-auto break-words text-xs"><span>Accepted</span></div></div>
      </div>
    </body></html>`,
    { url: 'https://pintia.cn/problem-sets/14/exam/problems/type/7?problemSetProblemId=781', runScripts: 'outside-only' },
  );
  return installInnerText(dom.window);
}

const englishAc = await runScript(createEnglishJudgePage('Accepted'), READ_JUDGE_SCRIPT, {});
check('英文结果页的 Accepted 归一化成 AC', englishAc.includes('判题结论：AC'));

const englishWa = await runScript(createEnglishJudgePage('Wrong Answer'), READ_JUDGE_SCRIPT, {});
check('英文结果页的 Wrong Answer 归一化成 WA', englishWa.includes('判题结论：WA'));

const englishPc = await runScript(createEnglishJudgePage('Partial Correct'), READ_JUDGE_SCRIPT, {});
check('英文结果页的 Partial Correct 归一化成 PC', englishPc.includes('判题结论：PC'));

// PTA 的部分得分判题原文是 "Partially Accepted"（实测 2026-10-22 真实页面），
// 它包含 "Accepted" —— 不单独认的话这题就被报成 AC 了
const englishPartialAccepted = await runScript(createEnglishJudgePage('Partially Accepted'), READ_JUDGE_SCRIPT, {});
check('英文结果页的 Partially Accepted 归一化成 PC（不是 AC）', englishPartialAccepted.includes('判题结论：PC') && !englishPartialAccepted.includes('判题结论：AC'));

// 明细表里每行都写着 Accepted，整体结论是 Wrong Answer —— 要报整体的
const englishMixed = await runScript(createEnglishJudgePage('Wrong Answer'), READ_JUDGE_SCRIPT, {});
check('明细里的 Accepted 盖不掉整体结论', englishMixed.includes('判题结论：WA'));

// 页面上的一段脚本源码里可能有孤零零的 RE/AC，不能当成判题结论
// （实测 PTA 页面里那段「不再支持旧浏览器」的提示脚本会被当成 RE）
const scriptNoise = createJudgePage();
scriptNoise.document.body.insertAdjacentHTML(
  'beforeend',
  `<script>var deprecationMsgEN = 'We have ceased the support for legacy browsers that you are currently using. Please switch to more recent versions of Microsoft Edge, Google Chrome, Firefox or QQ Browser.';</script>`,
);
scriptNoise.__setJudgeText('评测中');
const noiseOut = await runScript(scriptNoise, READ_JUDGE_SCRIPT, { waitSeconds: 0 });
check('脚本源码里的 RE 不会被当成判题结论', !noiseOut.includes('判题结论：RE'));

check(
  '页面上没有判题文字时如实告知',
  (await runScript(createPage({ withView: false }), READ_JUDGE_SCRIPT, { waitSeconds: 0 })).includes('没读到判题文字'),
);

// read_judge_result 会一直等到出结论：先只有「评测中」，几百毫秒后才变成结论
const pollingPage = createJudgePage();
setTimeout(() => pollingPage.__setJudgeText('答案正确'), 120);
const startedAt = Date.now();
const polled = await runScript(pollingPage, READ_JUDGE_SCRIPT, { pollMs: 50 });
check('read_judge_result 会轮询到结论出现为止', polled.includes('AC'));
check('轮询到结论就立刻返回，不会白等到超时', Date.now() - startedAt < 3000);

// 用户在结论出来之后、模型来读之前把弹窗关掉了：靠页面上的判题快照还能读到结论
const closedPage = createJudgePage();
closedPage.__setJudgeText('答案正确');
await runScript(closedPage, READ_JUDGE_SCRIPT, { pollMs: 50 });
closedPage.document.querySelector('.judge-panel').remove();
const afterClose = await runScript(closedPage, READ_JUDGE_SCRIPT, { pollMs: 50 });
check('弹窗被关掉后仍能读到这次结论', afterClose.includes('AC') && afterClose.includes('判题记录'));

// 结论只闪几十毫秒就被关掉时，观察器也必须把它记下来（不能只靠防抖读，否则快照里留的是上一次的旧结论）
const flashPage = createJudgePage();
await runScript(flashPage, READ_JUDGE_SCRIPT, { pollMs: 50 }); // 先让快照里存上「评测中」
flashPage.__setJudgeText('答案正确');
await new Promise((resolve) => setTimeout(resolve, 20));
flashPage.document.querySelector('.judge-panel').remove();
await new Promise((resolve) => setTimeout(resolve, 400)); // 等观察器补读
check('一闪而过的结论不会被漏掉、也不会退回旧结论', (await runScript(flashPage, READ_JUDGE_SCRIPT, { pollMs: 50 })).includes('AC'));

// 前一次 DOM 变化的防抖还没到点时出现的新结论，同样要立刻记下来（不能被防抖挡住开头那次读）
const burstPage = createJudgePage();
await runScript(burstPage, READ_JUDGE_SCRIPT, { pollMs: 50 });
burstPage.__setJudgeText('编译错误');
burstPage.__setJudgeText('答案错误');
await new Promise((resolve) => setTimeout(resolve, 20));
burstPage.document.querySelector('.judge-panel').remove();
await new Promise((resolve) => setTimeout(resolve, 400));
check('防抖期间的连续变化不会漏掉最后一次结论', (await runScript(burstPage, READ_JUDGE_SCRIPT, { pollMs: 50 })).includes('WA'));

// 页面还挂着「评测中」时不能拿快照里的旧结论交差：这次还在评测就得继续等
const stalePage = createJudgePage();
stalePage.__setJudgeText('答案正确');
await runScript(stalePage, READ_JUDGE_SCRIPT, { pollMs: 50 });
stalePage.__setJudgeText('评测中');
const stillJudging = await runScript(stalePage, READ_JUDGE_SCRIPT, { waitSeconds: 0, pollMs: 50 });
check('页面上还在评测时不返回快照里的旧结论', !stillJudging.includes('AC'));

// 重新提交要作废上一次的判题记录：面板空着时不能再把旧的结论报成本次的
const resubmitPage = createJudgePage();
resubmitPage.__setJudgeText('答案正确');
await runScript(resubmitPage, READ_JUDGE_SCRIPT, { pollMs: 50 });
resubmitPage.document.querySelector('.judge-panel').remove();
await runScript(resubmitPage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
const afterResubmit = await runScript(resubmitPage, READ_JUDGE_SCRIPT, { waitSeconds: 0, pollMs: 50 });
check('重新提交后不会再把上一次的结论当成本次的', !afterResubmit.includes('AC') && afterResubmit.includes('还没读到'));

// 「停止」置上的取消标记要能让等待立刻收工
const abortPage = createJudgePage();
abortPage.__ptaAborted = true;
const aborted = await runScript(abortPage, READ_JUDGE_SCRIPT, { waitSeconds: 60, pollMs: 50 });
check('取消标记能让等待中的读取立刻收工', aborted.includes('已按用户要求停止'));

// 轮询到结论后立刻返回
const slowPage = createJudgePage();
setTimeout(() => slowPage.__setJudgeText('运行超时'), 30);
const slow = await runScript(slowPage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('轮询到结论后立刻返回', slow.includes('TLE'));

// 关弹窗：read_judge_result 拿到结论后会自动关，不再作为独立工具暴露给模型
const dialogWindow = new JSDOM(
  `<!doctype html><html><body>
     <div class="pc-modal">
       <div class="pc-modal-content">判题结果：答案正确</div>
       <button class="pc-close">关闭</button>
     </div>
   </body></html>`,
  { url: 'https://pintia.cn/problem-sets/1/problems/1', runScripts: 'outside-only' },
).window;
installInnerText(dialogWindow);
dialogWindow.document.querySelector('.pc-close').addEventListener('click', () => {
  dialogWindow.document.querySelector('.pc-modal').remove();
});
check('read_judge_result 拿到结论后会自动关掉弹窗', (await runScript(dialogWindow, READ_JUDGE_SCRIPT, {})).includes('判题结果'));
check('弹窗确实被自动关掉了', !dialogWindow.document.querySelector('.pc-modal'));

// close_dialogs 是独立工具：submit_answer 之前要能自己确认并关掉「提交结果 dialog」
const closeWindow = new JSDOM(
  `<!doctype html><html><body>
     <div class="pc-modal">
       <div class="pc-modal-content">Submit Result</div>
       <button class="pc-button"><svg><use xlink:href="#pat-close"></use></svg></button>
       <button class="pc-button">OK</button>
     </div>
   </body></html>`,
  { url: 'https://pintia.cn/problem-sets/1/problems/1', runScripts: 'outside-only' },
).window;
installInnerText(closeWindow);
closeWindow.document.querySelector('.pc-modal').addEventListener('click', () => {
  closeWindow.document.querySelector('.pc-modal').remove();
});
check('close_dialogs 关掉了弹窗', (await runScript(closeWindow, CLOSE_DIALOGS_SCRIPT, {})).includes('已关掉'));
check('close_dialogs 之后弹窗确实不在页面上了', !closeWindow.document.querySelector('.pc-modal'));
check(
  '没有弹窗时 close_dialogs 如实告知',
  (await runScript(createPage({ withView: false }), CLOSE_DIALOGS_SCRIPT, {})).includes('没找到需要关的弹窗'),
);

// PTA 的英文考试页：关闭按钮是纯图标（<use xlink:href="#pat-close">），没有文字也没有 close 类名
const iconCloseWindow = new JSDOM(
  `<!doctype html><html><body>
     <div class="modal_P0ST1 pc-modal">
       <button class="pc-button pc-button-borderless"><svg><use xlink:href="#pat-close"></use></svg></button>
       <button class="pc-button">OK</button>
     </div>
   </body></html>`,
  { url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7', runScripts: 'outside-only' },
).window;
installInnerText(iconCloseWindow);
iconCloseWindow.document.querySelector('.pc-modal').addEventListener('click', () => {
  iconCloseWindow.document.querySelector('.pc-modal').remove();
});
check('close_dialogs 认得英文页的图标关闭按钮', (await runScript(iconCloseWindow, CLOSE_DIALOGS_SCRIPT, {})).includes('已关掉'));
check('英文页的弹窗确实被关掉了', !iconCloseWindow.document.querySelector('.pc-modal'));

// PTA 的 bug：提交后判题结果不会自己刷新，页面上有「刷新 / Reload」按钮，
// 不点它就一直停在「评测中 / Waiting」
const reloadWindow = createJudgePage();
reloadWindow.document.body.insertAdjacentHTML(
  'beforeend',
  '<button id="reload">刷新</button>',
);
let reloadClicks = 0;
reloadWindow.document.querySelector('#reload').addEventListener('click', () => {
  reloadClicks += 1;
});
const waited = await runScript(reloadWindow, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 200 });
check('提交时等待结论会点「刷新」按钮', reloadClicks > 0);
check('等待超时会告诉模型可以刷新页面', waited.includes('refresh_page'));

/* ---------- 模拟运行 / 编译器输出 ---------- */

// 搭一个跟真实 PTA 一样的页面：作答区下面有「测试用例」按钮，点开才出现「运行测试」，
// 跑完结果落在「编译器输出」区域里
function createRunPage() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>
       <button id="tc">测试用例</button>
       <div id="testPanel" style="display:none">
         <button id="run">运行测试</button>
         <div id="outputPanel">
           <span>编译器输出</span>
           <div id="out"></div>
         </div>
       </div>
     </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/exam/problems/type/6?problemSetProblemId=1',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = installInnerText(dom.window);
  const doc = window.document;
  doc.querySelector('#tc').addEventListener('click', () => {
    doc.querySelector('#testPanel').style.display = '';
  });
  doc.querySelector('#run').addEventListener('click', () => {
    window.setTimeout(() => {
      const out = doc.querySelector('#out');
      out.innerHTML = '<pre>Traceback (most recent call last):\nEOFError: EOF when reading a line</pre>';
    }, 30);
  });
  return window;
}

const runPage = createRunPage();
const runOut = await runScript(runPage, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('simulate_pta_run 会先展开测试区再点运行', runPage.document.querySelector('#testPanel').style.display === '');
check('simulate_pta_run 读回了编译器输出', runOut.includes('EOFError'));
check('simulate_pta_run 的返回值里带编译器输出', runOut.includes('已点击「运行测试」'));

const compileOut = await runScript(runPage, READ_PTA_COMPILE_RESULT_SCRIPT, {});
check('read_pta_compile_result 读的是「编译器输出」区域', compileOut.includes('EOFError'));
check('read_pta_compile_result 不会把题面样例混进来', !compileOut.includes('输入样例'));

// 没有测试区也没有运行按钮时如实告知
const noRunPage = createPage({ withView: false, body: '<div>没有运行入口</div>' });
const noRunOut = await runScript(noRunPage, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('找不到运行按钮时如实告知', noRunOut.includes('没找到「运行测试 / Run Test Case」按钮'));

// 还没跑过时，读取要提示怎么跑
const notRunYet = createRunPage();
const notRunOut = await runScript(notRunYet, READ_PTA_COMPILE_RESULT_SCRIPT, {});
check('还没跑过时提示先点运行测试', notRunOut.includes('运行测试'));

/* ---------- simulate_pta_run 传入数据集（英文考试页的真实结构） ---------- */

// 复刻真实英文考试页：作答区在 CodingProblemAnswerForm 里，测试输入框是另一个可写编辑器，
// 结果是两块只读 CodeMirror（Running Result / Expected Result）
function createEnglishRunPage() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div class="relative flex flex-col h-full answerInput_fu6n6">
         <div class="CodingProblemAnswerForm_JoDvx flex flex-col flex-1">
           <div class="cm-editor"><div class="cm-scroller">
             <div class="cm-content" contenteditable="true"><div class="cm-line">print(1)</div></div>
           </div></div>
         </div>
         <div class="flex flex-col bg-bg-base border-t border-solid border-border">
           <button id="tc">Test Case</button>
           <div id="panel" style="display:none">
             <div class="codeEditor flex-1"><div class="cm-editor"><div class="cm-scroller">
               <div class="cm-content" contenteditable="true"><div class="cm-line"></div></div>
             </div></div></div>
             <button id="run">Run Test Case</button>
             <div id="results" style="display:none">
               <span>Running Result</span>
               <div class="cm-editor"><div class="cm-scroller">
                 <div class="cm-content" contenteditable="false" aria-readonly="true">
                   <div class="cm-line">42</div>
                 </div>
               </div></div>
               <span>Expected Result</span>
               <div class="cm-editor"><div class="cm-scroller">
                 <div class="cm-content" contenteditable="false" aria-readonly="true">
                   <div class="cm-line">42</div>
                 </div>
               </div></div>
             </div>
           </div>
         </div>
       </div>
     </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7?problemSetProblemId=1',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = installInnerText(dom.window);
  const doc = window.document;
  // 测试输入框在真实 PTA 上是有编辑器实例的（cmTile.view），插件靠它整段写入
  let testInput = '';
  const inputEditor = doc.querySelector('.codeEditor.flex-1 .cm-content');
  inputEditor.cmTile = {
    view: {
      state: {
        get doc() {
          return { toString: () => testInput, length: testInput.length, lines: testInput.split('\n').length };
        },
        readOnly: false,
      },
      dispatch: (transaction) => {
        if (transaction.changes && typeof transaction.changes.from === 'number') {
          const from = transaction.changes.from;
          const to = typeof transaction.changes.to === 'number' ? transaction.changes.to : from;
          testInput = testInput.slice(0, from) + (transaction.changes.insert ?? '') + testInput.slice(to);
        }
      },
    },
  };
  window.__testInput = () => testInput;
  doc.querySelector('#tc').addEventListener('click', () => {
    doc.querySelector('#panel').style.display = '';
  });
  doc.querySelector('#run').addEventListener('click', () => {
    window.setTimeout(() => {
      doc.querySelector('#results').style.display = '';
    }, 30);
  });
  return window;
}

const englishRun = createEnglishRunPage();
const englishRunOut = await runScript(englishRun, SIMULATE_PTA_RUN_SCRIPT, {
  stdin: '7 8\n',
  waitSeconds: 5,
  pollMs: 10,
});
check('英文考试页的测试面板能展开', englishRun.document.querySelector('#panel').style.display === '');
check('simulate_pta_run 把数据集写进了测试输入框', englishRunOut.includes('已把数据集写进测试输入框'));
check(
  '数据集写到了测试输入框（不是作答区）',
  englishRun.__testInput().includes('7 8'),
);
check('作答区没有被数据集覆盖', englishRun.document.querySelector('.CodingProblemAnswerForm_JoDvx .cm-content').innerText.includes('print(1)'));
check('英文页的结果读回来了', englishRunOut.includes('42'));
check('英文页的期望输出也读回来了', englishRunOut.includes('期望输出'));

// 没给 stdin 时不该动面板里原有的输入
const englishNoStdin = createEnglishRunPage();
const englishNoStdinOut = await runScript(englishNoStdin, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('不给数据集时不会去写测试输入框', !englishNoStdinOut.includes('已把数据集写进测试输入框'));

// 真机 7-2：测试区里本来就列着几组「输入 / 期望输出」只读框，不能当运行结果
const staleCasesPage = createSampleBoxPage();
staleCasesPage.document.body.insertAdjacentHTML('beforeend', `
  <button id="tc">Test Case</button>
  <div id="cases">
    <button id="run">Run Test Case</button>
    <div class="cm-editor"><div class="cm-content" contenteditable="false" aria-readonly="true"><div class="cm-line">1988 4</div></div></div>
    <div class="cm-editor"><div class="cm-content" contenteditable="false" aria-readonly="true"><div class="cm-line">25 2013</div></div></div>
  </div>`);
const staleCasesOut = await runScript(staleCasesPage, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 1, pollMs: 10 });
check('测试区自带的用例表不会被当成运行结果', !staleCasesOut.includes('1988 4') && !staleCasesOut.includes('25 2013'), staleCasesOut);

/* ---------- 新版 PTA：结果区是页签，容器在标题上方第 5 层 ---------- */

// 复刻真实页面（2026-11 实测）：
//   button[Test Case | Running Result | Compiler's Log]  ->  结果容器在标题上方 5 层
//   只有当前页签的内容会挂载；点「Run Test Case」不会自动切页签
function createTabbedRunPage({ result = '', log = '' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div class="CodingProblemAnswerForm_JoDvx">
         <div class="cm-editor"><div class="cm-content" contenteditable="true"><div class="cm-line">print(1)</div></div></div>
       </div>
       <div id="testPanel">
         <div class="headerWrap"><div class="headerRow"><div class="tabs">
           <div class="tabItem"><button id="tabCase"><div class="pc-text">Test Case</div></button></div>
           <div class="tabItem"><button id="tabRun"><div class="pc-text">Running Result</div></button></div>
           <div class="tabItem"><button id="tabLog"><div class="pc-text">Compiler's Log</div></button></div>
         </div></div></div>
         <div id="stage"></div>
         <button id="run">Run Test Case</button>
       </div>
     </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/exam/problems/type/6?problemSetProblemId=2',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = installInnerText(dom.window);
  const doc = window.document;
  const makeEditor = (text, editable) => {
    const wrap = doc.createElement('div');
    wrap.innerHTML = `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" ${
      editable ? 'contenteditable="true"' : 'contenteditable="false" aria-readonly="true"'
    }><div class="cm-line">${text}</div></div></div></div>`;
    return wrap;
  };
  const bodies = {
    case: makeEditor('2\n', true),
    run: makeEditor('', false),
    log: makeEditor(log, false),
  };
  const stage = doc.querySelector('#stage');
  const show = (name) => stage.replaceChildren(bodies[name]);
  show('case');
  doc.querySelector('#tabCase').addEventListener('click', () => show('case'));
  doc.querySelector('#tabRun').addEventListener('click', () => show('run'));
  doc.querySelector('#tabLog').addEventListener('click', () => show('log'));
  doc.querySelector('#run').addEventListener('click', () => {
    if (!result) return;
    window.setTimeout(() => {
      bodies.run.innerHTML = `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" contenteditable="false" aria-readonly="true"><div class="cm-line">${result}</div></div></div></div>`;
    }, 30);
  });
  window.__activeTab = () => (stage.firstElementChild === bodies.run ? 'run' : stage.firstElementChild === bodies.log ? 'log' : 'case');
  return window;
}

const tabbedRun = createTabbedRunPage({ result: '1\n[28]' });
const tabbedOut = await runScript(tabbedRun, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('新版页签式结果：simulate_pta_run 读到了 Running Result', tabbedOut.includes('1\n[28]'));
check('结果不会自动切页签时，插件会自己点开结果页签', tabbedRun.__activeTab() === 'run');

const tabbedReader = await runScript(tabbedRun, READ_PTA_COMPILE_RESULT_SCRIPT, {});
check('read_pta_compile_result 能读新版页签里的结果', tabbedReader.includes('1\n[28]'));

// 运行结果为空：编译错误在 Compiler's Log 页签里
const tabbedLogRun = createTabbedRunPage({ log: 'Traceback (most recent call last):\nNameError: name x is not defined' });
const tabbedLogOut = await runScript(tabbedLogRun, SIMULATE_PTA_RUN_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('结果为空时回退到 Compiler\'s Log', tabbedLogOut.includes('NameError'));
check('回退说明来自哪个页签', tabbedLogOut.includes("Compiler's Log"));

/* ---------- 作答区的语言（Python 2 / Python 3 要分得清） ---------- */

// 复刻 PTA 的 react-select：控制块显示当前语言，点开后菜单里是可选项
function createLanguagePage(language, options = []) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div class="select__control">${language}</div>
       <div class="select__menu-portal" style="display:none">
         ${options.map((option) => `<div class="select__option">${option}</div>`).join('')}
       </div>
     </body></html>`,
    { url: 'https://pintia.cn/problem-sets/1/exam/problems/type/7', runScripts: 'outside-only' },
  );
  const window = dom.window;
  const doc = window.document;
  const control = doc.querySelector('.select__control');
  const menu = doc.querySelector('.select__menu-portal');
  doc.addEventListener('click', (event) => {
    if (event.target === control || control.contains(event.target)) {
      menu.style.display = '';
      return;
    }
    const option = event.target.closest ? event.target.closest('.select__option') : null;
    if (option) {
      control.textContent = option.textContent;
      menu.style.display = 'none';
    }
  });
  return window;
}

const py3Page = createLanguagePage('Python (python3)', ['Python (python2)', 'Python (python3)']);
const py3Info = await runScript(py3Page, LANGUAGE_SCRIPT, {});
check('认得出页面上选的是 Python 3', py3Info.language === 'python3', py3Info);

// 这里必须能分清 python2 与 python3：正则写在模板字符串里，
// 反斜杠没转义对就会变成 /pythons*(?s*2/ 这种非法正则（实测踩过）
const py2Page = createLanguagePage('Python (python2)', ['Python (python2)', 'Python (python3)']);
const py2Info = await runScript(py2Page, LANGUAGE_SCRIPT, {});
check('认得出页面上选的是 Python 2', py2Info.language === 'python2', py2Info);

const cPage = createLanguagePage('C (gcc 9.2)', ['C (gcc 9.2)']);
check('认得出页面上选的是 C', (await runScript(cPage, LANGUAGE_SCRIPT, {})).language === 'c');

// C++ 也必须排在 C 前面判：'C++ (g++)' 会被 /^c\b/ 命中成 C
const cppPage = createLanguagePage('C++ (g++ 9.2)', ['C++ (g++ 9.2)', 'C (gcc 9.2)']);
check('C++ 不会被误认成 C', (await runScript(cppPage, LANGUAGE_SCRIPT, {})).language === 'cpp');

// 切语言：Python 2 的题切成 Python 3
const switchPage = createLanguagePage('Python (python2)', ['Python (python2)', 'Python (python3)']);
const switched = await runScript(switchPage, LANGUAGE_SCRIPT, { target: 'python3' });
check('能把作答语言切到 Python 3', switched.ok === true, switched);
check('切完之后页面上的语言变成 Python 3', switched.language === 'python3', switched);
check('切换的说明写进了返回值', String(switched.detail || '').includes('Python (python3)'), switched);

// set_language 工具传的是 language，不是 target
const switchedByAlias = await runScript(switchPage, LANGUAGE_SCRIPT, { language: 'python3' });
check('LANGUAGE_SCRIPT 也接受 language 参数（工具名）', switchedByAlias.language === 'python3', switchedByAlias);

// 题组不允许切的时候要如实说明，不能假装成功
const noPython3Page = createLanguagePage('Python (python2)', ['Python (python2)']);
const refused = await runScript(noPython3Page, LANGUAGE_SCRIPT, { target: 'python3' });
check('切不了的时候如实报告并列出可选语言', refused.ok === false && String(refused.detail || '').includes('Python (python2)'), refused);

/* ---------- 提交按钮可用性 ---------- */

const readyPage = createPage();
readyPage.document.body.innerHTML = `<button id="s">提交本题作答</button>`;
check('check_ready 报告提交按钮可用', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前可用'));
readyPage.document.querySelector('#s').disabled = true;
check('按钮禁用时如实报告', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前是禁用的'));
const noButtonPage = createPage({ withView: false });
check('找不到按钮时列出页面上的按钮便于排查', (await runScript(noButtonPage, CHECK_READY_SCRIPT, {})).includes('没找到提交按钮'));

console.log('\nPTA 三件套校验通过');
