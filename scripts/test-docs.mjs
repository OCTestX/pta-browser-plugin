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
check('斜杠指令有 /new /resolve /what /why 四条（代码）', ['new', 'resolve', 'what', 'why']
  .every((id) => read('src/shared/commands.ts').includes(`id: '${id}'`)));
check('README 记录了斜杠指令', readme.includes('### 斜杠指令') && readme.includes('/resolve'));
check('README 记录了连按三次回车', readme.includes('连按三次回车'));
check('README 记录了选择题题型表', readme.includes('### 题型与选择题'));
check('README 记录了讲解页', readme.includes('/what') && readme.includes('打开讲解页'));
check('README 记录了上下文圆环', readme.includes('上下文进度'));
check('agent 里认得斜杠指令（代码）', read('src/background/agent.ts').includes('parseSlashCommand'));
check('/resolve 会免问放行（代码）', read('src/shared/guardrails.ts').includes('forced?: boolean'));
check('讲解页用 data URL 打开（代码）', read('src/background/explain-pages.ts').includes('data:text/html'));
check('讲解页存进 storage 再开（代码）', read('src/background/explain-pages.ts').includes('EXPLAIN_STORAGE_PREFIX'));
check('粘贴会替换选区而不是追加（代码）', read('src/background/pta-scripts.ts').includes('selection.main'));
check('README 写清了 service worker 缓存这个坑', readme.includes('Service Worker') && readme.includes('Code Cache'));
check('README 写明了讲解页是 data URL 打开的', readme.includes('data:'));

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

console.log('\n文档与代码一致。');
