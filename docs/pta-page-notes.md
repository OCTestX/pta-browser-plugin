# PTA 页面适配笔记

这份笔记记录插件跟 PTA（pintia.cn）页面打交道时的实测结论：怎么找到题面、怎么认出作答区、怎么逐字敲代码、怎么判题、怎么借 PTA 的编译器。

每条结论都对应本仓库的具体文件与函数，改代码前先对一眼。

> **注意版本**：这些笔记最早写在一个 Kotlin + Playwright 的桌面端项目里，那边的文件路径（`core/…/pta/PtaDriver.kt`、`resources/…/solve.json` 等）在本仓库**不存在**，照着找会一头雾水。下面只保留仍然成立的页面事实，代码位置全部换成本仓库的。

## 0. 三层分工：谁在哪一侧跑

| 层 | 位置 | 干什么 | 代码 |
|---|---|---|---|
| background | MV3 service worker | agent loop、工具调度、模型请求 | `src/background/agent.ts` |
| content script | 隔离世界（`<all_urls>`） | 悬浮窗、粘贴代理、快捷键 | `src/content/index.tsx` |
| 页面主世界 | `world: 'MAIN'` | 抠题面、读编辑器、点提交、盯判题 | `src/background/pta-scripts.ts` |

页面脚本必须跑在 **MAIN world**：PTA 自己的 CodeMirror 实例只挂在页面对象上，隔离世界拿不到。注入逻辑在 `src/background/js-inject.ts`——先试 `MAIN`，拿不到再退回 `ISOLATED`。

## 1. 定位题面

`READ_PROBLEM_SCRIPT`（`src/background/pta-scripts.ts`）分三步：

**一、按类名找容器。** 优先级依次是：

```
.rendered-markdown
.problem-content / .problem-statement / .pt12-problem-content / .problem-description
[class*=problem-statement] / [class*=statement] / [class*=problem-content]
```

用**摊平后**的长度（`flattenStatement`）比大小，不看 `innerText`：`innerText` 会把 KaTeX 的排版碎片算进去，长度不可靠。

**二、类名对不上时按小标题定位。** 扫 `div, section, article, main, form`，取同时出现 ≥2 个小标题标记（`题目描述 / 输入格式 / 输出格式 / 样例输入 …`）的**最小**容器。只在第一步完全没命中时才走这一步，否则会把已经找好的 `.rendered-markdown` 换掉。

**三、都找不到就退到整页正文**，并从第一个小标题开始截，把导航和侧栏丢掉。

最后滤掉一批纯 UI 文案行（`Toggle Sidebar`、`上一题`、`复制内容`…）。**这里不能按「纯数字行」过滤**——样例输出经常就是一行数字（比如 `7`），按数字滤会把样例答案一起删掉。

公式会还原成 LaTeX（`$...$`），图片公式附上说明与链接。

**语言识别**在 `LANGUAGE_SCRIPT`：读作答区下拉框当前选中的语言。认不出的处理原则是**如实说认不出**，不要猜——`guessLanguage`（`src/background/agent.ts`）只在页面完全没给信息时按代码长相兜底，而且宁可当 C 也不要把 Python 当 C。

### 题面里的样例框：整块都要跳过，不能只跳 `.cm-content`

「输入样例 / 输出样例」是**只读的 CodeMirror**。摊平题面时如果只跳过 `.cm-content` 这一个节点，**它的兄弟节点会被当成正文**：行号槽（gutter）、工具条（「复制内容 / 格式 / 全屏 / 收起」）、折叠标记 `▸` 全都漏进题面里。

实测（题目「7-12 杨辉三角形」`problemSetProblemId=2092326321552957459`）：

- 样例框外层是 `<div data-code="" data-lang="in">`（`data-lang` 为 `in` / `out`），里面是 `.codeEditor_* > .cm-editor`，再里面才是 `.cm-content`。
- 行号槽的内容是 `["9", "1", "2", "▸", ""]`：`9` 是跳转行号的输入框，`1`/`2` 是行号，`▸` 是折叠标记。
- 样例的**真实内容**在 `.cm-line` 里（这个题输入样例是 `5`）。

漏出来的噪音会和另一段「样例」小节打架：题面里写「输入样例1：9 1 2 ▸」，样例小节里写「样例 1 输入：5」。模型看到前后矛盾就会怀疑 `read_problem` 坏了，改用 `js_inject` 自己读——这就是那道题上「read_problem 有问题」的真正原因。

处理办法：**认整个样例框组件**（`div[data-code]`，兼容老页面的 `.cm-editor` 里包着只读 `.cm-content`），把它换成 `[输入样例]` / `[输出样例]` 加**真实内容**（`.cm-line` 的 textContent），不要把行号槽当正文。

## 1.1 题目列表与「切下一题」

考试页侧栏的题目列表是普通 `<a>`：

```
<a href="/problem-sets/<setId>/exam/problems/type/<type>?problemSetProblemId=<pid>">题号</a>
```

- **代码块的 `data-lang` 是语言名，不是样例方向**：真机 6-1 里「函数接口定义 / 裁判测试程序样例」的
  `data-code` 块写的是 `data-lang="c++"`，只有真正的样例才是 `in` / `out`。抠样例时只能把
  `in` / `out` 的块当样例；没有标签的块是题面代码，配对进来会变成假样例。
- 同一份列表里可能混着**多个题型**（type/1 判断、type/2 选择、type/6 代码填空、type/7 编程…），按 DOM 顺序排列 → 找「下一题」要按 **DOM 顺序**，不能按 id 排序。
- 当前题的 id 从 `location.href` 的 `problemSetProblemId=` 取。
- **点它是前端路由跳转，不会整页刷新**：实测跳转前设的 `window.__marker` 还在，标题变了，插件悬浮窗的宿主元素也还在。所以同一段页面脚本里点完链接可以继续等页面换好，插件的对话上下文也不会断。
- 题型在地址里：`/problems/type/N`，1=判断、2=选择、6=代码填空、7=编程、9=多文件。
- **题目状态画在链接里的一个小方块上**（真实考试页，2026-11 实测）：
  `problemStatusRect_xxx PROBLEM_ACCEPTED_yyy` / `PROBLEM_NO_ANSWER_yyy`；
  老假设里的 `PROBLEM_SUBMITTED` 不一定会出现。`PROBLEM_NO_ANSWER` 是没做，其余 `PROBLEM_*` 都算已作答。
  判断时只看这个链接自己的子树、以及祖先**自己身上**的类——网格容器包含所有题，
  扫它的子树会把别的题的 `PROBLEM_ACCEPTED` 算到每一道题头上。
- **题目 ID 在 `problemSetProblemId` 查询参数里**，路径里 `/problem-sets/<setId>/` 那个长数字是题目集 ID；
  按「路径里第一个长数字」取会把整份题单记成同一道题。
- 同一题型做完后要切题型：点带「已答/总数」的分组链接会先落到该题型的列表页（地址里没有 `problemSetProblemId`），
  侧栏网格随后才换成新题型的。**地址变了不等于网格换好了**，要等网格里出现新题型的题目链接再点第一道未提交的题。

## 2. 定位作答区（编辑器）

核心选择器就两个：`.cm-content` 与 `[contenteditable="true"]`，配合**可写性过滤**，取**文本最长**的那个（`findEditorElement`，`pta-scripts.ts`）：

```js
const isEditableElement = (node) => {
  if (node.getAttribute('aria-readonly') === 'true') return false;   // 题面里的样例框
  const attr = node.getAttribute('contenteditable');
  if (attr === 'false') return false;
  return node.isContentEditable || attr === '' || attr === 'true' || attr === 'plaintext-only';
};
```

两个细节都是踩坑换来的：

- **只判 `contenteditable` 不够**：题面里的样例输入框也是 CodeMirror，但它是 `contenteditable="false"` + `aria-readonly="true"`，两条都得排除。
- **取最长的那个**：页面上常同时存在「上一题的残留编辑器」「题面样例框」「真正的作答区」，按文本长度筛最稳。

**编辑器实例**不在公开 API 上，只能顺着 DOM 摸：PTA 把它挂在 `#pta-answer-editor` 的 `cmTile.view` 上。`collectEditorViews` 从 `#pta-answer-editor / .cm-editor / .cm-content / [contenteditable="true"]` 出发往上找，形如 `state.doc.toString` 的对象就是编辑器视图（`looksLikeEditorView`）。有实例就整段读写，没有就退回 DOM 读 `.cm-line`。

**写入**走 `src/background/input-methods.ts`：整段写入是编辑器事务（不触发页面事件），逐字输入是 `src/background/typist.ts` 的算法，真按键由 `src/background/debugger-input.ts` 用 `chrome.debugger` 发 CDP 事件（trusted），拿不到调试器就退回模拟事件并在结果里说明。

## 2.1 作答区增强：为什么非要走 MAIN world

「整理代码 / 彩虹括号 / 实时检查 / 函数注释」这组功能（v4.2 起）的代码位置：

| 层 | 文件 | 干什么 |
|---|---|---|
| MAIN world | `src/background/editor-agent.ts`（一段字符串，由 `injectScript` 注入） | 找编辑器、读写正文、算字符坐标、画浮层、命中检测 |
| 隔离世界 | `src/content/editor-assist.ts` | 让后台装 agent、算括号层数、整理代码、问后台要诊断 |
| background | `src/background/index.ts` + `src/background/compile.ts` | 注入 agent、跑内置编译器的 `-fsyntax-only` |
| 共享层 | `src/shared/code-format.ts` / `code-brackets.ts` / `code-diagnostics.ts` / `c-library-docs.ts` | 纯逻辑，Node 里单测（`scripts/test-editor-assist.mjs`） |

**为什么不能让 content script 直接做**：实测（Chrome 150）在隔离世界里读 `.cm-content.cmTile` 是 `undefined`，同一个节点在 MAIN world 里才拿得到 `cmTile.view`（`EditorView`）。读全文、`dispatch` 写回、`coordsAtPos` / `domAtPos` 算坐标，全都只有主世界能做。

**跨世界通信**：`window.postMessage` 双向都能送达（实测）。载荷上带一个每次安装都重新生成的随机 token（`__ptaEditorAssist` 字段），页面自己的消息、别的脚本伪造的消息都被 `isAssistMessage` 筛掉。页面脚本拿不到 `chrome.runtime`，所以「编译检查」这一跳是 主世界 → 隔离世界 → background 转发的。

**彩虹括号不改 DOM 结构**：实测 CM6 把每个括号都渲染成**独立的单字符 span**（`tok-punctuation`），所以直接改这些 span 的 `color` 就够，不盖字形遮罩——不遮挡文本、不影响选区、不用复制字体度量。定位用 `view.domAtPos(offset)` 反查 DOM，并做两道校验：取到的字符必须就是那个括号、span 的 `textContent` 长度必须是 1；对不上就跳过这一处（宁可不上色，也不要染到邻居）。CM6 虚拟化滚动时会重建 span，所以 `scroll` / `resize` 之后按当前文档重刷一遍。

**浮层位置**：实测两个地方都试过，最后落在**代码框底部状态栏**。

- 头部行（语言选择器 + PTA 自己的 ⚙/帮助/键盘/调试/全屏图标）在 993~1043px 视口下几乎占满（空隙只有 8/17/28px），插按钮进去会把 PTA 的按钮挤走；
- 浮在代码框右上角虽然不挡页面控件，但**会压住第一行代码**，实际用起来碍事；
- 底部状态栏（左端是「Test Case」按钮）右侧实测是一大片空白：993px 视口下按钮占 [574,662]，`?` 和折叠箭头在 922 以后，中间 260px 随便用。工具栏就摆在这里，垂直居中。

定位不按类名找（PTA 的类名带哈希，如 `CodingProblemAnswerForm_JoDvx`，会变），按几何找：**紧贴在代码框下沿、高度 24~64px、宽度不小于代码框 60% 的那条 div**。找到后从「Test Case」按钮右边 +12px 开始摆，并夹在右端图标左边。整条状态栏都不在时（面板收起之类）退到代码框右下角内部。

整个工具栏是挂在 `body` 上的 `position: fixed` 浮层（`pointer-events: none`，只有按钮本身可点），`document.body` 而不是 React 树里的节点，换题重渲染也删不掉它。

**展开「Test Case」之后页面会多出第二个可写编辑器**：测试输入框也是 CodeMirror（`contenteditable="true"`，`cmTile.view` 一样能拿到）。如果还按「文本最长的那个」挑编辑器，测试输入一长就会绑错对象，工具栏跑去跟着测试输入框。`findEditor`（`editor-agent.ts`）现在按「在不在 `.CodingProblemAnswerForm` 里 → 有没有实际尺寸 → 文本长度」打分。

**染色性能：逐行定位，不要逐括号查坐标**。老实现给每个括号调一次 `view.domAtPos(at)`（布局查询），一屏几十个括号就是几十次，滚动、光标移动引起重渲染时还各来一轮——表现就是「染色慢、一动就掉色」。现在改成：对每个 `.cm-line` 调一次 `view.posAtDOM(line, 0)` 拿到行首下标，再**按子节点逐字符**累加（不是只数 span——`=` `;` `,` 这类标点是裸文本节点，只数 span 会让一行之后的所有下标整体偏移，颜色直接对不上），`Map` 查层数，整屏只有 ≤50 次查询。span 上盖「本轮代号」，只有没被盖到的才恢复默认样式，所以不需要「先全清再全刷」，也就不会闪。

**CM6 会清掉我们写的内联样式**：光标一动、行被重画时，CM6 会重写这一行的 span（有时是原地把 `style` 清空），上一轮上的颜色就没了。所以除了定时巡检，还要在 `view.contentDOM` 上挂 `MutationObserver`（`childList` + `subtree` + `style`/`class` 属性），一有变动就在**同一帧**（`requestAnimationFrame`）重刷；写样式前先比一下旧值，值没变就不写，否则自己的写入又会触发观察器，来回自激。只靠 500ms 巡检的表现就是「光标一动颜色消失，过一会才慢慢回来」。

**状态栏是作答表单的兄弟节点，不是子节点**：`.CodingProblemAnswerForm` 的父节点里是 `[表单, 状态栏]`。按几何在整片 `div` 里扫「高度 24~64、贴着代码框下沿」的节点会撞上展开后的测试用例面板（连代码行 `.cm-line` 都符合这两个条件），所以找法改成**先看 `form.nextElementSibling`**，几何只做退路，并且每轮都校验「找到的那条确实贴着代码框下沿」，不合格就不放。

**跟随重排用 `ResizeObserver` 而不是定时巡检**：展开/收起测试用例面板时页面不滚、窗口不变，只有代码框变矮，`scroll`/`resize` 事件一个都不来；靠 500ms 巡检会有肉眼可见的滞后。现在观察 `.cm-editor` 和状态栏，尺寸一变就 `requestAnimationFrame` 里重排一次。

**SPA 换题**：换题是前端路由，注入的 agent 跨题存活，但编辑器 DOM 会被换掉。agent 每 500ms 比对一次当前可写 `.cm-content`，变了就重新绑定（不靠 MutationObserver 监听整个页面，代价太大）。

**clang 把行尾的错指在换行符上**：`printf("")` 缺分号时，诊断给的行列落在**行尾**（换行符那个位置）。直接当字符下标用，区间会跨到下一行，页面「跨行只画第一行」的判断就把整条诊断吃掉——现象是「底部报了错，代码里一条波浪线都没有」。`diagnosticRange`（`compile.ts`）现在会先把落点往回退到本行最后一个非空白字符。

**只有 error 画波浪线**：clang 的 warning（`-Wimplicit-function-declaration` 之类）在初学者的代码里密度很高，满屏波浪线会把真正的 error 盖住；warning 只进状态栏计数。

**clang 的列号按 UTF-8 字节算**：同一行前面插一个 `/*中*/`（5 字符 / 7 字节），列号从 20 变成 27。所以 `offsetOfPosition` 必须先把行内字节序列切到第 `column-1` 个字节，再数回字符数。含中文注释的行上差这一步，波浪线就会往右飘。

**检查用 `-fsyntax-only`**：单次约 30–45ms（`compile` 约 38ms 且要产出 `.o`）。这条路不产目标文件、不链接、不运行。两个必须注意的引擎细节：

- **不能计入 `MAX_RUNS_PER_ENGINE`**（100 次就重建引擎、重解 38MB sysroot）：实时检查一天能跑几千次。`checkOnEngine` 只复用同一个 memfs 文件 `check.c`（同名覆盖已验证不留残诊断），不碰 `engine.runs`。
- **`log.text` 有 8MB 上限**，写满后 `hostWrite` 直接 return，之后的切片永远是空的。所以检查路径在日志超过 1MB 时自己把 `log.text` 清空。

**已知引擎噪音**：每次写文件 memfs 会往**真实 stderr** 打 `Assertion failed: IsRegularFileNode(node)`，它不进 `log.text`，不要拿它当诊断。

## 3. 逐字敲代码

`src/background/typist.ts`。算法要同时对付编辑器的「自动闭合」和「自动缩进」，核心三条：

**① 行首硬不变量：光标右侧必须为空**（`clearLineTail`）。每行开始前探一次，只允许删 `) ] } " '`；见到字母数字立刻停手——那说明探针读到别的行了，再删就是盲删。

**② 缩进按一下回读一次**（`normalizeIndent`）。不能「要删 N 格就按 N 次 Backspace」：光标停在纯前导空白上时，一次 Backspace 会把整段缩进删光，多按的几下直接砸进代码。安全前提是 `col <= indent`（光标落在前导空白内）才允许 Backspace，永远不会越过行首。

**③ 逐字符敲，敲之前先看「幻影」**。编辑器会自动补右半边（敲 `(` 变成 `()`），这个多出来的字符叫幻影：

- 源文本正要它 → `ArrowRight` 跨过去，**不重复敲**
- 用不上 → `Delete` 抹掉，否则会插进代码中间
- 引号幻影 → 留到字面量结束（字符串正常闭合靠它）

换行前要把行尾幻影抹掉（`dropPhantom`），否则它会被 Enter 顶到下一行行首。反斜杠续行时连引号幻影一起抹。

轻量词法状态机（`stepLex`）只做四件事：`//` 行注释、`/* */` 块注释、`"…"`、`'…'`，外加 `\` 转义——用来判断引号幻影该不该留。

统计结果会回给模型看（`describeTypist`）：敲了多少行、多少字符、跨过几个自动补的右符号、抹掉几个多余闭合符、缩进调整几处。

## 4. 提交与判题

`SUBMIT_ANSWER_SCRIPT`（`pta-scripts.ts`）：

- **提交前先读一次旧结论、关掉上一次的弹窗**。弹窗盖着编辑器，不关掉点不到提交按钮；关不掉就别硬点，把「被什么挡住了」告诉模型。
- **判定「这次出结论了」要三个条件同时满足**：文字非空 ∧ 与提交前那条不同 ∧ 能归一化成状态码。只看「文字变了」是不够的——提交后弹窗立刻显示「评测中」，那是全新文字但不是结论，只按「变了」判断会当场退出等待，然后把还在评测的弹窗关掉，这次结果永远等不到。
- **PTA 的结果页不会自己刷新**，等待循环里只点**判题弹窗内**的「刷新 / Reload」按钮（`lastReloadAt >= 5000`）；弹窗里没有就返回「没拿到结论」，让模型/用户用 `refresh_page` + `read_judge_result`，不再点页面级 Reload（会整页刷新）。
- **拿到结论之后才关弹窗**。没出结论时绝对不关——弹窗里的「评测中」是唯一能看到进度的窗口。

**结论归一化**（`JUDGE_WORDS`）：**顺序即优先级**，具体状态排在泛化词前面，否则「编译错误」会被当成「错误」报成 WA，模型就会一直改算法而不碰那句语法错误。

- 「部分正确」必须排在所有正向词前面：PTA 的部分得分弹窗里常同时出现「部分正确」和「通过测试点 6/10」，只认泛化的「通过」就会把部分正确误报成 AC。
- 英文页也要认：`Accepted / Wrong Answer / Time Limit Exceeded…`，只认中文会整页读不出结论。
- `unaccepted` 必须在 `accepted` 前面，`partially accepted` 也必须在 `accepted` 前面（它是包含关系）。
- 跨容器挑结论时按 `JUDGE_RANKS` 取 rank 最小的那个（`PC` 最具体，`AC` 最笼统）。
- **裸状态码（AC/WA/…）只在很短的一行里才算**：页面上随便一段脚本源码里就可能有个孤零零的 `RE`（PTA 那段「不再支持旧浏览器」的提示脚本里的 `you're` 会被误判）。
- 「通过」太泛：PTA 会在结论旁边写「通过测试点 6/10」「通过率 60%」，那是统计不是结论，所以 `isVerdictPass` 用正则排除了这些搭配。

## 5. 借 PTA 的编译器

插件**内置 C、C++、Python、JavaScript** 四种运行环境（见 `public/engine/README.md`）。Java、Go、C# 这类语言本地跑不了，一律借 PTA 自己的环境：

- `SIMULATE_PTA_RUN_SCRIPT`：展开测试面板（`Test Case / 测试用例`）→ 把 `stdin` 填进测试输入框（不传就沿用面板里原有的输入）→ 点「运行测试 / Run Test Case」→ 轮询读回结果。英文页还会带回 Expected Result；结果为空时回退去读 `Compiler's Log` 页签。
- `READ_PTA_COMPILE_RESULT_SCRIPT`：读页面上的「编译器输出」（运行输出、异常堆栈、编译错误）。

**新版测试区是页签**：`Test Case` / `Running Result` / `Compiler's Log`，结果容器可能在第 5 层祖先里，而且跑完不一定自动切页签。所以两个脚本都会**主动点开目标页签**再读；读结果时按编辑器内容读（`.cm-content` 的 `textContent`），不要按 `innerText`（会带上行号槽）。

**别把用例表当结果**：新版考试页在测试区里直接列出若干组「输入 / 期望输出」，它们本来就是
只读 CodeMirror。早期脚本只判断「运行前后文本不同」，结果把整张用例表读回来交给模型
（真机 7-2 出生年读到 1988 4 / 25 2013 / 1 2 / 0 0001 四段）。现在点运行前先快照所有只读
编辑器（包括隐藏的结果页签），只认新增结果框 / 新写入的文本 / 结果页签由隐藏变可见；
`stdin` 也要写进**可见**的那个测试输入框，隐藏的旧测试面板不能抢。

## 6. 粘贴

PTA 的 `onpaste` 是平台防抄袭控制。插件的做法（`src/content/paste.ts`）：

- `Ctrl+V` / `⌘V` 抢在页面监听器之前读剪贴板，再走插件自己的写入链路塞进编辑器（编辑器事务，不触发页面的 paste 事件）。
- 抢不过页面时用 `Ctrl+M` 兜底（PTA 没占用这个键）。
- 右键 / 中键粘贴走 `paste` 事件，同样接管。
- **只在焦点落在可写作答区时接管**：`editableTarget` 先看是不是 `.cm-content`，否则只在 `pintia.cn` 上认 `contenteditable`；只读编辑器（`aria-readonly` / `contenteditable="false"`）不接管，所以别的网站、别的输入框照常。

## 7. 坑位清单

改这块代码前先扫一眼：

1. `innerText` 回读会多吐尾部空行的 `\n`，要读 `.cm-line` 的 `textContent`。
2. `Home` 是行首**绝对 0 列**，不是首个非空白；按完紧接 Backspace 会把上一行合并进来。
3. 光标在纯前导空白上时，**一次 Backspace 删光整段缩进**。
4. 探针要读到 `.cm-line` 末尾，否则跨 span 的闭合符读不到，幻影抹不干净。
5. 行尾括号幻影要在 Enter **之前**抹掉，否则被顶到后面某一行。
6. C 的缩进服务会在 Enter 后**回头重排** `case`/`default`，只能事后统一扫一遍缩进。
7. 按键异步生效，破坏性按键后必须回读确认。
8. `ArrowRight` 跨过幻影之后必须跳过那一次输入，否则敲出双引号。
9. 反斜杠续行要把**引号幻影也抹掉**再 Enter。
10. 陈旧 DOM 导致盲删：探针用「列号必须落在本行文本长度内」自检 `stale`，破坏性按键遇 `stale` 一律跳过。
11. 换行前必须把缓冲里的字符先落下去，缓冲里的字符会落到 Enter 之后那一行。
12. **不要分段续敲**：调用之间页面 freeze/unfreeze 会把 CodeMirror 的选区弹回文档开头，后一段全插到最前面。
13. 长文档（>50 行）无法整篇回读：CM6 只渲染视口附近的行，翻页或改 `scrollTop` 都不会让窗口前移——此时回读结果不可信，要严格证明得切小段分别敲。
14. 题面的样例输入框也是 CodeMirror（只读），选编辑器时必须排除，否则会往样例框里敲代码。
15. 题面摊平时**整块跳过样例框**（连行号槽一起），只跳 `.cm-content` 会漏出行号与 `▸` 折叠标记。
16. **等判题结论时别乱点「刷新 / Reload」**：选择题页的页头也有个 `Reload`，那是整页重新加载——点一下页面就刷了，插件的悬浮窗随之消失、正在跑的那一轮也接不上。所以插件只认**判题弹窗里**的刷新按钮。
17. 插件自己派发的**合成 Esc**（`close_dialogs` 用来关 PTA 弹窗）会被页面上任何监听 Esc 的代码看到。插件的悬浮窗也监听 Esc，所以它只认 `event.isTrusted` 的按键，否则关弹窗时会把悬浮窗一起关掉。
18. 选择题/判断题的作答区**没有「提交」按钮**，是英文的 `Save`（保存即提交）。

## 8. 扩展页的 CSP：讲解页为什么这么绕

`/what` 生成的讲解页是**模型产出的 HTML**，要能在新标签页里跑起它的脚本。扩展页的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，实测（Chrome 150）：

| 做法 | 结果 |
|---|---|
| 扩展页里的内联 `<script>` | 不执行 |
| `URL.createObjectURL` 出来的 blob: 脚本 | **也不执行**（`script-src-elem` 明确把 `blob` 拦掉） |
| `eval` / `new Function` | 被拦（没有 `'unsafe-eval'`） |
| 在扩展页 CSP 里加 `'unsafe-inline'` | **清单校验直接拒绝**（各种 `sandbox` 写法都试过，一律拒绝） |
| 扩展页里的 `srcdoc` / `data:` iframe | 继承父页面 CSP，内联脚本同样被拦 |
| 内联 `<style>` | 允许 |
| 顶层 `data:` URL 标签页 | 内联脚本能跑（自带一套 CSP），但地址栏里是几万字符的 HTML |
| **普通网页里的沙箱 `srcdoc` iframe** | **能跑**（网页没有 CSP 时，srcdoc 继承不到限制），且不透明来源拿不到 cookie |

所以最终方案是**PTA 站点上的固定路径 + 沙箱 iframe**：

- 讲解页开成 `https://pintia.cn/pta-assistant/explain?id=…`（地址栏是正常网址，没有长度上限）；
- `src/content/explain-mode.ts` 认出这个路径，把整份 HTML 装进 `<iframe sandbox="allow-scripts allow-popups allow-forms" srcdoc="…">`；
- `sandbox` 不给 `allow-same-origin` → iframe 拿到**不透明来源**（`origin` 是 `null`）：读不到父页面 DOM、拿不到 `document.cookie`、拿不到 `chrome.*`，也就碰不到 API Key；
- PTA 没发 CSP 头，模型产的脚本能正常跑（这也是为什么不能改成扩展页）。

**注意**：内容脚本跑在 `<all_urls>` 上，所以认讲解页时**光看路径不够**，还要看站点是不是 pintia.cn（否则别的网站同路径的页面会被劫持）。

还有一个模型侧的坑：`<script>` 是 raw-text 元素，里面的 HTML 实体**不会**被解码。模型把 `>` 写成 `&gt;` 是对的（HTML 里就该转义），但放进 `<script>` 里就会变成字面的 `&gt;`——页面正文里会看到 `A &gt; B`，JS 字符串的内容也错了。存讲解页时要**只对 `<script>` / `<style>` 的内容做一层实体解码**（`src/shared/explain-html.ts` 的 `decodeRawTextEntities`）。


