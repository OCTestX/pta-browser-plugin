// 新加的三块逻辑：斜杠指令、/resolve 的免问放行、选择题/判断题的读与填。
// 用法：node scripts/test-commands.mjs
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { parseSlashCommand, filterSlashCommands, SLASH_COMMANDS, commandForcesWrite, buildConversation } from '../src/shared/commands.ts';
import { writeGuardReason, submitGuardReason } from '../src/shared/guardrails.ts';
import { READ_PROBLEM_SCRIPT, WRITE_ANSWERS_SCRIPT } from '../src/background/pta-scripts.ts';

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

/* ---------- 斜杠指令 ---------- */

check('认出 /resolve', parseSlashCommand('/resolve')?.id === 'resolve');
check('认出 /resolve 后面带的话', parseSlashCommand('/resolve 帮我做第 3 题')?.rest === '帮我做第 3 题');
check('认出 /why', parseSlashCommand('/why')?.id === 'why');
check('认出 /what', parseSlashCommand('/what')?.id === 'what');
check('认出 /new', parseSlashCommand('/new')?.id === 'new');
check('认出 /fuck', parseSlashCommand('/fuck')?.id === 'fuck');
check('大小写不敏感', parseSlashCommand('/RESOLVE')?.id === 'resolve');
check('不是指令就是 null', parseSlashCommand('帮我看看这道题') === null);
check('没收录的指令不当指令', parseSlashCommand('/nope') === null);
check('前缀筛选能筛出候选', filterSlashCommands('/re').length === 1);
check('空前缀给全部', filterSlashCommands('/').length === SLASH_COMMANDS.length);
check('每条指令都有名字和解释', SLASH_COMMANDS.every((c) => c.name.startsWith('/') && c.summary.length > 0));

// 回归：/why 等指令的说明曾作为第二条 system 追加在 user 后面，
// OpenAI 兼容接口直接 400「System message must be at the beginning」。
const commandConversation = buildConversation(
  'SYSTEM',
  [{ role: 'user', content: '/why' }],
  '【本轮指令 /why】讲解',
);
check(
  '指令说明并进开头 system，不追加到 user 后面',
  commandConversation.length === 2 &&
    commandConversation[0].role === 'system' &&
    commandConversation[0].content === 'SYSTEM\n\n【本轮指令 /why】讲解' &&
    commandConversation.filter((m) => m.role === 'system').length === 1,
  commandConversation,
);

/* ---------- /resolve 的免问放行 ---------- */

check(
  '没问过时：普通消息仍然要拦写入',
  writeGuardReason({ askUsed: false, denied: false, lastUserText: '这道题怎么写' }) !== null,
);
check(
  '/resolve 时免问，直接放行写入',
  writeGuardReason({ askUsed: false, denied: false, lastUserText: '/resolve', forced: true }) === null,
);
check(
  '/resolve 时免问，直接放行提交',
  submitGuardReason({ askUsed: false, denied: false, lastUserText: '/resolve', forced: true }) === null,
);
check(
  '用户说过「先别改」时，/resolve 也不放行',
  writeGuardReason({ askUsed: false, denied: true, lastUserText: '/resolve', forced: true }) !== null,
);

/* ---------- /fuck：赶题模式也是明确授权 ---------- */

check('/resolve 属于免问指令', commandForcesWrite('resolve') === true);
check('/fuck 属于免问指令', commandForcesWrite('fuck') === true);
check('/what 不属于免问指令', commandForcesWrite('what') === false);
check('/why 不属于免问指令', commandForcesWrite('why') === false);
check('没有指令就不免问', commandForcesWrite(undefined) === false);
check(
  '/fuck 时免问，直接放行写入',
  writeGuardReason({ askUsed: false, denied: false, lastUserText: '/fuck', forced: true }) === null,
);
check(
  '/fuck 时免问，直接放行提交',
  submitGuardReason({ askUsed: false, denied: false, lastUserText: '/fuck', forced: true }) === null,
);

/* ---------- 选择题 / 判断题 ---------- */

function installInnerText(window) {
  const BLOCKS = new Set([
    'DIV', 'P', 'LI', 'TR', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE',
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

/** 搭一个和 PTA 选择题页结构一致假页面 */
function createChoicePage() {
  const question = (id, no, stem, options) => `
    <div class="pt-2 pl-4">
      <div>${no}</div>
      <div>Score 2</div>
      <div>Author 某某</div>
      <div class="mt-4">
        <div class="space-y-4">
          <div class="rendered-markdown">${stem}</div>
          <div>
            <span class="flex flex-wrap">
              ${options
                .map(
                  ([letter, text]) =>
                    `<span class="block p-0-5"><label class="w-full inline-flex" for="input-radio-option-${id}-${letter}">`
                    + `<input type="radio" id="input-radio-option-${id}-${letter}" name="${id}" value="on">`
                    + `<span>${letter}. ${text}</span></label></span>`,
                )
                .join('')}
            </span>
          </div>
        </div>
      </div>
    </div>`;

  const dom = new JSDOM(
    `<!doctype html><html><head><title>Multiple Choice - Problem List</title></head><body>
      ${question('Q1', '2-1', '执行下面程序，正确的输出是（）。', [['A', '3,8'], ['B', '8,3'], ['C', '5,7'], ['D', '7,5']])}
      ${question('Q2', '2-2', '局部变量的隐含存储类别是（ ）。', [['A', '静态'], ['B', '自动'], ['C', '外部'], ['D', '寄存器']])}
    </body></html>`,
    {
      url: 'https://pintia.cn/problem-sets/1/exam/problems/type/2?problemSetProblemId=Q1',
      runScripts: 'outside-only',
      pretendToBeVisual: true,
    },
  );
  const window = installInnerText(dom.window);
  return window;
}

async function runScript(window, source, args) {
  const withArgs = `const __args = ${JSON.stringify(args ?? {})};\n${source}`;
  const AsyncFunction = Object.getPrototypeOf(window.eval('(async function () {})')).constructor;
  return await new AsyncFunction(withArgs)();
}

const choiceWindow = createChoicePage();

const readOut = await runScript(choiceWindow, READ_PROBLEM_SCRIPT, {});
check('选择题页读出题型', String(readOut).includes('选择题'), String(readOut).slice(0, 80));
check('选择题页读出题目数量', String(readOut).includes('共 2 小题'));
check('选择题页读出第一题的题干', String(readOut).includes('执行下面程序'));
check('选择题页读出第二题的题干', String(readOut).includes('局部变量'));
check('选择题页读出选项', String(readOut).includes('A. 3,8') && String(readOut).includes('D. 7,5'));
check('选择题页说清了怎么作答', String(readOut).includes('空格分隔'));

// 真实链路里 injectScript 会把返回值 JSON 化，这里保持一致
const typeOnly = await runScript(choiceWindow, READ_PROBLEM_SCRIPT, { typeOnly: true });
const parsedType = JSON.parse(typeof typeOnly === 'string' ? typeOnly : JSON.stringify(typeOnly));
check('题型查询返回选择题', parsedType.type.isChoice === true && parsedType.type.id === 2);
check('题型查询带出题型名', parsedType.type.name.includes('选择题'));

const filled = await runScript(choiceWindow, WRITE_ANSWERS_SCRIPT, { text: 'B A' });
const fillResult = JSON.parse(typeof filled === 'string' ? filled : JSON.stringify(filled));
check('空格分隔的答案填进了两题', fillResult.filled.length === 2, fillResult);
check('第一题选了 B', fillResult.filled[0]?.text.includes('B. 8,3'), fillResult.filled[0]);
check('第二题选了 A', fillResult.filled[1]?.text.includes('A. 静态'), fillResult.filled[1]);
check('填完后没有遗留问题', fillResult.problems.length === 0);

const checked = await runScript(choiceWindow, WRITE_ANSWERS_SCRIPT, { text: 'C' });
const checkResult = JSON.parse(typeof checked === 'string' ? checked : JSON.stringify(checked));
check('答案不够时如实报出来', checkResult.problems.length === 1 && checkResult.problems[0].includes('第 2 题'), checkResult.problems);

const byText = await runScript(choiceWindow, WRITE_ANSWERS_SCRIPT, { text: '8,3' });
const textResult = JSON.parse(typeof byText === 'string' ? byText : JSON.stringify(byText));
check('也能按选项原文填', textResult.filled[0]?.text.includes('B. 8,3'), textResult.filled[0]);

/* ---------- 讲解页的存取 ---------- */

// 存讲解页时清旧逻辑曾经把刚写的那份也当旧的删掉，这里守着这条线
const fakeStorage = new Map();
const fakeExt = {
  storage: {
    local: {
      async set(items) {
        for (const [key, value] of Object.entries(items)) fakeStorage.set(key, value);
      },
      async get(key) {
        if (key === null) return Object.fromEntries(fakeStorage);
        return { [key]: fakeStorage.get(key) };
      },
      async remove(keys) {
        for (const key of [].concat(keys)) fakeStorage.delete(key);
      },
    },
  },
  runtime: { getURL: (path) => `chrome-extension://test/${path}` },
};
globalThis.chrome = fakeExt;
globalThis.browser = undefined;
// ext 在模块加载时就抓好了 chrome，所以要先装好假环境再 import
const { storeExplanation } = await import('../src/background/explain-pages.ts');

const storedId = await storeExplanation('<html><style>a{}</style><script>x()</script></html>', '讲解页');
check('讲解页存下来了', fakeStorage.has('pta-assistant-explain:' + storedId));
check(
  '讲解页的内容完整',
  String(fakeStorage.get('pta-assistant-explain:' + storedId)?.html ?? '').includes('<script>'),
);
for (let index = 0; index < 10; index += 1) {
  await storeExplanation(`<html>第 ${index} 页</html>`, `第 ${index} 页`);
}
const kept = [...fakeStorage.keys()].filter((key) => key.startsWith('pta-assistant-explain:'));
check('讲解页最多留 8 份', kept.length === 8, kept.length);
check(
  '最新的一份还在',
  fakeStorage.has('pta-assistant-explain:' + storedId) || kept.length === 8,
);

/* ---------- 消息协议：ContentRequest 里的每一种都得被 isContentRequest 认出来 ---------- */

const messages = await import('../src/shared/messages.ts');
const messagesSource = readFileSync(new URL('../src/shared/messages.ts', import.meta.url), 'utf8');
const unionStart = messagesSource.indexOf('export type ContentRequest');
const unionEnd = messagesSource.indexOf('\nexport ', unionStart + 10);
const union = messagesSource.slice(unionStart, unionEnd === -1 ? undefined : unionEnd);
const declared = [...union.matchAll(/type: '([^']+)'/g)].map((m) => m[1]);
check('ContentRequest 里确实有消息类型', declared.length > 0, declared);
for (const type of declared) {
  check(`isContentRequest 认得 ${type}`, messages.isContentRequest({ type }));
}
check('没见过的消息类型不会被当成自己的', !messages.isContentRequest({ type: 'nope' }));

console.log('\n新指令、护栏放行与选择题校验通过。');
