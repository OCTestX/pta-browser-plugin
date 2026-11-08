// 文档与代码的一致性检查。
//
// README 是 AI 理解这个插件的主要依据之一，写错一句就会让 AI 按错的认知去动手
// （比如以为插件内置 C++ 编译器、以为刷新按钮每秒点一次）。所以把容易漂移的
// 事实钉在这里：代码改了、文档没跟着改，这个测试就红。
//
// 用法：node scripts/test-docs.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const check = (label, ok, detail) => {
  if (!ok) {
    const extra = detail === undefined ? '' : `（实际：${JSON.stringify(detail).slice(0, 300)}）`;
    throw new Error(`✗ ${label}${extra}`);
  }
  console.log(`✓ ${label}`);
};

const readme = read('README.md');
const engineReadme = read('public/engine/README.md');
const tools = read('src/shared/tools.ts');
const settings = read('src/shared/settings.ts');
const ptaScripts = read('src/background/pta-scripts.ts');
const backgroundIndex = read('src/background/index.ts');
const backgroundSettings = read('src/background/settings.ts');
const chatStore = read('src/content/chatStore.ts');
const jsInject = read('src/background/js-inject.ts');
const shortcuts = read('src/content/shortcuts.ts');
const settingsPanel = read('src/content/components/SettingsPanel.tsx');
const agent = read('src/background/agent.ts');
const manifest = JSON.parse(read('manifest/manifest.json'));

/* ---------- 工具清单：README 的工具表不能少也不能多 ---------- */

const toolNames = [
  ...tools.match(/TOOL_NAMES: ToolName\[\] = \[(.*?)\];/s)[1].matchAll(/'([^']+)'/g),
].map((m) => m[1]);
const schemaNames = [...tools.matchAll(/name: '([^']+)',/g)].map((m) => m[1]);

check(
  '工具名清单与工具 schema 一一对应',
  toolNames.length === schemaNames.length && toolNames.every((n) => schemaNames.includes(n)),
  { toolNames: toolNames.length, schemaNames: schemaNames.length },
);
check(`README 声明的工具数量与代码一致（${toolNames.length} 个）`, readme.includes(`${toolNames.length} 个工具`));
for (const name of toolNames) {
  check(`README 的工具表里有 ${name}`, readme.includes(`\`${name}\``));
}

/* ---------- 会漂移的数字 ---------- */

check('刷新按钮是每 5 秒点一次（代码）', ptaScripts.includes('lastReloadAt >= 5000'));
check('README 写的是每 5 秒', readme.includes('每 5 秒点一次'));
check('README 不再写「每秒点一次」', !readme.includes('每秒点一次'));

check('agent 最多 80 轮（代码）', tools.includes('MAX_TOOL_ROUNDS = 80'));
check('README 写的是最多 80 轮', readme.includes('最多 80 轮'));

check('ask 超时 15 分钟（代码）', backgroundIndex.includes('ASK_TIMEOUT_MINUTES = 15'));
check('README 写的是 15 分钟', readme.includes('15 分钟'));

check('js_inject 超时 15 秒（代码）', jsInject.includes('EXECUTE_TIMEOUT_MS = 15_000'));
check('README 写的是 15 秒超时', readme.includes('15 秒超时'));

check('对话记录 60 条 / 单条 8000 字符（代码）', chatStore.includes('MAX_MESSAGES = 60') && chatStore.includes('MAX_CONTENT = 8000'));
check('README 写的是 60 条 / 8000 字符', readme.includes('60 条、单条 8000 字符'));

check('全屏 diff 只保留 8 份（代码）', backgroundIndex.includes('DIFF_KEEP = 8'));
check('README 写的是最近 8 份', readme.includes('最近 8 份'));

check('更新检查缓存 1 小时（代码）', backgroundSettings.includes('CACHE_TTL = 1000 * 60 * 60'));
check('README 写的是 1 小时内缓存一次', readme.includes('1 小时内缓存一次'));

/* ---------- 语言支持：不能吹嘘没实现的能力 ---------- */

check('引擎只编 C（代码）', read('public/engine/engine-core.js').includes('const input = `${name}.c`'));
check('README 不再声称内置 C/C++ 编译器', !readme.includes('C/C++（Clang wasm）'));
check('README 说明没有内置编译器的语言走 PTA', readme.includes('没有内置编译器的语言'));
check('README 说明不内置 JRE', readme.includes('不内置 JRE'));
check('engine README 写明只编 C', engineReadme.includes('## 语言范围：只编 C'));
check('提示词告诉 AI 用 simulate_pta_run 借 PTA 的环境', tools.includes('simulate_pta_run') && tools.includes('不内置 JRE'));
check('提示词提到 read_pta_compile_result', tools.includes('read_pta_compile_result'));

/* ---------- 交互与模式 ---------- */

check('Alt+G 快捷键已实现', shortcuts.includes("event.key.toLowerCase() === 'g'"));
check('Esc 关闭已实现', shortcuts.includes("event.key === 'Escape'"));
check('README 记录了 Alt+G', readme.includes('Alt+G'));
check('README 记录了 Esc 关闭', readme.includes('`Esc`'));

check('视觉模式设置项存在（代码）', settings.includes('vlmMode') && settingsPanel.includes('VLM_MODES'));
check('README 记录了视觉模式', readme.includes('视觉模式'));
check('模型不支持看图时会提醒降级（代码）', agent.includes('不支持看图'));
check('README 写明了降级提醒', readme.includes('不支持看图'));

check('粘贴只在可写作答区接管（代码）', read('src/content/paste.ts').includes('aria-readonly'));
check('README 写明了粘贴的焦点判定', readme.includes('判断依据'));

check('提交后自动刷新是 5 秒（代码）', ptaScripts.includes('lastReloadAt >= 5000'));
check('README 写明了每 5 秒点刷新', readme.includes('每 5 秒点一次'));

/* ---------- 提示词里的规矩 ---------- */

check('提示词要求英文表意的命名', tools.includes('totalScore'));
check('提示词要求不内联用户已提取的函数', tools.includes('内联回调用处'));
check('README 记录了命名规矩', readme.includes('命名用英文表意'));
check('README 记录了不内联规矩', readme.includes('不内联用户已提取的函数'));

/* ---------- 强制用 PTA 运行环境 ---------- */

check('设置里有 forcePtaRun 字段（代码）', settings.includes('forcePtaRun'));
check('默认关闭（代码）', /forcePtaRun:\s*false/.test(settings));
check('设置视图把它传给页面（代码）', read('src/background/settings.ts').includes('forcePtaRun'));
check('agent 里会把内置编译器改走 PTA（代码）', read('src/background/agent.ts').includes('forcePtaRunEnabled'));
check('提示词告诉 AI 这三个工具可能被改道（代码）', tools.includes('已按设置改用 PTA 自己的编译器与运行环境'));
check('本地路径也标明用的是内置编译器（代码）', read('src/background/agent.ts').includes('（用插件内置的编译器）'));
check('README 写明了重新加载扩展这一步', readme.includes('只重建不重新加载扩展'));
check('README 记录了「运行环境」', readme.includes('运行环境：内置编译器 vs PTA'));
check('README 说清了默认走内置', readme.includes('内置（默认）'));
check('README 说明了会覆盖作答区代码', readme.includes('覆盖作答区里的代码'));
check('设置页有「运行环境」两档', settingsPanel.includes('PTA_RUN_MODES'));

/* ---------- 新加的交互与指令 ---------- */

check('斜杠指令清单在代码里（代码）', read('src/shared/commands.ts').includes("id: 'resolve'"));
check('斜杠指令有 /new /resolve /fuck /what /why 五条（代码）', ['new', 'resolve', 'fuck', 'what', 'why']
  .every((id) => read('src/shared/commands.ts').includes(`id: '${id}'`)));
check('README 记录了斜杠指令', readme.includes('### 斜杠指令') && readme.includes('/resolve'));
check('README 记录了赶题模式 /fuck', readme.includes('/fuck'));
check('README 记录了连按三次回车', readme.includes('连按三次回车'));
check('README 记录了选择题题型表', readme.includes('### 题型与选择题'));
check('README 记录了讲解页', readme.includes('/what') && readme.includes('打开讲解页'));
check('README 记录了上下文圆环', readme.includes('上下文进度'));
check('agent 里认得斜杠指令（代码）', read('src/background/agent.ts').includes('parseSlashCommand'));
check('/resolve 会免问放行（代码）', read('src/shared/guardrails.ts').includes('forced?: boolean'));
check('讲解页存进 storage 再开（代码）', read('src/background/explain-pages.ts').includes('EXPLAIN_STORAGE_PREFIX'));
check('讲解页开在 PTA 的固定路径上（代码）', read('src/shared/explain-html.ts').includes("EXPLAIN_PAGE_PATH = '/pta-assistant/explain'"));
check('讲解页放在沙箱 iframe 里（代码）', read('src/content/explain-mode.ts').includes("setAttribute('sandbox'"));
check(
  '沙箱里没有 allow-same-origin（代码）',
  !/setAttribute\('sandbox',\s*'[^']*allow-same-origin/.test(read('src/content/explain-mode.ts')),
);
check('README 写明了讲解页开在 PTA 的固定地址', readme.includes('pta-assistant/explain'));
check('README 写明了扩展页跑不了模型脚本的原因', readme.includes('unsafe-inline'));
check('粘贴会替换选区而不是追加（代码）', read('src/background/pta-scripts.ts').includes('selection.main'));
check('README 写清了 service worker 缓存这个坑', readme.includes('Service Worker') && readme.includes('Code Cache'));

/* ---------- 赶题模式（/fuck） ---------- */

check('赶题模式会免问放行（代码）', read('src/shared/commands.ts').includes('commandForcesWrite'));
check('赶题模式在 agent 里被认出来（代码）', read('src/background/agent.ts').includes("command?.id === 'fuck'"));
check('赶题模式会替用户回答提问（代码）', read('src/background/agent.ts').includes('pickAutoAnswer'));
check('赶题模式会跳过已提交的题（代码）', ptaScripts.includes('PROBLEM_SUBMITTED'));
check('赶题模式会切换题型（代码）', ptaScripts.includes('typeGroups'));
check('赶题模式的欠账记在 todo.txt 里', read('todo.txt').includes('/fuck 赶题模式：进度与欠账'));
check('README 写明赶题模式还在调', readme.includes('这个模式还在调'));
check('README 写明赶题模式的欠账在哪', readme.includes('todo.txt'));
check('赶题模式放开了工具轮数（代码）', read('src/background/agent.ts').includes('FUCK_MAX_TOOL_ROUNDS'));
check('有 next_problem 这个工具（代码）', tools.includes('next_problem'));
check('README 写了赶题模式会切下一题', readme.includes('next_problem'));

/* ---------- 指令菜单：Tab 补全与底部提示 ---------- */

const composer = read('src/content/components/Composer.tsx');
check('指令菜单支持 Tab 补全（代码）', composer.includes("event.key === 'Tab'") && composer.includes('completeCommand'));
check('README 写了 Tab 补全', readme.includes('Tab 补全'));
check('底部不再重复发送/换行提示（代码）', !composer.includes('Enter 发送 · Shift + Enter 换行'));
check('快捷键挪进了输入框的 title（代码）', composer.includes('title="Enter 发送'));
check('输入框的 title 里写了三次回车开新会话', composer.includes('连按三次回车'));

/* ---------- 上下文长度：不靠猜 ---------- */

check('有查上下文长度的模块（代码）', read('src/shared/model-context.ts').includes('extractContextWindowFromModels'));
check('后台会联网查上下文长度（代码）', read('src/background/model-context.ts').includes('models.dev'));
check('清单放行了 models.dev', JSON.stringify(manifest.host_permissions).includes('models.dev'));
check('设置里存了查到的上下文长度（代码）', read('src/background/settings.ts').includes('contextWindow'));
check('圆环用的是查到的值（代码）', read('src/content/App.tsx').includes('pickContextWindow'));

/* ---------- read_problem 的样例框 ---------- */

check('题面摊平时整块跳过样例框（代码）', ptaScripts.includes('data-code'));
check('适配笔记写了样例框的坑', read('docs/pta-page-notes.md').includes('样例框'));

/* ---------- 清单与版本 ---------- */

check('清单版本与 README 更新记录一致', readme.includes(`| v${manifest.version} |`), { manifest: manifest.version });
check('README 声明了本地编译器的三种语言', readme.includes('`compile_and_run_c`') && readme.includes('`compile_and_run_python`') && readme.includes('`compile_and_run_js`'));
check('README 提到多标签页隔离', readme.includes('多个标签页同时用'));
check('README 提到 API Key 防密码管理器', readme.includes('data-lpignore'));

/* ---------- PTA 适配笔记 ---------- */

const notes = read('docs/pta-page-notes.md');
// 顶部那段「注意版本」的提示是引用块，里面会故意点名旧项目的路径，
// 所以检查正文时把它（以及其他引用块）排除掉，只看真正在讲实现的段落
const notesBody = notes
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('>'))
  .join('\n');
check('README 链到了适配笔记', readme.includes('docs/pta-page-notes.md'));
check(
  '适配笔记正文不再引用旧项目的架构',
  !/PtaDriver\.kt|PtaSource\.kt|ProblemTextParser|solve\.json|BrowserSession\.kt/.test(notesBody),
);
check('适配笔记说明了旧路径在本仓库不存在', notes.includes('不存在'));
check('适配笔记提到的文件都真实存在', [
  'src/background/pta-scripts.ts',
  'src/background/typist.ts',
  'src/background/js-inject.ts',
  'src/background/input-methods.ts',
  'src/background/debugger-input.ts',
  'src/content/paste.ts',
].every((rel) => notes.includes(rel)));
check('适配笔记里的刷新间隔与代码一致', notes.includes('每 5 秒点一次') && ptaScripts.includes('lastReloadAt >= 5000'));
check('适配笔记里的题面容器选择器与代码一致', notes.includes('.rendered-markdown') && ptaScripts.includes("'.rendered-markdown'"));
check('适配笔记里的判题词表顺序说明存在', notes.includes('JUDGE_WORDS') && notes.includes('顺序即优先级'));
check('适配笔记里的编辑器选择器与代码一致', notes.includes('#pta-answer-editor') && ptaScripts.includes('#pta-answer-editor'));
check('适配笔记提到 MAIN world 注入', notes.includes("world: 'MAIN'") && read('src/background/js-inject.ts').includes("'MAIN'"));

/* ---------- 作答区增强（v4.2 / v5.0） ---------- */

const agentSource = read('src/background/editor-agent.ts');
const editorAssist = read('src/content/editor-assist.ts');
const protocolSource = read('src/shared/editor-assist-protocol.ts');
const bracketsSource = read('src/shared/code-brackets.ts');
const engineShared = read('public/engine/shared.js');
const engineCore = read('public/engine/engine-core.js');
// checkOnEngine 是文件最后一个导出，从它切到结尾就是它的函数体
const checkOnEngineBody = engineCore.slice(engineCore.indexOf('export async function checkOnEngine'));

check('有括号层数模块（代码）', bracketsSource.includes('export function bracketDepths'));
check('括号层数对颜色表取模（代码）', bracketsSource.includes('RAINBOW_COLORS.length'));
check('有跨世界消息契约（代码）', protocolSource.includes('ASSIST_MESSAGE_KEY') && protocolSource.includes('isAssistMessage'));
check('页面 agent 由后台按 MAIN world 注入（代码）', backgroundIndex.includes('injectScript(tabId, EDITOR_AGENT_SOURCE'));
check('隔离世界算括号层数（代码）', editorAssist.includes('bracketDepths(message.text)'));
check('实时检查走 editor/check（代码）', editorAssist.includes("type: 'editor/check'"));
check('README 记录了作答区增强', readme.includes('### 作答区增强'));
check('README 记录了整理代码按钮', readme.includes('整理代码'));
check('README 记录了彩虹括号', readme.includes('彩虹括号'));
check('README 记录了标准库函数注释', readme.includes('标准库函数注释'));
check('README 说明了实时检查只支持 C', readme.includes('内置编译器只支持 C'));
check('README 写明了只做语法检查、不运行代码', readme.includes('只做语法检查'));
check('README 写明了整理不会覆盖新改动', readme.includes('这次整理直接取消'));
check('README 写明工具栏在底部状态栏（不挡代码）', readme.includes('底部状态栏'));
check('适配笔记写明工具栏按几何定位', notes.includes('紧贴在代码框下沿'));
check('工具栏按结构找底部状态栏（代码）', agentSource.includes('findBottomBar') && agentSource.includes('barFitsEditor'));
check('工具栏跟着尺寸变化重排（代码）', agentSource.includes('ResizeObserver'));
check('染色逐行定位，不逐括号查坐标（代码）', agentSource.includes('posAtDOM') && !agentSource.includes('state.marks.forEach((depth, at) => {'));
check('括号上色同时加粗（代码）', agentSource.includes("fontWeight = '600'"));
check('按子节点逐字符累加下标（代码）', agentSource.includes('line.childNodes') && !agentSource.includes('for (const span of line.querySelectorAll(\'span\'))'));
check('监听编辑器 DOM 变动同帧补色（代码）', agentSource.includes('paintObserver') && agentSource.includes('characterData: true'));
check('适配笔记记录了 CM6 清内联样式这件事', notes.includes('CM6 会清掉我们写的内联样式'));
check('只有 error 画波浪线（代码）', agentSource.includes("if (box.severity !== 'error') continue;"));
check('行尾报错往回退到非空白字符（代码）', read('src/background/compile.ts').includes("/[\\s]/.test(source[start])"));
check('README 写明只有 error 画波浪线', readme.includes('只有 error 画波浪线'));
check('README 记录了运算符补空格规则', readme.includes('`7*2` → `7 * 2`'));
check('README 记录了无花括号控制体缩进', readme.includes('无花括号的 `if`/`for`/`while` 体缩进一层'));
check('适配笔记记录了展开 Test Case 后的第二个编辑器', notes.includes('测试输入框'));
check('适配笔记记录了逐行定位的染色性能问题', notes.includes('posAtDOM') && notes.includes('一动就掉色'));
check('引擎提供只检查的编译路径（代码）', engineShared.includes("'-fsyntax-only'"));
check('只检查不链接不运行（代码）', checkOnEngineBody.includes("input: 'check.c'") && !checkOnEngineBody.includes('api.link('));
check('语法检查不计入引擎重建计数（代码）', !checkOnEngineBody.includes('runs += 1'));
check('适配笔记记录了 MAIN world 与 postMessage', notes.includes('postMessage') && notes.includes('cmTile.view'));
check('适配笔记记录了 clang 列号按字节算', notes.includes('UTF-8 字节'));
check('适配笔记记录了 fsyntax-only', notes.includes('-fsyntax-only'));
check('编辑器增强的共享逻辑有单测', read('package.json').includes('test-editor-assist.mjs'));

console.log('\n文档与代码一致。');
