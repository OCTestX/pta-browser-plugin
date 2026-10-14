// PTA 三件套脚本（读题面 / 读代码 / 写代码）在 jsdom 里跑一遍：
// 假页面里放一个「编辑器实例挂在 DOM 上」（cmTile.view，跟 PTA 一样）的假 CodeMirror，
// 验证 view 发现的路径、整段覆写、退路、回读比对，以及题面容器的优先级。
// 用法：node scripts/test-pta-tools.mjs
import { JSDOM } from 'jsdom';
import {
  READ_EDITOR_SCRIPT,
  READ_PROBLEM_SCRIPT,
  WRITE_EDITOR_SCRIPT,
} from '../src/background/pta-scripts.ts';

const check = (label, ok) => {
  if (!ok) throw new Error(`✗ ${label}`);
  console.log(`✓ ${label}`);
};

/** 把脚本当成插件注入的那段代码来跑：__args 注入 + AsyncFunction 包裹（脚本里能用 return / await） */
async function runScript(window, source, args) {
  const withArgs = args === undefined ? source : `const __args = ${JSON.stringify(args)};\n${source}`;
  // 必须在页面自己的 realm 里造函数，跟插件注入时一样，脚本才看得到 document / window
  const AsyncFunction = Object.getPrototypeOf(window.eval('(async function () {})')).constructor;
  return await new AsyncFunction(withArgs)();
}

function createPage({ withView = true, body = '' } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>7-1 星期几</title></head><body>${body}</body></html>`, {
    url: 'https://pintia.cn/problem-sets/1/problems/1150901824503297/description',
    // 只有开了 runScripts 才有真正跑在页面 realm 里的 window.eval
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  if (!window.document.execCommand) window.document.execCommand = () => false;

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
        dispatch: ({ changes }) => {
          if (typeof changes.from === 'number') {
            doc = doc.slice(0, changes.from) + (changes.insert ?? '') + doc.slice(changes.to);
          }
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

await pressableJsdom(problemPage);
console.log('\nPTA 三件套校验通过');
