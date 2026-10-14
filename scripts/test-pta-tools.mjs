// PTA 三件套脚本（读题面 / 读代码 / 写代码）在 jsdom 里跑一遍：
// 假页面里放一个「编辑器实例挂在 DOM 上」（cmTile.view，跟 PTA 一样）的假 CodeMirror，
// 验证 view 发现的路径、整段覆写、退路、回读比对，以及题面容器的优先级。
// 用法：node scripts/test-pta-tools.mjs
import { JSDOM } from 'jsdom';
import {
  CHECK_READY_SCRIPT,
  INPUT_METHOD_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
  WRITE_EDITOR_SCRIPT,
} from '../src/background/pta-scripts.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

/** 把脚本当成插件注入的那段代码来跑：__args 注入 + AsyncFunction 包裹（脚本里能用 return / await） */
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

async function runScript(window, source, args) {
  const withArgs = args === undefined ? source : `const __args = ${JSON.stringify(args)};\n${source}`;
  // 必须在页面自己的 realm 里造函数，跟插件注入时一样，脚本才看得到 document / window
  const AsyncFunction = Object.getPrototypeOf(window.eval('(async function () {})')).constructor;
  return await new AsyncFunction(withArgs)();
}

function createPage({ withView = true, body = '', sampleBoxes = 0 } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>7-1 星期几</title></head><body>${body}</body></html>`, {
    url: 'https://pintia.cn/problem-sets/1/problems/1150901824503297/description',
    // 只有开了 runScripts 才有真正跑在页面 realm 里的 window.eval
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  installInnerText(window);

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
    // 假 CodeMirror 6：实例挂在 #pta-answer-editor 的 cmTile.view 上，行为和 PTA 一致
    const editor = window.document.createElement('div');
    editor.id = 'pta-answer-editor';
    const content = window.document.createElement('div');
    content.className = 'cm-content';
    content.setAttribute('contenteditable', 'true');
    editor.appendChild(content);
    window.document.body.appendChild(editor);

    let doc = '#include <stdio.h>\nint main(void) {\n  return 0;\n}';
    const listeners = [];
    editor.cmTile = {
      view: {
        state: {
          get doc() {
            return { toString: () => doc, length: doc.length, lines: doc.split('\n').length };
          },
          readOnly: false,
        },
        dispatch: (transaction) => {
          // 真实 CM6 的 dispatch 既能改文档，也能只挪光标；两种都要接住
          if (transaction.changes && typeof transaction.changes.from === 'number') {
            const from = transaction.changes.from;
            // 真实 CM6 里 {from, insert} 不写 to 就等于「在 from 处插入」，to 默认取 from
            const to = typeof transaction.changes.to === 'number' ? transaction.changes.to : from;
            doc = doc.slice(0, from) + (transaction.changes.insert ?? '') + doc.slice(to);
          }
          if (transaction.selection) window.__lastSelection = transaction.selection;
        },
        on: (fn) => listeners.push(fn),
      },
    };
    content.textContent = doc.split('\n').join('\n'); // 让 DOM 里也有内容（退路/长度判断用）
    window.__doc = () => doc;
  }

  return window;
}

async function pressableJsdom(window) {
  // 等 React/异步 setTimeout(200) 之类跑完
  await new Promise((resolve) => setTimeout(resolve, 30));
  return window;
}

/* ---------- 读题面 ---------- */

const problemPage = createPage({
  withView: false,
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
check('抠出了样例输出', examProblem.includes('样例 1 输出：' + '```' + '\n7\n' + '```'));
check('样例里的「复制」按钮文字被滤掉', !examProblem.includes('复制'));

const longProblem = await runScript(problemPage, READ_PROBLEM_SCRIPT, { maxChars: 5 });
check('题面过长会截断并说明', longProblem.includes('已截断'));

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

// 题面样例框也是 CM 实例且挂在前面：必须跳过只读的，选真正的作答区
const samplePage = createPage({ sampleBoxes: 2 });
const sampleRead = await runScript(samplePage, READ_EDITOR_SCRIPT, {});
check('前面有只读样例框时，读到的是真正的作答区', sampleRead.includes('int main(void)') && !sampleRead.includes('3 4'));
const sampleWrite = await runScript(samplePage, WRITE_EDITOR_SCRIPT, { code: 'int main(void) { return 0; }' });
check('写代码也跳过只读样例框，写进作答区', samplePage.__doc() === 'int main(void) { return 0; }' && sampleWrite.includes('整段覆写'));
check('写完之后光标停在文末（后面用真实按键戳一下不会插进代码中间）', samplePage.__lastSelection?.anchor === samplePage.__doc().length);

// samplesOnly：给写入后自动检查用的结构化样例
// 真实链路里 injectScript 会把返回值 JSON 化，这里直接拿到对象，两种都兼容
const sampleRaw = await runScript(examPage, READ_PROBLEM_SCRIPT, { samplesOnly: true });
const parsedSamples = typeof sampleRaw === 'string' ? JSON.parse(sampleRaw) : sampleRaw;
check('samplesOnly 返回结构化样例', Array.isArray(parsedSamples.samples) && parsedSamples.samples[0].input === '3 4' && parsedSamples.samples[0].output === '7');

// 提交按钮可用性
const readyPage = new JSDOM(
  `<!doctype html><html><body><button id="s">提交本题作答</button></body></html>`,
  { url: 'https://pintia.cn/problem-sets/1/problems/1', runScripts: 'outside-only' },
).window;
installInnerText(readyPage);
check('check_ready 报告提交按钮可用', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前可用'));
readyPage.document.querySelector('#s').disabled = true;
check('按钮禁用时如实报告', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前是禁用的'));
const noButtonPage = createPage({ withView: false });
check('找不到按钮时列出页面上的按钮便于排查', (await runScript(noButtonPage, CHECK_READY_SCRIPT, {})).includes('没找到提交按钮'));

// 只有只读样例框时要明确说清，而不是含糊报「编辑器是只读的」
const onlyReadOnly = createPage({ withView: false, sampleBoxes: 2 });
const onlyReadOnlyResult = await runScript(onlyReadOnly, WRITE_EDITOR_SCRIPT, { code: 'x' });
check('只有只读样例框时说清是样例框、没有作答区', onlyReadOnlyResult.includes('只读编辑器') && onlyReadOnlyResult.includes('样例框'));

/* ---------- 写代码 ---------- */

const writePage = createPage();
const code = '#include <stdio.h>\nint main(void) {\n  long long n = 0;\n  return 0;\n}\n';
const written = await runScript(writePage, WRITE_EDITOR_SCRIPT, { code });
check('通过编辑器实例整段覆写成功', writePage.__doc() === code);
check('写代码结果里说明走了实例与回读一致', written.includes('cmTile.view') && written.includes('与目标一致'));

const appended = await runScript(writePage, WRITE_EDITOR_SCRIPT, { code: '// 追加一行', clear: false });
check('clear=false 时追加而不是覆写', writePage.__doc().startsWith(code) && writePage.__doc().includes('// 追加一行'));

check('缺 code 参数时返回提示', (await runScript(writePage, WRITE_EDITOR_SCRIPT, {})).includes('没有给 code 参数'));

// 只读编辑器要拦住
const readOnlyPage = createPage();
readOnlyPage.document.querySelector('#pta-answer-editor').cmTile.view.state.readOnly = true;
check('只读编辑器会拒绝写入', (await runScript(readOnlyPage, WRITE_EDITOR_SCRIPT, { code })).includes('只读'));

// 没有实例时的退路：聚焦 + 全选 + execCommand 整段插入
const fallbackPage = createPage({ withView: false });
let inserted = null;
const area = fallbackPage.document.createElement('div');
area.className = 'cm-content';
area.setAttribute('contenteditable', 'true');
fallbackPage.document.body.appendChild(area);
fallbackPage.document.execCommand = (command, _ui, value) => {
  inserted = value;
  // 用 DOM API 拼，别走 innerHTML（代码里的 <stdio.h> 会被当成标签解析掉）
  area.innerHTML = '';
  for (const line of value.split('\n')) {
    const node = fallbackPage.document.createElement('div');
    node.className = 'cm-line';
    node.textContent = line;
    area.appendChild(node);
  }
  return true;
};
const fallback = await runScript(fallbackPage, WRITE_EDITOR_SCRIPT, { code });
check('没有实例时退到整段插入', inserted === code);
check('退路的结果里说明了走的是退路且回读一致', fallback.includes('没拿到编辑器实例') && fallback.includes('与目标一致'));

// 回读不一致要如实报出来
const mismatchPage = createPage();
mismatchPage.document.querySelector('#pta-answer-editor').cmTile.view.dispatch = () => {};
const mismatch = await runScript(mismatchPage, WRITE_EDITOR_SCRIPT, { code });
check(
  '写进去的内容与目标不符时会报出第几行不一致',
  mismatch.includes('不一致') && /第 \d+ 行/.test(mismatch) && mismatch.includes('long long n = 0;'),
);

/* ---------- 提交与判题 ---------- */

function createJudgePage({ judgeTextAfter, label = '提交本题作答' } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <button class="tab">提交</button>
      <button id="real-submit">${label}</button>
      <div class="judge-panel">评测中</div>
    </body></html>`,
    { url: 'https://pintia.cn/problem-sets/1/problems/1', runScripts: 'outside-only' },
  );
  const { window } = dom;
  installInnerText(window);
  const clicks = [];
  window.document.querySelector('#real-submit').addEventListener('click', () => clicks.push('real'));
  window.document.querySelector('.tab').addEventListener('click', () => clicks.push('tab'));
  window.__clicks = clicks;
  window.__setJudgeText = (text) => {
    window.document.querySelector('.judge-panel').textContent = text;
  };
  window.__judgeTextAfter = judgeTextAfter;
  return window;
}

// 按钮选择：同名标签页在前也不能点错
const judgePage = createJudgePage();
const submitted = await runScript(judgePage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('提交时点的是同名按钮里精确匹配的那个（不是标签页）', judgePage.__clicks.join(',') === 'real');
check('没出结论时如实说还没出结论而不是瞎报', submitted.includes('还没出结论'));

// 结论要同时满足「非空 ∧ 与提交前不同 ∧ 能归一化成状态码」
judgePage.__setJudgeText('评测中');
const stillPending = await runScript(judgePage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('只有「评测中」时不算结论', stillPending.includes('还没出结论'));

const acPage = createJudgePage();
const acRun = await runScript(acPage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('判题面板文字变了之后拿到结论', acRun.includes('还没出结论') || acRun.includes('判题结论'));
acPage.__setJudgeText('答案正确');
const ac = await runScript(acPage, READ_JUDGE_SCRIPT, {});
check('read_judge_result 归一化出 AC', ac.includes('AC'));

// 归一化的顺序：具体状态优先于泛化词，否定词优先于肯定词
const compileError = createJudgePage();
compileError.__setJudgeText('编译错误');
check('编译错误归成 CE 而不是 WA', (await runScript(compileError, READ_JUDGE_SCRIPT, {})).includes('CE'));

const notPassed = createJudgePage();
notPassed.__setJudgeText('未通过 部分测试点答案错误');
check('「未通过」不会被当成通过', (await runScript(notPassed, READ_JUDGE_SCRIPT, {})).includes('未通过'));

check('页面上没有判题文字时如实告知', (await runScript(createPage({ withView: false }), READ_JUDGE_SCRIPT, {})).includes('没读到判题文字'));

// 等结论时会轮询直到文字变化
const slowPage = createJudgePage();
setTimeout(() => slowPage.__setJudgeText('运行超时'), 30);
const slow = await runScript(slowPage, SUBMIT_ANSWER_SCRIPT, { waitSeconds: 5, pollMs: 10 });
check('轮询到结论后立刻返回', slow.includes('TLE'));

// 关弹窗
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
const closed = await runScript(dialogWindow, CLOSE_DIALOGS_SCRIPT, {});
check('关闭控件在弹窗内部才会被点到', closed.includes('已关掉 1 层弹窗'));
check('弹窗确实被关掉了', !dialogWindow.document.querySelector('.pc-modal'));
check('没有弹窗时如实告知', (await runScript(createPage({ withView: false }), CLOSE_DIALOGS_SCRIPT, {})).includes('没找到需要关的弹窗'));

/* ---------- 多种输入方法（设置页测试按钮用的那串） ---------- */

const methodText = 'int main(void) {\n  return 0;\n}';

// 1) 编辑器实例整段 dispatch
const dispatchPage = createPage();
const dispatchResult = await runScript(dispatchPage, INPUT_METHOD_SCRIPT, { method: 'dispatch', text: methodText });
check('方法 dispatch：整段写入并回读一致', dispatchPage.__doc() === methodText && dispatchResult.includes('回读比对：') && methodText.trim() === dispatchPage.__doc().trim());

// 2) 编辑器实例逐行 dispatch（带 userEvent）
const typedPage = createPage();
const typedResult = await runScript(typedPage, INPUT_METHOD_SCRIPT, { method: 'dispatchTyped', text: methodText });
check('方法 dispatchTyped：逐行写入后内容一致', typedPage.__doc() === methodText && typedResult.includes('userEvent'));

// 3) 聚焦 + execCommand
const execPage = createPage({ withView: false });
const execArea = execPage.document.createElement('div');
execArea.className = 'cm-content';
execArea.setAttribute('contenteditable', 'true');
execPage.document.body.appendChild(execArea);
let execText = null;
execPage.document.execCommand = (command, _ui, value) => {
  execText = value;
  execArea.innerHTML = '';
  for (const line of value.split('\n')) {
    const node = execPage.document.createElement('div');
    node.className = 'cm-line';
    node.textContent = line;
    execArea.appendChild(node);
  }
  return true;
};
const execResult = await runScript(execPage, INPUT_METHOD_SCRIPT, { method: 'execCommand', text: methodText });
check('方法 execCommand：走 execCommand 且回读一致', execText === methodText && execResult.includes('execCommand'));

// 4) 手工派发输入事件（不改 DOM，预期内容不会变）
const eventsPage = createPage({ withView: false });
const eventsArea = eventsPage.document.createElement('div');
eventsArea.className = 'cm-content';
eventsArea.setAttribute('contenteditable', 'true');
eventsPage.document.body.appendChild(eventsArea);
const fired = [];
eventsArea.addEventListener('input', () => fired.push('input'));
const eventsResult = await runScript(eventsPage, INPUT_METHOD_SCRIPT, { method: 'inputEvents', text: methodText });
check('方法 inputEvents：事件派发了，但内容没变（如实报不一致）', fired.includes('input') && eventsResult.includes('不一致'));

// 5) 剪贴板：写成功就交给 background 发 Ctrl+V；写失败要如实说
const clipPage = createPage({ withView: false });
// jsdom 的 navigator.clipboard 是只读的，得用 defineProperty
Object.defineProperty(clipPage.navigator, 'clipboard', {
  value: { writeText: async () => {} },
  configurable: true,
});
check('方法 clipboard：写进剪贴板后交给 Ctrl+V', (await runScript(clipPage, INPUT_METHOD_SCRIPT, { method: 'clipboard', text: methodText })).includes('剪贴板'));
const noClipPage = createPage({ withView: false });
delete noClipPage.navigator.clipboard;
check('方法 clipboard：环境不支持时如实报告', (await runScript(noClipPage, INPUT_METHOD_SCRIPT, { method: 'clipboard', text: methodText })).includes('写剪贴板失败'));

// 6) 页面弹「禁止粘贴」时要能读出来（这正是我们在查的现象）
const noticePage = createPage();
const toast = noticePage.document.createElement('div');
toast.className = 'el-message';
toast.textContent = '禁止粘贴';
noticePage.document.body.appendChild(toast);
const noticeResult = await runScript(noticePage, INPUT_METHOD_SCRIPT, { method: 'dispatch', text: methodText });
check('页面出现「禁止粘贴」提示时会写进结果', noticeResult.includes('页面上出现了提示') && noticeResult.includes('禁止粘贴'));

check('未知方法如实报告', (await runScript(createPage(), INPUT_METHOD_SCRIPT, { method: '???', text: 'x' })).includes('未知方法'));
check('空文本直接报错', (await runScript(createPage(), INPUT_METHOD_SCRIPT, { method: 'dispatch', text: '' })).includes('没有给 text'));

await pressableJsdom(problemPage);
console.log('\nPTA 三件套校验通过');
