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

- 同一份列表里可能混着**多个题型**（type/1 判断、type/2 选择、type/6 代码填空、type/7 编程…），按 DOM 顺序排列 → 找「下一题」要按 **DOM 顺序**，不能按 id 排序。
- 当前题的 id 从 `location.href` 的 `problemSetProblemId=` 取。
- **点它是前端路由跳转，不会整页刷新**：实测跳转前设的 `window.__marker` 还在，标题变了，插件悬浮窗的宿主元素也还在。所以同一段页面脚本里点完链接可以继续等页面换好，插件的对话上下文也不会断。
- 题型在地址里：`/problems/type/N`，1=判断、2=选择、6=代码填空、7=编程、9=多文件。

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
- **PTA 的结果页不会自己刷新**，等待循环里**每 5 秒点一次**页面上的「刷新 / Reload」按钮（`lastReloadAt >= 5000`）。
- **拿到结论之后才关弹窗**。没出结论时绝对不关——弹窗里的「评测中」是唯一能看到进度的窗口。

**结论归一化**（`JUDGE_WORDS`）：**顺序即优先级**，具体状态排在泛化词前面，否则「编译错误」会被当成「错误」报成 WA，模型就会一直改算法而不碰那句语法错误。

- 「部分正确」必须排在所有正向词前面：PTA 的部分得分弹窗里常同时出现「部分正确」和「通过测试点 6/10」，只认泛化的「通过」就会把部分正确误报成 AC。
- 英文页也要认：`Accepted / Wrong Answer / Time Limit Exceeded…`，只认中文会整页读不出结论。
- `unaccepted` 必须在 `accepted` 前面，`partially accepted` 也必须在 `accepted` 前面（它是包含关系）。
- 跨容器挑结论时按 `JUDGE_RANKS` 取 rank 最小的那个（`PC` 最具体，`AC` 最笼统）。
- **裸状态码（AC/WA/…）只在很短的一行里才算**：页面上随便一段脚本源码里就可能有个孤零零的 `RE`（PTA 那段「不再支持旧浏览器」的提示脚本里的 `you're` 会被误判）。
- 「通过」太泛：PTA 会在结论旁边写「通过测试点 6/10」「通过率 60%」，那是统计不是结论，所以 `isVerdictPass` 用正则排除了这些搭配。

## 5. 借 PTA 的编译器

插件**只内置 C、Python、JavaScript** 三种运行环境（见 `public/engine/README.md`）。Java、C++、Go 这类语言本地跑不了，一律借 PTA 自己的环境：

- `SIMULATE_PTA_RUN_SCRIPT`：展开测试面板（`Test Case / 测试用例`）→ 把 `stdin` 填进测试输入框（不传就沿用面板里原有的输入）→ 点「运行测试 / Run Test Case」→ 轮询读回结果。英文页还会带回 Expected Result；结果为空时回退去读 `Compiler's Log` 页签。
- `READ_PTA_COMPILE_RESULT_SCRIPT`：读页面上的「编译器输出」（运行输出、异常堆栈、编译错误）。

**新版测试区是页签**：`Test Case` / `Running Result` / `Compiler's Log`，结果容器可能在第 5 层祖先里，而且跑完不一定自动切页签。所以两个脚本都会**主动点开目标页签**再读；读结果时按编辑器内容读（`.cm-content` 的 `textContent`），不要按 `innerText`（会带上行号槽）。

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


