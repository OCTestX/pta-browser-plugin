# PTA-assist 如何模拟输入、如何定位题目与输入框

本文把 `PTA-assist` 里与 PTA 页面打交道的三件事讲清楚：

1. **定位题目** —— 从哪个容器抠题面、怎么解析成结构化字段、题目 ID 从哪来。
2. **定位输入框** —— 怎么在 PTA 页面里认出「那个可编辑的 CodeMirror 6 作答区」。
3. **模拟输入** —— 怎么用真实键盘事件把代码逐字敲进去，怎么和 CM6 的自动闭合 / 自动缩进和解。

所有结论都对应到具体文件与函数，可以按图索骥。

---

## 0. 全景：三层分工

```
┌────────────────────────────────────────────────────────────┐
│ Agent（pi 内置 runtime）                                    │
│   调工具：simulate_keyboard_input / submit_answer / ...      │
└───────────────┬────────────────────────────────────────────┘
                │ 工具定义在 resources/.../tools/solve.json
┌───────────────▼────────────────────────────────────────────┐
│ Kotlin（core/…/tool/SolveTools.kt → pta/PtaDriver.kt）     │
│   · 启动/托管 Chromium 标签页（pta/BrowserSession.kt）      │
│   · 所有 Playwright 调用都在这一侧执行（页面在 JVM 进程内）   │
└───────────────┬────────────────────────────────────────────┘
                │ 127.0.0.1 临时端口 + 一次性 Bearer 令牌
┌───────────────▼────────────────────────────────────────────┐
│ 便携 Node（工作目录 tools/）                                 │
│   run-typist.mjs     一次性驱动，读配置 → setText → typeText │
│   typist-page-shim.mjs 把 page 包装成走 HTTP 的远程 page     │
│   pta-typist.mjs     敲键盘的唯一实现（全部算法在这）         │
└───────────────┬────────────────────────────────────────────┘
                │ /key /focus /eval /evalArg
┌───────────────▼────────────────────────────────────────────┐
│ 同学屏幕上那个真实 Chromium 标签页（pintia.cn 题目页）        │
└────────────────────────────────────────────────────────────┘
```

为什么算法放 JS、按键放 JVM：

- **算法**（自动闭合幻影怎么处理、缩进怎么归一化、回读比对）在 JS 里最顺手，Kotlin 侧不重复实现第二份。
- **按键/求值**必须是 Playwright，而 Playwright 会话在 JVM 进程里（同一个浏览器、同一份登录态、同一个用户可见的标签页）。
- 于是用 `TypistRunner.PageBridge` 在回环地址上临时开 4 个 HTTP 端点（`/key`、`/focus`、`/eval`、`/evalArg`），Node 侧 `fetch` 过去。
  - 只监听 `127.0.0.1` + 随机端口 + 每次运行新生成的 UUID 令牌。
  - 单线程执行器串行执行 —— Playwright 的 `Page` 不是线程安全的，而 typist 是「探针 → 按键 → 探针」交替发请求的。
  - **刻意不给 Chromium 开 DevTools 调试端口**（`TypistRunner.kt` 类注释里写了理由：那等于在同学登录着 PTA 的浏览器上多开一个本机可控制的口子）。

关键源码：

| 文件 | 职责 |
|---|---|
| `core/…/pta/BrowserSession.kt` | 托管 Chromium：启动、复用标签页、`currentUrl`、`pageText`、`close` |
| `core/…/pta/PtaSource.kt` | **只读**：抠题面、读作答区代码与语言 |
| `core/…/pta/ProblemTextParser.kt` | 纯函数：题面文本 → `ProblemInfo`（不碰浏览器，可单测） |
| `core/…/pta/PtaDriver.kt` | **动手**：清空编辑器、逐字输入、点提交、盯判题、关弹窗、执行 JS、读 DOM |
| `core/…/pta/TypistPage.kt` | 页面动作接口 + Playwright 实现（可脱离浏览器 mock 做测试） |
| `core/…/pta/TypistRunner.kt` | 起便携 Node、开页面桥、解析结果 JSON |
| `core/src/main/resources/…/pta/pta-typist.mjs` | 逐字敲键盘的**唯一**实现 |
| `core/…/tool/SolveTools.kt` + `resources/…/tools/solve.json` | 暴露给 agent 的动手工具 |

浏览器会话本身（`BrowserSession.launchBlocking`）有几件事值得记：

- 先用 `ChromiumLocator` 自己找 `assets/browsers/chromium-*/chrome(.exe)`，再 `ChromiumSelfCheck` 跑一遍拿版本 —— 因为 Playwright 的报错 message 基本是字面量 `"Error {"`，不可读，所以自己先跑一遍才有真诊断信息。**顺序不能反**：先找可执行文件再建 Playwright，反过来的话它会退回自己的仓库下 150 MB 且日志上看不出来。
- `Playwright.create(CreateOptions().setEnv(driverEnv(...)))` 必须显式传三个环境变量：`PLAYWRIGHT_BROWSERS_PATH`、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`、`PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1`。Java 层读不到也不改得了自己的进程环境变量，只能通过这个口子传给驱动 Node 进程。
- 传了 `userDataDir` 就走 `launchPersistentContext`（登录态留在工作目录），否则 `newContext`。视口固定 `1440×900`，locale `zh-CN`。
- 全软件共用一个窗口一个标签页，`ensurePage()` 在用户把标签页关掉时补一个。

---

## 1. 定位题目

### 1.1 前提：不定位，按当前页面开工

`SolveModeSession.runInner` 里明确写了：**不查登录态、不跳地址、不校验题目范围**。同学自己登录、自己打开要做的那道题，软件就按 `session.currentUrl()` 开工。以前会自动登录并强制跳到设置里配置的那道题，同学正在做别的题时就会被带跑；而且判据一旦不成立，做题模式在开工前就失败，agent 连页面都没机会读。

`awaitProblemPage()` 只做一件事：**等页面渲染**。PTA 是前端路由，`navigate` 回来 URL 立刻变，但 DOM 还没建好，这时抓题面会拿到空文本。轮询 8 次、每次等 2 秒。

### 1.2 抠题面：`STATEMENT_TEXT_JS`（`PtaSource.kt`）

按优先级扫容器，**取第一个 innerText 长度 > 40 的**：

```js
'.problem-content', '.problem-statement', '.pt12-problem-content',
'[class*=problem]', '[class*=statement]'
```

一个都没命中就退到 `document.body.innerText`。这是刻意的兜底：宁可读得糙，不能读不到。

标题：`page.title()`，为空时退到第一个 `h1` 的 innerText。

### 1.3 解析题面：`ProblemTextParser`

纯 Kotlin 纯函数，不碰浏览器，所以解析规则可以脱离页面做单测。做法是**按行分桶**：

1. 归一化行首（`normalizeHeading`）：去 `* _ \``、去行首 `# ＃`、去行尾 `: ： . 。`、压缩空白。
2. `classify()` 判断这一行是不是小标题，命中就 `Collector.start(key)` 开一个新桶，否则 `append` 进当前桶；小标题之前的内容进 `preamble`。
3. 小标题正则是**中英文双份**：

| 字段 | 匹配的小标题 |
|---|---|
| `description` | 题目描述 / 题目背景和题目要求 / 题目说明 / 问题描述 / 题目 / description / problem / overview |
| `inputFormat` | 输入格式 / 输入描述 / 格式说明 / 输入 / input |
| `outputFormat` | 输出格式 / 输出描述 / 输出 / output |
| `constraints` | 限制 / 题目限制 / 数据限制 / 数据范围 / 数据约定 / 说明与提示 / 提示 / constraints / limits |
| 样例输入 | 样例输入 / 输入样例 / sample input / 样例 #1 输入 / 示例 1 的输入 … |
| 样例输出 | 样例输出 / 输出样例 / sample output / 样例 #1 输出 … |

4. 样例按编号配对：输入与输出**都存在**的编号才成为一组（`pairSamples`）。
5. `join()` 丢掉首尾空行再拼，正文内部的空行保留。

两个重要的**不抛异常**设计：

- `parse` 里如果一个桶都没开（`hasBlocks() == false`），把整段原文原样当描述交出去。PTA 题目页结构会变，登录页/题目列表页也可能被误当成题目页 —— 以前直接抛异常导致做题模式开工前就死掉。
- `PtaSource.requireProblem` 在连题面区域都抠不到时，再退一层到整页正文。

### 1.4 题目 ID：`extractProblemId(url)`

从 URL 末段里取纯数字段：`.../problems/1150901824503297/description` → `1150901824503297`。做法是：去掉 `#`/`?`，去掉 scheme 和第一段 host，`split('/')` 后从最后一个含数字的段里抽 `\d+`。

### 1.5 语言识别（定位「这道题用什么语言写」）

`resolveLanguage` → `ProblemTextParser.detectLanguage`，规则非常严：

- 先 `substringBefore('(')` 去掉 PTA 下拉框里的编译器版本后缀（`C++ (g++ 4.9)` → `C++`）。
- 去空白转小写做**精确匹配**：`CPP_TOKENS` 含 `c++ / cpp / gnuc++ / c++17(gnu11) …`，`C_TOKENS` 含 `c / ansic / c99 / gnuc / c89(gnu) …`，外加 python/java/go。
- 长度 > 20 直接认不出（那必然是整句话）。
- `LANGUAGE_HINTS_JS` 只收**明确的语言标识**：`<select>` 的当前项（text 与 value）、`.cm-editor/.cm-content/[data-language]/[data-lang]/[data-mode]` 上的属性、编辑区父子容器里**整体就是一个语言名**的无子元素标签。

历史教训写在注释里：**以前还扫全页所有 button/div/span**，「正文里出现 C 两个字就算语言」—— 这正是模型一会儿当 C 一会儿当 C++ 的直接来源。现在认不出就如实标成 `未知（候选：…）` 并把候选原样带回，让模型自己用 `inject_js` 去页面上一眼确认，**不猜**。

---

## 2. 定位输入框（作答区编辑器）

核心选择器就两个：`'.cm-content'` 与 `'[contenteditable="true"]'`，配合 **`isContentEditable` 过滤**，取 **innerText 最长的那个**。

```js
// PtaSource.EDITOR_CODE_JS（读）与 PtaDriver.FOCUS_EDITOR_JS（聚焦）用的是同一套选法
const nodes = Array.from(document.querySelectorAll('.cm-content, [contenteditable="true"]'));
let best = null;
for (const el of nodes) {
  if (!el.isContentEditable) continue;                 // ← 题面里的样例框是只读的，靠这条排除
  if (!best || (el.innerText||'').length > (best.innerText||'').length) best = el;
}
```

要点：

- **`isContentEditable` 这一层是必须的**。PTA 题目页里题面的样例输入框也是 CodeMirror（只读），不排除就会选中它们。
- **取最长的那个**：页面上常同时存在「上一题的残留编辑器」「题面样例框」「真正的作答区」，按文本长度筛最稳。
- `typist.mjs` 里的默认选择器是 `".cm-content[contenteditable='true']"`（`DEFAULT_SELECTOR`），聚焦失败时会返回 false，`typeText` 随即失败而不是默默敲到别的框里。

聚焦 + 清空（`PtaDriver.clearEditor`）：

1. 先 `dismissOverlays()` —— 上一次提交留下的判题弹窗会盖住编辑器，不关掉点不到。
2. JS 聚焦 `.cm-line`，`window.getSelection()` 选中它全部内容。
3. `Control+A` → `Delete`。
4. **回读确认**：最多轮询 20 次、每次 50ms，读 `EDITOR_CODE_JS` 直到 `isBlank()` 才算成功。按键是异步的，不确认就是假成功。

---

## 3. 模拟输入（核心）

入口：agent 调 `simulate_keyboard_input { code, perCharDelayMs }`
→ `SolveTools.typeCode` → `PtaDriver.typeCode` → `TypistRunner.type` → `node run-typist.mjs tools/typist-run.json`
→ `setText(code)` → `typeText(page, code, opts)` → 结果 JSON 以 `[pta-typist] ` 前缀打到 stdout，Kotlin 侧靠 `RESULT_MARK` 挑出那一行解析成 `TypistResult`。

### 3.1 铁律：不粘贴

文件头写得很直白：

> 不使用剪贴板粘贴 —— PTA 的 `onpaste` 是平台防抄袭控制，不拆。
> `page.keyboard` 产生的是浏览器输入管线里的真实键事件，和人打字同源。

补充实测结论（也写在 skill 里）：往剪贴板写内容再发真 Ctrl+V，编辑器**纹丝不动**；CDP 拿到的还是 shim 剪贴板。所以键盘通道是唯一通道。

### 3.2 `typeText` 的五个阶段

```js
const raw = String(source).replace(/\r\n/g,"\n").replace(/\t/g,"  ");  // Tab 一律展开成 2 空格
const lines = raw.split("\n");
if (lines.at(-1) === "") lines.pop();

await page.focus(selector);                       // .cm-content[contenteditable='true']
if (clear) { chord(Ctrl+A); press("Backspace"); }
```

然后逐行：

#### ① 行首 `clearLineTail` —— 硬不变量「光标右侧必须为空」

```js
for (let attempt = 0; attempt < 6; attempt++) {
  const right = await readRight();
  if (right === "") return true;
  if (!CLOSERS.has(right[0])) return false;      // 只删 ) ] } " ' —— 见到字母数字说明
  await press("Delete");                         // 探针读到的是别的行（陈旧 DOM），立刻停手
}
```

只允许删闭合符是防「盲删把代码吃掉」的关键闸门。

#### ② 缩进归一化（probe 驱动，按一下回读）

```js
for (let guard = 0; guard < 40; guard++) {
  const q = await readCursor();
  if (!q || q.stale) break;
  if (q.col <= target) break;                    // 已经够了
  if (q.col > q.indent) break;                   // 前面有正文，宁可不改也不能删
  await press("Backspace");                      // 一次删一格，回读后再判
}
if (cur.col < target) for (…) await put(" ");    // 补空格
```

三个必须记住的点：

- **不能「要删 N 格就按 N 次 Backspace」**：光标停在纯前导空白上时，一次 Backspace 会把整段缩进一次删光，多按的几下直接砸进代码，把上一行的 `; )` 删掉。
- **不按 `Home` 定位**：CM6 的 `Home` 是「行首绝对 0 列」，按完紧接的 Backspace 会把上一行合并进来。收尾修缩进时才用 Home，且要**重按并回读确认 `col === 0`**（Home 异步生效）。
- 安全前提：只有 `col <= indent`（光标落在前导空白内）才允许 Backspace，永远不会越过行首。

#### ③ 逐字符敲，边敲边调和自动闭合

核心状态：

```js
let phantom = null;        // 期望躺在光标右侧的自动闭合符
let phantomQuote = false;  // 引号幻影要留到字面量结束
```

每敲一个必须逐字处理的字符前，先调和：

```js
if (phantom) {
  const right = await readRight();
  if (!right.startsWith(phantom)) {
    phantom = null;                       // 幻影没生成（CM 没自动闭合）→ 当普通字符敲
  } else if (ch === phantom) {
    await press("ArrowRight");            // 源文本正要它 → 跨过去，不重复敲
    actions.skipped++; skipType = true; phantom = null;
  } else if (!phantomQuote) {
    await press("Delete");                // 用不上 → 抹掉幻影，否则插进代码中间
    actions.erased++; phantom = null;
  }
  // 引号幻影且不在收尾位置：留着，让字符串正常闭合
}
```

`dropPhantom` 在**换行前**再抹一次，并且**必须先把批量缓冲 flush 出去** —— 缓冲里还压着字符的话它们会落到 Enter 之后那一行，整份代码从这里整体错位。反斜杠续行（多行宏/跨行字符串）时 `force=true`，连引号幻影一起抹，否则 Enter 会把它顶到下一行行首。

#### ④ 批量敲普通字符（性能关键）

慢的根源不是 `delay`，而是**每个字符一次 `page.keyboard.type`** —— 那是一次穿过回环 HTTP 桥的往返（Node → 127.0.0.1 → JVM → Playwright → 回程）。60 行代码上千字符，光往返就磨掉几分钟。

所以攒批，`BATCH_LIMIT = 64`：

```js
const canBatch = (ch, next, mode) => {
  if (ch === "\\") return false;                                 // 改词法状态
  if (mode === "code"   && ch === "/" && (next === "/" || next === "*")) return false;
  if (mode === "block"  && ch === "*" && next === "/") return false;
  if (OPEN_TO_CLOSE[ch]) return false;                           // ( [ {
  if (QUOTES.has(ch))   return false;                            // " '
  if (phantom) return phantomQuote && ch !== phantom;            // 字面量内部可以攒，幻影始终有效
  return true;                                                   // 标识符/数字/运算符
};
```

判据是「逐字敲与整段敲对编辑器完全等价」。注意括号引号**一律**逐字处理、不看当前是否在注释里：CM 的自动闭合不认注释（注释里的 `(` 也可能被补 `)`），攒批会把调和整个跳过。

攒批时**词法状态照样逐步推进**（`stepLex`），只省往返不省状态机 —— 少了这步，字符串里的反斜杠会一直挂着 `escaped`，后面的引号不会被当成字面量收尾。

轻量词法状态机 `makeLex/stepLex` 只做四件事：识别 `//` 行注释、`/* */` 块注释、`"..."`、`'...'`，并处理 `\` 转义。目的是避免在字符串里误判自动闭合。

#### ⑤ 收尾统一扫缩进

逐行对抗 CM 的自动缩进是无效的：C 的缩进服务会在你按下 Enter 之后**回头重排上一行**（把 `case`/`default` 重新对齐到 `switch` 体一级）。所以文本敲完之后：

```
Ctrl+Home → 逐行 ArrowDown → indent != want 的行单独修
   重按 Home 直到回读 col === 0（Home 异步）
   indent > want → press("Delete")；indent < want → put(" ")
   循环里每步都回读，stale 就 break
```

`reindent: false` 可以整段跳过（分段续敲时前几段已经扫过了），但**只能整段开或整段关** —— 这段会把光标移到文档开头。

### 3.3 两个页面内探针

都必须能穿过回环桥，所以写成独立的函数、通过 `page.evaluate(fn)` 传源码过去。

**`probeCursor()`** —— 光标行的前导空白长度 + 列号：

```js
let node = r.startContainer;
while (node && !node.classList.contains("cm-line")) node = node.parentElement;  // 上溯到 .cm-line
const lineText = node.textContent || "";
const pre = document.createRange(); pre.selectNodeContents(node);
pre.setEnd(r.startContainer, r.startOffset);
const col = pre.toString().length;                        // 用 Range 量，抗语法高亮把文本节点切碎
return { indent: /^[ \t]*/.exec(lineText)[0].length, col,
         stale: col > lineText.length };                  // 自检：列号必须落在这行范围内
```

`stale` 是防陈旧 DOM 的闸门：CodeMirror 重渲染后 `.cm-line` 节点会与当前选区对不上，此时读到的缩进是假的，所有破坏性按键遇到 `stale` 一律跳过。

**`probeRight()`** —— 光标到本行末尾的文本：

```js
const tail = document.createRange();
tail.setStart(r.startContainer, …);
tail.setEnd(node, node.childNodes.length);                // ← 一路到 .cm-line 末尾
```

必须读到 `.cm-line` 末尾而不是当前 text node 结尾：语法高亮会把行内切成多个 span，只读到当前节点结尾的话，落在别的 span 里的闭合符会被漏掉，幻影抹不干净就会被 Enter 一路顶到后面某一行。

### 3.4 回读比对 `compare`

```js
// 直接读 .cm-line 的 textContent，不用 innerText —— innerText 会把文档尾部空行
// 多吐一个换行，导致整体错位一行
const readLines = () => page.$eval(selector, el =>
  Array.from(el.querySelectorAll(".cm-line")).map(n => n.textContent));

const norm = s => String(s).replace(/[ \t]+/g," ").replace(/\s+$/,"");   // 缩进折叠后再比
// 尾部空行两边都 pop 掉
mismatches = 逐行 norm(e).trim() vs norm(a).trim()
indentExact = 行数相等 && 原文逐字相等
```

返回 `{ ok, indentExact, actions, mismatches, actual }`；`ok=false && strict=true` 时抛错。`actions` 会被回给模型看：

> 已逐字敲入 N 行。回读比对：与源码逐行一致（缩进也完全一致）。处理过程：跳过编辑器自动补的右符号 X 个，抹掉多余的闭合符 Y 个，收尾修缩进 Z 处。

### 3.5 桥协议（`typist-page-shim.mjs` / `PageBridge`）

Node 侧拿到的 `page` 只有这几个方法，映射到 4 个端点：

| JS | HTTP | JVM 侧执行 |
|---|---|---|
| `keyboard.press/type/down/up` | `POST /key {op,value}` | `page.keyboard().press/type/down/up` |
| `focus(sel)` | `POST /focus {selector}` | `page.locator(sel).first().focus()`，返回是否找到 |
| `evaluate(fn)` | `POST /eval {fn}` | `page.evaluate("() => ($fn)()")` |
| `$(sel,fn)` | `POST /evalArg {selector,fn}` | `page.evaluate("() => {const el=document.querySelector(…); if(!el)return null; return ($fn)(el);}")` |

所有请求带 `Authorization: Bearer <uuid>`；Playwright 返回的 `Any`（Map/List/基本类型）在两端各写了一遍 `toJson`/`toJsonElement` 转 JSON。

`TypistPage` 抽成接口正是为了单测：测试里用内存编辑器实现它，就能真的把 `pta-typist.mjs` 跑起来，不需要 Chromium 和它的一堆系统共享库（`TypistBridgeTest` / `TypistRunnerTest`）。

脚本落盘用 `writeScript` 做内容比对，**内容没变就不写**，免得每次敲代码都无谓地改工作目录的时间戳。

---

## 4. 提交与判题（顺带，因为它是「模拟操作」的另一面）

`PtaDriver.submitAndAwaitJudge` 值得单列，因为这里的每个分支都是踩坑换来的：

- **提交前先读一次旧结论 `staleText`，并关弹窗**；关不掉就**直接放弃点击**并把「被什么挡住了 + 怎么自救」告诉模型 —— 点也是点进弹窗里，白等 8 分钟。
- 点提交按文字：先在真正的 `<button>` / `input[type=submit]` 里**精确匹配**，再**包含匹配**，最后才退到 `a/[role=button]/div[class*=btn]/span[class*=btn]/li/label`。顺序很重要：PTA 登录页上「登录」既是标签页又是提交按钮，按 DOM 顺序点会点到标签页上，结果只是切了个 tab。
- **判定「这次提交出结论了」要三个条件同时满足**：文字非空 ∧ 与提交前那条不同 ∧ 能归一化成状态码（`status` 非空）。只看「文字变了」是不够的 —— 提交后弹窗立刻显示「评测中/排队中」，那是全新文字但不是结论，只按「变了」判断会当场退出等待，然后把还在评测的弹窗关掉，这次结果永远等不到。
- 等待策略：前 8 秒不点刷新（后端还没开始判），之后每 10 秒点一次刷新（文案：`刷新`/`重新提交`/`查看结果`/`继续评测`），最多 20 次；每 2 秒轮询一次结果；总上限 8 分钟。
- **拿到结论之后才关弹窗**。模型拿到结论就去改代码，弹窗留在前台会吃掉下一次提交那一下点击，它读到的还是这次结果，就以为白改了而原地打转。但**没出结论时绝对不关** —— 弹窗里的「评测中」是唯一能看到进度的窗口。
- `judgeStatus` 归一化：先试 `\b(AC|WA|RE|TLE|MLE|CE|PE|OLE)\b`，再走中文词表。**顺序即优先级，泛化词必须排在最后** —— 「编译错误」「运行错误」都含「错误」，泛化的「错误」若排在前面，编译错误会被报成 WA，模型就会一遍遍改算法而不碰那句语法错误。同理先判否定词，避免「未通过」被当成「通过」。
- 判题文字来自 `JUDGE_TEXT_JS`：扫 `[class*=judge] / [class*=result] / … / [role=alert] / .el-message / .ant-message` 收短文本；收不到就退到 `document.body.innerText` 里按行正则捞 `^(AC|WA|RE|…|答案正确|答案错误|编译错误|运行超时)`。

弹窗关闭 `dismissOverlays` 也是**每步回读确认**：ESC → 在**识别出的弹窗容器内部**找关闭控件（`[class*=close]/[class*=dismiss]/[aria-label*=close i]/.pc-close`，从最上层容器开始，PTA 用的是 `pc-` 前缀老样式）→ 点文字（`关闭/确定/我知道了/知道了/取消`）→ 点遮罩 → 最多反复 3 轮（关一层常常还压着另一层）。以前是全页面搜 `[class*=close]` 点最后一个，正常页面上一个同名 class 的组件就可能被误点。

---

## 5. 暴露给 agent 的工具

`resources/io/ptaassist/core/tools/solve.json` 定义，`SolveTools.tools()` 绑定。**只在做题模式挂给**；建议模式与对话模式拿不到。

| 工具 | 副作用 | 对应实现 |
|---|---|---|
| `clear_editor` | MUTATES_PAGE | `PtaDriver.clearEditor` |
| `simulate_keyboard_input { code, perCharDelayMs=8 }` | MUTATES_PAGE | `PtaDriver.typeCode` → typist |
| `submit_answer` | MUTATES_PAGE | `submitAndAwaitJudge`（自己盯到出结果） |
| `read_judge_result` | READ_ONLY | `readJudgeResultAndClose`（读完自动关弹窗） |
| `close_submit_dialog` | MUTATES_PAGE | `dismissOverlays` |
| `read_page_dom { maxChars=40000 }` | READ_ONLY | `pageDom`（DOM_TREE_JS 输出层级 + 关键属性 + 可见文字） |
| `refresh_page` | MUTATES_PAGE | `refreshPage`（reload 后轮询等 DOM 渲染） |
| `inject_js { script }` | READ_ONLY | `evaluate`（函数表达式或普通表达式，返回值 JSON 化） |

`read_page_dom` / `inject_js` 是给「按类名抠页面抠错了」兜底的：软件抠错时，模型自己写选择器把题面、编辑器内容、语言下拉框当前项取出来。

做题模式的工具集合还有个坑记在 `SolveModeSession` 注释里：`run_test_cases` 在 `BuiltinTools` 与 `ChatTools` 里各有一份，语义不同（前者编译同学原稿、参数无 `code`；后者编译模型自己写的代码、参数带 `code`）。工具桥按「后者覆盖前者」裁决，所以必须**按名字去重**，做题模式要的是 `ChatTools` 那份 —— 否则模型自己的代码从头到尾没被编译过一次。

---

## 6. 坑位清单（改代码前先看）

来自 `pta-typist.mjs` 顶部注释与 skill 的知识库第八节，实测级：

1. `innerText` 回读会多吐尾部空行的 `\n`，必须读 `.cm-line` 的 `textContent`。
2. `Home` 是行首**绝对 0 列**，不是首个非空白。
3. 光标在纯前导空白上时，**一次 Backspace 删光整段缩进**，不能「按 N 次删 N 格」。
4. 探针要读到 `.cm-line` 末尾，否则跨 span 的闭合符读不到。
5. 行尾括号幻影要在 Enter **之前**抹掉，否则被顶到后面某一行。
6. C 的缩进服务会在 Enter 后**回头重排** `case`/`default`，只能事后统一扫一遍缩进。
7. 按键异步生效，破坏性按键后必须回读确认。
8. `ArrowRight` 跨过幻影之后必须跳过那一次输入，否则敲出双引号。
9. 反斜杠续行（多行宏、跨行字符串）要把**引号幻影也抹掉**再 Enter。
10. 陈旧 DOM 导致盲删：`clearLineTail` 只允许删 `) ] } " '`，`probeCursor` 用 `col <= 行文本长度` 自检 `stale`，破坏性按键遇 `stale` 一律跳过。
11. 换行前必须 `flushPlain()`，缓冲里的字符会落到 Enter 之后那一行。
12. **不要分段续敲**：每次调用之间页面 freeze/unfreeze 会把 CodeMirror 的选区弹回文档开头，后一段全插到最前面。分段方案只在同一个 eval cell 里做。
13. 长文档（>50 行）无法整篇回读：CM6 只渲染视口附近的行，可视高度 515px 时 197 行的文档里始终只有 51 个 `.cm-line`，翻页/改 `scrollTop` 都不会让窗口前移 —— 此时 `ok`/`indentExact` 不可信，要严格证明得切 ≤45 行一段、每段单独敲并整篇回读。

---

## 7. 一句话总结

- **定位题目**：按类名优先级扫容器抠 `innerText` → 纯函数按行分桶解析成 `ProblemInfo` → 认不出小标题就原样交付，不抛异常。
- **定位输入框**：`.cm-content, [contenteditable="true"]` + `isContentEditable` 过滤（排除题面里的只读样例框）+ 取最长的那个。
- **模拟输入**：**只用真实键盘事件**（不粘贴、不改 DOM），把「怎么对付 CM6」全部集中在 `pta-typist.mjs`：批量敲普通字符提速，括号引号逐字敲并用探针调和自动闭合的幻影（跨过去 or Delete 抹掉），缩进 probe 驱动按一下回读，最后统一扫一遍缩进并回读比对 —— 校验读 `.cm-line` 的 `textContent`，不读 `innerText`。