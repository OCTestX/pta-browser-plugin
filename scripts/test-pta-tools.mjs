// PTA 三件套与多种输入方法的页面脚本测试：在 jsdom 里搭一个假 CodeMirror 6，
// 实例挂在 #pta-answer-editor 的 cmTile.view 上（和 PTA 一致），脚本用页面 realm 的 AsyncFunction 跑。
// 用法：node scripts/test-pta-tools.mjs
import { JSDOM } from 'jsdom';
import { assertDistFresh } from './dist-fresh.mjs';
import {
  CHECK_READY_SCRIPT,
  CLOSE_DIALOGS_SCRIPT,
  INPUT_METHOD_SCRIPT,
  READ_EDITOR_SCRIPT,
  READ_JUDGE_SCRIPT,
  READ_PROBLEM_SCRIPT,
  SUBMIT_ANSWER_SCRIPT,
} from '../src/background/pta-scripts.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
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
check('close_dialogs：关闭控件在弹窗内部才会被点到', (await runScript(dialogWindow, CLOSE_DIALOGS_SCRIPT, {})).includes('已关掉 1 层弹窗'));
check('弹窗确实被关掉了', !dialogWindow.document.querySelector('.pc-modal'));
check('没有弹窗时如实告知', (await runScript(createPage({ withView: false }), CLOSE_DIALOGS_SCRIPT, {})).includes('没找到需要关的弹窗'));

/* ---------- 提交按钮可用性 ---------- */

const readyPage = createPage();
readyPage.document.body.innerHTML = `<button id="s">提交本题作答</button>`;
check('check_ready 报告提交按钮可用', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前可用'));
readyPage.document.querySelector('#s').disabled = true;
check('按钮禁用时如实报告', (await runScript(readyPage, CHECK_READY_SCRIPT, {})).includes('当前是禁用的'));
const noButtonPage = createPage({ withView: false });
check('找不到按钮时列出页面上的按钮便于排查', (await runScript(noButtonPage, CHECK_READY_SCRIPT, {})).includes('没找到提交按钮'));

console.log('\nPTA 三件套校验通过');
