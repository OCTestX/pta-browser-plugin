这是一个支持 Chrome 浏览器和 Firefox 浏览器的浏览器插件。
它需要内置C或C++语言编译环境。
内置一个自定义的agent loop循环。
当浏览器点击插件图标的时候，会弹出一个附加在页面上方的悬浮窗, 上面是聊天区域，下面是输入框。
这个插件它是专门用来帮助学生完成pta的
他需要支持工具调用，多轮追问，支持渲染markdown和数学
目前有以下几种基础工具
1. js_inject 直接注入JS代码到浏览器。
2. complie_and_run_C 编译并运行C语言代码
3. simulate_keyboard_input 模拟键盘输入
4. 获取题目要求。
5. 获取用户代码。
6. 覆写用户代码。
7. 编写文档并下载到用户的浏览器。
8. date 获取当前日期
9. url 获取当前页面的url

注意，只有当用户说可以发版时才可以使用v0.1等标签标记commit

## 工程结构

```
manifest/manifest.json   手写的清单文件（Chrome 用），Firefox 版本在构建时按差异打补丁
vite.config.ts           构建配置：一次构建一个入口（background / content），target 决定产物目录
src/
  background/index.ts    background：图标点击、消息路由、维护进行中的请求
  background/agent.ts    agent loop：请求模型 → 执行工具 → 回灌结果 → 再来一轮
  background/deepseek.ts 调用 /chat/completions，解析 SSE 文本增量与 tool_calls 分片
  background/js-inject.ts 在页面主世界执行模型给的 JS（含超时与隔离世界回退）
  background/settings.ts 设置读写（chrome.storage.local），API Key 只留在这里
  content/index.tsx      content script：注入 Shadow DOM 宿主节点并挂载 React
  content/App.tsx        悬浮窗主体（对话 / 设置两个视图）
  content/pageTools.ts   页面侧工具：url 取当前地址，write_document 触发下载
  content/hooks/         useChat（消息、流式增量、工具事件）、useSettings
  content/components/    消息列表、markdown 渲染、工具卡片、输入区、设置页
  content/katexStyles.ts KaTeX 样式的字库地址改写成扩展地址
  content/styles.css     悬浮窗样式（跟随 content.js 一起注入，不污染页面）
  shared/                browser API 入口、消息协议、工具定义、设置与消息类型
scripts/
  gen-icons.py           生成 public/icons 下的图标
  test-deepseek.mjs      假的 fetch 跑 SSE 解析与错误映射
  smoke.mjs              jsdom 冒烟测试：清单完整性、悬浮窗、流式对话、设置页
```

## 开发与调试

```bash
npm install
npm run build      # 类型检查 + 产出 dist/chrome、dist/firefox
npm run test       # SSE 解析校验 + 冒烟测试（冒烟测试需要先 build）
npm run icons      # 重新生成图标（需要 python3 + Pillow）
```

需要 Node 22.18+（`scripts/test-deepseek.mjs` 直接跑 TS 用的类型擦除）。

构建脚本刻意不删产物目录本身（只让 Vite 清空目录内容）：目录被删掉重建后，浏览器里已加载的插件还指向旧目录，刷新时会报「File path cannot be resolved / 无法加载清单」。遇到这个报错就把插件「移除」再重新加载一次。

加新依赖时注意：Chrome 会用 `base::IsStringUTF8` 校验脚本，Unicode 非字符（U+FFFE / U+FFFF 之类）会被判成「不是 UTF-8 编码」而拒绝加载整个插件，但 Python / Node 的严格解码都会放行，很容易查半天。构建里已经统一把非字符转义成 `\uXXXX`（必须在压缩之后做），冒烟测试也会检查。

加载方式：

- Chrome：`chrome://extensions` -> 打开「开发者模式」-> 「加载已解压的扩展程序」-> 选择 `dist/chrome`
- Firefox：`about:debugging#/runtime/this-firefox` -> 「临时载入附加组件」-> 选择 `dist/firefox/manifest.json`

**要加载的只有构建产物目录**（`dist/chrome`、`dist/firefox`），不要选项目根目录：根目录里没有 `content.js`、`background.js`，Chrome 会先报「无法为脚本加载 content.js」，再报「无法加载清单」。

改代码后需要重新 build，再在扩展管理页点刷新按钮。

点图标打不开悬浮窗时的排查顺序：

1. 页面是在插件安装/重载之前打开的 —— 正常情况下点图标会自动补注入（`scripting.executeScript`），实在不行刷新页面
2. `chrome://` 开头的内部页面不允许注入，属于预期
3. 打开 `chrome://extensions` 点「错误」看 background 有没有报错

## v0.1 已完成

- 构建环境：Vite + React + TypeScript，一份代码产出 Chrome（service worker）和 Firefox（event page）两个版本
- 点击工具栏图标即可打开 / 关闭悬浮窗，悬浮窗固定在页面右上角，样式隔离在 Shadow DOM 内
- 悬浮窗上半部分是聊天区（用户 / 助手 / 提示三类气泡），下半部分是输入框（Enter 发送、Shift + Enter 换行，兼容中文输入法）
- 此时还没有接入 AI，发送后是一条占位回复

## v0.2 已完成

- 接入 DeepSeek 的 OpenAI 兼容接口，单轮流式对话：助手气泡逐字追加，生成中可以点「停止」打断
- 设置页（右上角齿轮）：API Key、接口地址、模型名；默认 `https://api.deepseek.com` + `deepseek-v4.1-flash`
- API Key 存在 `chrome.storage.local`，只有 background 能读到，content script 拿到的视图里没有 Key，页面上也拿不到明文
- 请求由 background 发出（不是 content script 直连）：既避开页面自身的 CSP，也不让 Key 进入页面上下文
- 错误会转成中文提示直接显示在对话里：未配置 Key、Key 无效、余额不足、限流、地址或模型名不对、连不上

对话上下文取自面板里可见的消息（系统提示和报错气泡不发），刷新页面即清空；上下文记忆与 markdown 渲染在 v0.3 处理。

已知限制：自定义接口地址时，需要把该域名加进 `manifest/manifest.json` 的 `host_permissions`，否则浏览器会拦掉请求。

## v0.3 已完成

- 助手气泡实时渲染 markdown（表格、列表、引用、代码块、链接按新标签页打开），公式用 KaTeX 渲染
- 流式过场做了三件事，避免半截内容渲染错：
  - 没写完的代码围栏补上收尾，代码块立刻成形
  - 单行 `$$x$$` 拆成独占一行（micromark 只认这种才算块级公式，否则会当成行内公式不居中）
  - `\[ \]` `\( \)` 这类 LaTeX 定界符统一成 `$`；公式写到一半时先渲染成公式，但后面已经接上中文正文（回答被截断）就按普通文本处理，不硬补收尾去吞正文
- 代码块里的 `$$` 不会被改写，也不参与公式配对
- KaTeX 用只带 woff2 的字库（20 个文件 296K），构建时复制到 `dist/<target>/katex-fonts/`，CSS 里的相对地址改写成扩展地址，并在 `web_accessible_resources` 里声明

## v0.4 已完成

- agent loop：模型可以连续调用工具，结果回灌后继续下一轮，直到给出最终回答；最多 80 轮（`MAX_TOOL_ROUNDS`）
- 四个工具：
  - `js_inject`：在**页面主世界**执行模型写的 JS（所以能拿到 PTA 页面自己的 JS 对象），支持顶层 await，15 秒超时；主世界不可用时自动退回隔离世界（DOM 操作照常，只是拿不到页面对象）
  - `url`：当前页面地址（在页面侧取，SPA 路由变化也准）
  - `date`：当前日期时间与星期
  - `write_document`：用 Blob + `a[download]` 触发下载，文件名会清洗掉路径分隔符，不需要 downloads 权限
- 工具调用在对话里显示成卡片：工具名、参数（`js_inject` 的代码完整展开）、状态、执行结果
- 会话重建：工具卡片会还原成 `tool` 消息、调用记录挂在对应的 assistant 消息上，所以下一轮请求的上下文是完整的
- 执行模型给的 JS 不弹确认（按需求选择），因此**代码会直接显示在卡片里供检查**；同时意味着页面内容有可能诱导模型写出危险代码，请只在可信页面上使用

## v0.5 已完成

新增工具 `simulate_keyboard_input`，让模型能真的往页面里打字：

- 参数：`text`（要输入的文字）、`selector`（目标元素）、`clear`（先清空原内容）、`press`（按 Enter / Escape / Tab / ArrowDown 这类单键）、`perCharDelayMs`（真实按键的字符间隔，默认 8）
- **不填 `selector` 会自动定位作答区**：按 `.cm-content, [contenteditable="true"]` 找、用 `isContentEditable` 过滤掉题面里只读的样例框、取文本最长的那个（页面上可能还残留上一题的编辑器）；找不到才退回当前焦点元素
- 真实按键开关打开时是**逐字发按键**（`Input.dispatchKeyEvent` type=char，默认 8ms 间隔），不走剪贴板、也不直接改 DOM
- **打字时会跟编辑器的「自动闭合 / 自动缩进」对抗**（`src/background/typist.ts`，思路取自同行实践）：
  - 每敲一个左括号/引号，记住编辑器可能补上的右半边（「幻影」）；下一个字符之前先用页面探针看光标右侧：
    源文本正要它 → `ArrowRight` 跨过去不重复敲；用不上 → `Delete` 抹掉；引号幻影留到字面量结束
  - 换行前先把行尾幻影抹掉，否则会被 `Enter` 顶到下一行行首
  - 每行开始前保证光标右侧为空，且**只允许删 `) ] } " '`**——见到字母数字立刻停手（探针可能读到重渲染前的旧 DOM，盲删会把代码吃掉）
  - 缩进按探针「按一下、回读一次」地修：不能「要删 N 格就按 N 次 Backspace」，光标停在纯前导空白上时一次 Backspace 会删光整段缩进
  - 探针读的是 `.cm-line` 的文本（语法高亮会把一行切成多个 span，读到当前文本节点结尾会漏掉闭合符）
- 定位到元素后先 `click()` 再 `focus()`：很多编辑器和页面逻辑要点一下才真的聚焦
- 输入框 / 文本域：走原型上的 `value` setter 再派发 `input` + `change`，这样 React 受控组件也能同步（直接赋值会被它的 value tracker 忽略）
- 可编辑区域 / 代码编辑器：走 `document.execCommand('insertText')`，它能产生正常的 `beforeinput` / `input` 事件链，CodeMirror、Monaco 这类编辑器能接住
- 兜底：`execCommand` 不可用时直接插入文本节点并派发 `input` 事件，并在结果里说明走了兜底
- **真实按键开关**（设置页里的「用调试器发送真实按键」，默认关）：开启后 `simulate_keyboard_input` 改走 `chrome.debugger` 发 CDP 事件（`Input.insertText` / `Input.dispatchKeyEvent`），事件是 trusted 的，编辑器与浏览器默认行为都会响应。开启时先让页面聚焦并选中原内容，输入完立刻断开调试器，所以横幅只在输入的那几秒出现
- 调试器用不了时（该标签页开着 DevTools、或浏览器不支持）会自动退回模拟事件，并在工具结果里说明原因
- **输入后回读确认**：按键是异步生效的，不回读就是假成功。回读 CodeMirror 时按 `.cm-line` 的 `textContent` 拼行（读 `innerText` 会多吐一个尾部换行，导致比对整体错位一行），比对结果（一致 / 第几行不一致）会写进工具结果给模型看

已知限制（`simulate_keyboard_input`）：

- 还没有实现同行做法的「收尾统一扫缩进」（敲完 `Ctrl+Home` 逐行重排）：C 的缩进服务会在按 Enter 后回头重排 `case`/`default` 对齐，这类情况现在只能靠回读比对报出「第 X 行不一致」，模型看到后可以再来一次

- 不开真实按键开关时，按键是**未信任事件**：浏览器默认行为不会发生（回车不换行、表单不提交），只对页面自己写的按键监听有效
- 开了真实按键开关后：那个标签页会显示「正在调试此浏览器」横幅，且此时**不能打开开发者工具**（两者抢占同一个调试器）；扩展需要 `debugger` 权限，重新加载时要在扩展页确认一次
- 目标元素需要有明确的 CSS 选择器；模型会先用 `js_inject` 确认结构（系统提示里要求它这么做）

已知限制：

- `js_inject` 依赖 host 权限：需要先用工具栏图标打开过悬浮窗（这时才拿到该标签页的 activeTab 授权）
- 页面如果 CSP 很严（不允许动态脚本），`js_inject` 会失败并把原因回灌给模型；PTA 站点没有任何 CSP，正常可用
- content.js 因为带上了 markdown + KaTeX 涨到 690K（gzip 205K），首次注入会有一点开销
- 若页面极其严格地限制字体（`font-src`），公式可能退回系统字体显示，结构仍然正确
- 依赖里 katex@0.16 有一条「原型污染绕过 trust 限制」的低危通告，我们没用 `trust` 选项，且输入来自模型而非攻击者

## v0.8 已完成（界面打磨）

- **面板可拖动、位置记住**：拖标题栏移动，双击复位；位置存在 `chrome.storage.local`，刷新页面还在；拖动会被夹在视口内。默认仍然是固定右上角（想自己挪开可以拖动，PTA 的按钮就不会被盖住了）
- **智能滚动**：用户往上翻看的时候不再把视图拽回底部（以前每来一个流式字符都会跳到底部）；离开底部时右下角出现「↓ 回到底部」
- **工具卡片**：可以折叠/展开（长代码、长输出不再一直占屏），代码与结果各有「复制」按钮（用 `execCommand` 复制，不需要额外权限）
- **设置页的「模拟输入测试」**：一个文本框 + 一个按钮，点下去会把文本框内容写进当前页面的作答区（覆盖作答区内容、不提交），结果直接回显（用的哪种方法、回读比对是否一致、页面有没有弹「禁止粘贴」这类提示）
- 一个按钮试不完，所以做成**方法阶梯**：每点一次换下一种，按钮上直接标着「第 N/7 种」并在旁边说明当前方法，进度存在 storage 里（关掉面板再打开还接着试）；点「重来」回到第 1 种。**测试成功后会自动把它记成「可用方法」并显示出来，之后从它开始试**
- **实测结论（2026-10-14，PTA 真实页面）**：只有 **第 5 种「编辑器实例整段 dispatch」成功**；1～4（含 CDP 逐字真按键、CDP 整段插入、execCommand、手工输入事件）都会被页面拦下并弹「禁止粘贴」。`write_editor_code` 工具的首选通道就是这一种，所以你直接让模型改代码即可，不用管这个阶梯
  1. `CDP 逐字真实按键`（逐字发真按键 + 幻影调和）—— ❌ 被拦
  2. `CDP 整段插入`（聚焦后一条 `Input.insertText`）—— ❌ 被拦
  3. `execCommand 整段插入` —— ❌ 被拦
  4. `手工派发输入事件`（beforeinput + input，isTrusted=false）—— ❌ 被拦
  5. `编辑器实例整段 dispatch`（一次换掉全文，不产生输入事件）—— ✅ **可用**
  6. `编辑器实例逐行 dispatch`（多次 transaction + `userEvent=input.type`）
  7. `剪贴板 + 真 Ctrl+V`（对照）—— 预期被 `onpaste` 拦住
- 版本号同步到 0.8.0

## v0.6 已完成

工具 `compile_and_run_c`：把 C 代码送到编译服务编译并运行，可带标准输入，把编译错误 / 运行错误 / 超时 / 服务问题都转成中文汇报（输出过长会截断）。

**为什么走远程而不是内置编译器**：浏览器插件里放不下真正的本地编译环境——clang 的 wasm 加上 sysroot 上百 MB，而且 MV3 不允许从远端加载 wasm 代码（远程代码一律禁止），所以「内置 C 编译器」这条在插件形态下走不通。因此按 **Judge0 协议**（开源、可自建、事实标准）接编译服务：

- 默认 `https://ce.judge0.com`（公共实例，已在 `host_permissions` 里声明）
- 设置页可改成自建或校内的 Judge0 地址；换域名要同时加进 `manifest` 的 `host_permissions`
- 语言 ID 默认 `50`（C, GCC），改成 `54` 就是 C++ (GCC)
- 代码会发给该编译服务；介意的话把地址换成自己部署的

系统提示里也加了：写完 C 代码要先用 `compile_and_run_c` 拿题面样例跑一遍，输出对不上就自己改，别把没验证的代码交给用户。

## PTA 三件套（原计划 v0.7，提前做了）

三个工具都在**页面主世界**执行（编辑器实例挂在页面自己的 JS 对象上，隔离世界看不到），走的是已有的主世界注入器：

| 工具 | 做什么 | 实现 |
|---|---|---|
| `read_problem` | 拿到当前题目的题面 | ① 按类名找，但**遍历所有匹配**而不是只取第一个（只取第一个的话，文本太少的那个会把整个选择器废掉）；② 类名对不上时**按小标题定位**：同时出现「题目描述/输入格式/输出格式/样例输入/样例输出」里两个以上的**最小**容器；③ 都失败才退整页正文，并从第一个小标题开始截断、滤掉「上一题/下一题/图例/Toggle Sidebar/复制」这类纯 UI 文案行；④ 顺手把样例抠成「输入/输出」成对返回，可以直接当 `compile_and_run_c` 的 stdin |
| `read_editor_code` | 读作答区里的代码 | 题面的「输入样例/输出样例」**也是 CodeMirror**（`contenteditable="false"` + `aria-readonly="true"`），所以先收集所有编辑器实例、**剔除只读的**，再在可写的里面取内容最长的；用 `view.state.doc` 读完整文档；只有只读实例时会明确说「只有样例框、没有作答区」而不是含糊报「编辑器是只读的」 |
| `write_editor_code` | 改作答区里的代码（默认整段覆写） | 同样跳过只读样例框；优先 `view.dispatch({changes})` **原子写入**并**把光标留在文末**；退路是聚焦 + 全选 + `execCommand('insertText')`；两条路都**回读比对**。写完还会**自动检查**（`verify` 参数，默认开）：① 回读逐行比对；② 拿题面**第一组样例**编译并比对输出（"样例 1 输出一致" / "不一致——第 1 行不同：期望「7」，实际「8」" / "编译失败——…"）；③ 报告**提交按钮现在可用不可用**（确认页面认了这次修改）。开了「真实按键」开关时还会**自动敲一个空格再退格**触发页面的修改标记 |

编辑器实例不在公开 API 上，只能顺着 DOM 摸：先在 `#pta-answer-editor / .cm-editor / .cm-content` 及其祖先上找 `cmTile.view / cmView / editorView / view / _view`（PTA 用的是 `cmTile.view`），再退一步扫自身属性找「有 `state.doc` + `dispatch`」的对象，找到后把路径一并写进结果里。

系统提示里也把优先级写死了：读题面用 `read_problem`、读代码用 `read_editor_code`、改代码用 `write_editor_code`，**不要**用 `js_inject` 去 dispatch 编辑器、改 `input.value`、或想办法模拟粘贴。

### PTA 收尾：提交与判题

| 工具 | 做什么 | 实测经验（来自同行实践） |
|---|---|---|
| `submit_answer` | 点提交并用轮询等结论（默认等 20 秒，可调到 120） | 提交前先读一次旧结论、关掉上一次的弹窗；按文字分三级找按钮——**真按钮精确匹配 → 真按钮包含匹配 → 退到 `a/[role=button]/div[class*=btn]`**，顺序不能反（PTA 登录页上「登录」既是标签页又是按钮，按 DOM 顺序会点错） |
| `read_judge_result` | 读当前判题结论，不点任何东西 | 「出结论」要同时满足 **文字非空 ∧ 与提交前不同 ∧ 能归一化成状态码**——只看「变了」会把「评测中」当结论，然后把还在评测的弹窗关掉，这次结果永远等不到 |
| `close_dialogs` | 关掉挡在页面上的弹窗 | ESC → 在**识别出的弹窗容器内部**找关闭控件 → 点文字按钮（关闭/确定/我知道了/取消）→ 最多三轮（关一层常常还压着一层）；拿到结论之后才关 |

判题状态归一化的顺序即优先级：先 `(AC|WA|RE|TLE|MLE|CE|PE|OLE)`，再中文词表，而且**具体状态排在泛化词前面**（否则「编译错误」会被当成「错误」报成 WA，模型就会一直改算法而不碰那句语法错误），否定词也排在肯定词前面（避免「未通过」被当成「通过」）。

还没做：`switch/case` 的收尾缩进重排（同行做法的第 ⑤ 步）。

## PTA 页面适配备忘（v0.7 用）

来自同行实践（`other_pta.md`）的实测经验，v0.7 做「获取题目要求 / 获取用户代码 / 覆写用户代码」时直接用：

- **作答区**就是 CodeMirror 6：`.cm-content` + `isContentEditable` 过滤 + 取最长者（已用在 `simulate_keyboard_input` 与 `read_editor_code` 里）；能摸到编辑器实例时优先用它（读全文、写是原子的）
- **只用真实键盘事件**：PTA 的 `onpaste` 是平台反抄袭控制，实测「写剪贴板 + 真 Ctrl+V」编辑器纹丝不动，键盘是唯一通道
- 题面抠取：已实现在 `read_problem` 里（见上一节）；**宁可读得糙，不能读不到**
- 题面解析：按行分桶（小标题中英文双份词表 → description / inputFormat / outputFormat / constraints / 样例），样例按编号配对；一个桶都没开就把原文当描述交出去，**不抛异常**（PTA 结构会变，登录页也可能被当成题目页）
- 题目 ID：从 URL 末段取纯数字段（`.../problems/1150901824503297/description`）
- 语言识别：下拉框当前项 text/value、`.cm-editor/[data-language]` 上的属性；**不要扫全页找「C」字样**，认不出就如实标未知并把候选带给模型
- CM6 自动闭合的「幻影」：括号引号一律逐字敲，敲之前先探针读光标右侧——是期望的闭合符就 `ArrowRight` 跨过去，用不上就 `Delete` 抹掉；换行前必须先把批次 flush 出去并抹掉行尾幻影，否则被顶到后面某一行
- 缩进：不能「要删 N 格就按 N 次 Backspace」（光标在纯前导空白上时一次删光整段缩进）；用探针按一下回读一次；`Home` 是行首绝对 0 列且异步生效；C 的缩进服务会在 Enter 后回头重排 `case/default`，只能整体敲完再统一扫一遍
- 探针要读到 `.cm-line` 末尾（语法高亮会把行切成多个 span），并用「列号 ≤ 行文本长度」自检陈旧 DOM，破坏性按键遇到 stale 一律跳过
- 长文档（>50 行）：CM6 只渲染视口附近的行，整篇回读不可信，要切 ≤45 行一段分别校验
- 判题状态归一化：先匹配 `AC|WA|RE|TLE|MLE|CE|PE|OLE`，再走中文词表；**顺序即优先级，泛化的「错误」必须排最后**（否则「编译错误」会被报成 WA，模型就只改算法不碰语法）
- 提交与等待：先点掉遮挡弹窗，按文字在真 `<button>` 里精确匹配再包含匹配；等结论要同时满足「文字非空 ∧ 与提交前不同 ∧ 能归一化成状态码」（只看「变了」会把「评测中」当结论）；拿到结论后才关弹窗，没出结论绝不关
- 工具按名字去重：同名工具在基础工具集与会话工具集里语义可能不同，桥接时会「后者覆盖前者」，去重选错的话模型自己的代码从头到尾没被编译过

开发计划
v0.1
先把插件的基础环境打好，把ui写好
v0.2
接入ai-agent，实现单轮流式聊天
v0.3
让ai可以多轮进行追问，可以实时渲染出ai生成的markdown
v0.4
让ai接入
js_inject 直接注入JS代码到浏览器。
date 获取当前日期
url 获取当前页面的url
编写文档并下载到用户的浏览器
这几个工具
v0.5
让ai可以模拟键盘输入，让ai调用simulate_keyboard_input工具
v0.6
让ai可以编译c语言并运行
complie_and_run_C 编译并运行C语言代码
v0.7
让ai适配PTA
获取题目要求。
获取用户代码。
覆写用户代码。
v0.8
继续打磨ui