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
public/engine/          内置 C 编译器：Clang/LLD 的 wasm + sysroot + WASI 运行时（见该目录 README）
public/avata.jpg        作者头像：设置页作者卡片与底部署名用（走 web_accessible_resources + runtime.getURL）
scripts/
  fetch-engine.mjs      下载编译器的三大资源（约 91MB，build 前自动跑一次）
  gen-icons.py           生成 public/icons 下的图标
  package-firefox.mjs    把 dist/firefox 打成无签名的 xpi（npm run package:firefox）
  package-chrome.mjs     把 dist/chrome 打成 zip（npm run package:chrome）
  zip.mjs                两个打包脚本共用的手写 zip 实现（固定时间戳，可复现打包）
  test-diff.mjs          diff 引擎：行配对、行号、颜色分类、超大输入降级
  test-compile.mjs       内置 C 编译器：真实引擎编译运行 + 样例比对
  test-deepseek.mjs      假的 fetch 跑 SSE 解析与错误映射
  smoke.mjs              jsdom 冒烟测试：清单完整性、悬浮窗、流式对话、设置页
```

## 开发与调试

```bash
npm install
npm run build      # 类型检查 + 产出 dist/chrome、dist/firefox
npm run test       # SSE 解析校验 + 冒烟测试（冒烟测试需要先 build）
npm run icons      # 重新生成图标（需要 python3 + Pillow）
npm run package            # 两个浏览器各打一个包（dist/pta-assistant-v1.0.xpi 与 .zip）
npm run package:firefox   # 只打 Firefox 的 xpi（无签名）
npm run package:chrome    # 只打 Chrome 的 zip（上传应用商店 / 给用户手动解压安装）
```

需要 Node 22.18+（`scripts/test-deepseek.mjs` 直接跑 TS 用的类型擦除）。

构建脚本刻意不删产物目录本身（只让 Vite 清空目录内容）：目录被删掉重建后，浏览器里已加载的插件还指向旧目录，刷新时会报「File path cannot be resolved / 无法加载清单」。遇到这个报错就把插件「移除」再重新加载一次。

加新依赖时注意：Chrome 会用 `base::IsStringUTF8` 校验脚本，Unicode 非字符（U+FFFE / U+FFFF 之类）会被判成「不是 UTF-8 编码」而拒绝加载整个插件，但 Python / Node 的严格解码都会放行，很容易查半天。构建里已经统一把非字符转义成 `\uXXXX`（必须在压缩之后做），冒烟测试也会检查。

加载方式：

- Chrome：`chrome://extensions` -> 打开「开发者模式」-> 「加载已解压的扩展程序」-> 选择 `dist/chrome`
- Firefox（开发）：`about:debugging#/runtime/this-firefox` -> 「临时载入附加组件」-> 选择 `dist/firefox/manifest.json`
- Firefox（发给别人）：`npm run package:firefox` 打成 `dist/pta-assistant-v1.0.xpi`（无签名），
  对方同样在「临时载入附加组件」里选这个 xpi 文件即可
- Chrome（发给别人）：`npm run package:chrome` 打成 `dist/pta-assistant-v1.0.zip`。**Chrome 不允许直接加载
  压缩包**，要先解压，再在开发者模式里「加载已解压的扩展程序」选那个文件夹；想让用户一键安装只能上传
  Chrome 应用商店（需要自己的开发者账号 + 5 美元注册费），zip 里 manifest.json 就在根目录，符合商店要求

产物名跟面板徽标一致，而清单里的 `version` 仍是数字 `1.0.0`（Chrome 不允许清单版本号带 `alpha`/`beta` 后缀）

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
- 设置页（右上角齿轮）：API Key、接口地址、模型名；默认现在是**硅基流动** `https://api.siliconflow.cn/v1` + `deepseek-ai/DeepSeek-V4.1-Flash`（早先默认是 DeepSeek，改接口只改设置页，不用改代码）
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
- 真实按键是**逐字发按键**（`Input.dispatchKeyEvent` type=char，默认 8ms 间隔），不走剪贴板、也不直接改 DOM
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
- **真实按键一律走调试器**：模型调 `simulate_keyboard_input` 时固定走 `chrome.debugger` 发 CDP 事件（`Input.insertText` / `Input.dispatchKeyEvent`），事件是 trusted 的，编辑器与浏览器默认行为都会响应。**没有开关了**（旧的「用调试器发送真实按键」已删）：要真按键的方案本来就该用调试器，不该被一个默认关的开关挡住；默认的整段写入方案根本用不到调试器。先让页面聚焦并选中原内容，输入完立刻断开调试器，横幅只在输入的那几秒出现
- 调试器用不了时（该标签页开着 DevTools、或浏览器不支持）会自动退回模拟事件，并在工具结果里说明原因
- **输入后回读确认**：按键是异步生效的，不回读就是假成功。回读 CodeMirror 时按 `.cm-line` 的 `textContent` 拼行（读 `innerText` 会多吐一个尾部换行，导致比对整体错位一行），比对结果（一致 / 第几行不一致）会写进工具结果给模型看

已知限制（`simulate_keyboard_input`）：

- 还没有实现同行做法的「收尾统一扫缩进」（敲完 `Ctrl+Home` 逐行重排）：C 的缩进服务会在按 Enter 后回头重排 `case`/`default` 对齐，这类情况现在只能靠回读比对报出「第 X 行不一致」，模型看到后可以再来一次

- 调试器输入失败时会退回模拟事件，退回后按键是**未信任事件**：浏览器默认行为不会发生（回车不换行、表单不提交），只对页面自己写的按键监听有效
- 用调试器输入的那几秒：那个标签页会显示「正在调试此浏览器」横幅，且此时**不能打开开发者工具**（两者抢占同一个调试器）；扩展需要 `debugger` 权限，重新加载时要在扩展页确认一次
- 目标元素需要有明确的 CSS 选择器；模型会先用 `js_inject` 确认结构（系统提示里要求它这么做）

已知限制：

- `js_inject` 依赖 host 权限：需要先用工具栏图标打开过悬浮窗（这时才拿到该标签页的 activeTab 授权）
- 页面如果 CSP 很严（不允许动态脚本），`js_inject` 会失败并把原因回灌给模型；PTA 站点没有任何 CSP，正常可用
- content.js 因为带上了 markdown + KaTeX 涨到 690K（gzip 205K），首次注入会有一点开销
- 若页面极其严格地限制字体（`font-src`），公式可能退回系统字体显示，结构仍然正确
- 依赖里 katex@0.16 有一条「原型污染绕过 trust 限制」的低危通告，我们没用 `trust` 选项，且输入来自模型而非攻击者

## v0.8 已完成（界面打磨）

- **面板可拖动、可改大小，布局记住**：拖标题栏移动、拉右下角把手改大小；位置与尺寸一起存在 `chrome.storage.local`（`pta-assistant-panel-layout`），刷新页面还在；两者都会被夹在视口内，小到 360×320 就夹住。默认仍然是固定右上角的 420×620
  - **恢复默认有两条路**：双击标题栏，或**双击工具栏的插件图标**（两次点击间隔 ≤400ms 算双击；第二下只发复位消息、不再开关面板，所以窗口不会开完又关掉）
- **智能滚动**：用户往上翻看的时候不再把视图拽回底部（以前每来一个流式字符都会跳到底部）；离开底部时右下角出现「↓ 回到底部」
- **工具卡片**：可以折叠/展开（长代码、长输出不再一直占屏），代码与结果各有「复制」按钮（用 `execCommand` 复制，不需要额外权限）
- **设置页的「模拟输入测试」（v1.0 起默认隐藏，代码保留）**：一个文本框 + **一种写入方法一个按钮**（共 17 种，按四组排布），点哪个就用哪种方式把文本框内容写进当前页面的作答区（覆盖内容、不提交）。结果回显含三件事：回读比对（一致/第几行不一致）、**页面是否弹了「禁止粘贴」这类提示**、用的哪种方法。测试成功后该按钮会标 ✅ 并记进 storage，旁边显示「当前可用方法」
  - **CDP 那几个方法不需要设置页开关**，一律直接尝试，挂不上调试器就如实报错
  - **实测结论（2026-10-14，PTA 真实页面）**：只有「**整段 dispatch**」成功，其余（CDP 逐字真按键 / CDP keyDown+text / CDP 整段插入 / CDP 点击后按键 / execCommand / 手工输入事件 / 改 DOM / 输入法事件链 / paste 事件 / value setter / 剪贴板+Ctrl+V / 剪贴板+execCommand(paste)）都被页面拦下并弹「禁止粘贴」。`write_editor_code` 工具走的正是「整段 dispatch」
  - 17 种方法分组：**编辑器状态（CM6 API）**：整段 dispatch / 先 focus 再 dispatch / dispatch + 标注输入 / replaceSelection / 逐行 dispatch；**CDP 真实输入**：CDP 逐字真实按键 / CDP 真实点击 + 逐字按键 / CDP keyDown+text 逐字 / CDP 整段插入；**DOM 与事件**：execCommand / 手工派发 beforeinput+input / 改 DOM + 派发 input / 模拟输入法事件链 / 手工派发 paste 事件 / 原生 value setter；**剪贴板**：剪贴板 + 真 Ctrl+V / 剪贴板 + execCommand(paste)
- 版本号同步到 0.8.0

## v0.9 已完成：内置 C 编译器（不需要外部服务）

工具 `compile_and_run_c` 现在**完全在插件本地编译运行**：不联网、代码不出本机、不用配任何服务地址。
（v0.8 及之前走 Judge0 在线编译服务，设置页那两个「编译服务地址 / 编译语言 ID」随之删掉了。）

**怎么做到「内置」**：把 Clang 22.1.8 + wasm-ld（LLD）+ wasi-sdk 33 的 sysroot 全部编成 WebAssembly 塞进插件，
整套引擎跑在 Web Worker 里：

| 环节 | 做法 |
|---|---|
| 编译 | `clang -cc1 -emit-obj`，C 头文件来自 sysroot 的 `include/wasm32-wasip1` |
| 链接 | `wasm-ld` 链接 `crt1.o` + `libc.a` + `libclang_rt.builtins.a`，产出用户程序的 .wasm |
| 运行 | 用 JS 实现的 WASI shim 跑这个 .wasm：stdin 预喂（题目的样例输入）、stdout / stderr 分开收集 |

资源约 91MB（`public/engine/`），三个大文件不进 git，`npm run build` 会先跑 `scripts/fetch-engine.mjs`
从固定的 Release 下载并 sha256 校验（只需一次，之后永久离线）。

几个实现上的取舍：

- **Worker 而不是直接跑**：编译+运行是同步 CPU 密集任务，更重要的是——学生写错边界条件容易写出**死循环**，
  wasm 里没有任何协作式检查点，唯一能停下来的办法就是 `worker.terminate()` 整个杀掉再重建
- **Chrome 用 offscreen 文档承载 Worker**：MV3 的 service worker 里建不了 Worker；Firefox 的 background 是
  event page，直接 `new Worker`。编译期间后台每 20 秒戳一次扩展 API，防止 service worker 被按空闲回收
- **阶段化超时**：编译+链接 60 秒（首次含引擎加载），运行 10 秒，超时就杀 Worker 并汇报「运行超时（多半是死循环）」
- **用 noeh 版 clang/lld**：标准版有一条 exnref 指令要 Chrome 125+，剥掉它之后 Chrome 63+ / Firefox 115+ / 各种国产内核 WebView 都能跑
- **必须在 manifest 里放行 wasm**：MV3 扩展页默认 CSP 是 `script-src 'self'`，不含 wasm 权限，
  offscreen 文档属于扩展页，它里面的 Worker 调 `WebAssembly.compile` 会被直接拦下
  （报 "violates Content Security Policy directive: script-src 'self'"）。manifest 里写的是
  `script-src 'self' 'wasm-unsafe-eval'`，Firefox 只认字符串形式，构建时和 offscreen 权限一起打了补丁
- **语义参照 PTA 判题机**（GCC），和桌面 clang/gcc 一致，而不是自己实现一个解释器：自测通过不等于提交能过，但至少不会因为编译器方言吃亏
- 引擎来源 [cppstudio-io/wasm-clang-runtime](https://github.com/cppstudio-io/wasm-clang-runtime)（Apache-2.0，其前身是 binji/wasm-clang），
  `shared.js` 改成了 C 专用（原版硬编 C++）、补了 stderr 分流；详见 `public/engine/README.md`

汇报文案沿用原来那套：编译错误原样带回 clang 诊断（含行列）、运行区分「崩溃 / 非零退出 / 超时」、输出过长会截断。
版本号同步到 0.9.0。

## ask / diff：改代码前先问，改完给你看

### ask 工具（选择题）

模型需要用户拍板时调用 `ask(question, options)`：面板的工具卡片上直接出选择题，点一下就回传给模型，
这一轮会一直挂在等作答（面板顶上同时有进度条）。选项点了之后卡片变成「已选择：…」。

- 消息链路：`chat/ask`（后台 → 面板）+ `chat/ask-answer`（面板 → 后台），用 `callId` 对上号
- 用户点「停止」或者这一轮结束时，后台会把没答完的 ask 解掉（返回「用户已停止这次提问」），
  不会把 agent loop 挂死
- 系统提示里的硬规矩：**用户没有明确要求改代码时，`write_editor_code` 之前必须先 ask 一次**；
  用户选了「先别改」就停下讲思路，不许再动他的代码

### diff 工具（左右两列对照）

模型把改动前后的文本交给 `diff(left, right)`，工具卡片里渲染成左右两列，行级配色：

| 类型 | 表现 |
|---|---|
| 相同 | 灰色，两列都在 |
| 修改 | 左列红底删除线、右列蓝底 |
| 新增 | 只在右列，绿底 |
| 删除 | 只在左列，红底 + 删除线 |

- 逐行 LCS 比较（`src/shared/diff.ts`）：先掐掉公共前后缀，中间段做动态规划，
  连续的「删除 + 新增」两两配对成「修改」；改动规模超过 600×600 行时降级成整体增删，别把界面卡住
- **界面照 IDEA 的 diff 做**（`src/content/components/DiffView.tsx`）：
  - 左右两列 + **中间一条道**：行号夹在两边，改动块的头尾画 `»` / `«`，中间一条竖线把一次改动圈成一团
  - 改动聚成一块一块（`segmentDiff`），没动的上下文压暗；超过 6 行的上下文先折叠成「⋯ 还有 N 行没改动，点开」
  - 颜色：新增只在右列绿底、删除只在左列红底、修改左红右蓝；再配一行**词级高亮**（`markWordChanges`，
    例如 `scanf("%d", a);` → `scanf("%d", &a);` 只把 `&` 标出来），整行都被重写时不做词级高亮（会糊成一片）
  - 左右行不许折行（折行会让两列看着错位），面板太窄时横向截断，悬停能看到整行
  - 卡片标题行显示「新增 N · 修改 N · 删除 N」，右上角有「复制新代码」
- 工具返回给模型的是同一份统计（模型据此在回答里复述），两栏原文只在面板里显示
- 系统提示里的硬规矩：**改完代码必须调用 diff**，不要只在回答里用文字描述改了什么

### 顶栏的 token 计数

- 请求体带 `stream_options: { include_usage: true }`（DeepSeek / 硅基流动这类 OpenAI 兼容接口认），
  最后一帧回传的 `usage` 在 **agent loop 里累加**（一轮对话往往要多次请求模型），每轮结束推给面板
- 标题栏右侧常驻显示 `Token 总数（输入 x / 输出 y）`；接口不回传 usage 的兼容实现会退化成
  `Token ≈ n`，按中英文字符粗估**当前这一轮**的输出（中日韩字符算 1 个，其余 4 个字符算 1 个），流式过程中数字会动
- 「新会话」会把计数清零

### ask 的超时与「选了却没反应」

ask 以前没有超时：用户不点，这一轮就永远挂着；而且点完选项只是本地标记，后台若已经不等了（超时、
点了「新会话」、上一轮已结束），用户会看到「选了，但模型再也没说话」。现在三件事：

- **120 秒超时**：等不到作答就按「用户没有作答」继续这一轮，并在聊天区提示一句，不把 agent loop 挂死
- **作答要后台确认**：面板点选项后等后台回执；被拒绝就把卡片恢复成可点并提示「这次提问已经结束」，
  不再假装选上了
- **空输出兜底**：模型整轮一个字都没吐时给提示（原来空气泡不渲染，看起来就是卡死）

### 进度条与更矮的工具卡片

- 生成中（包括等用户回答 ask）、正在写作答区时，面板顶部有一条 4px 的无限循环进度条；
  `prefers-reduced-motion` 下放慢到 3 秒
- 工具卡片**默认收起**，只有一行（工具名 + 参数摘要 + 状态）；展开后代码区最高 140px、字号 11.5px、
  行高 1.45，减少滚动。`ask` 与 `diff` 两种卡片默认展开（不然没法选、也看不见改了什么）

## 面板快捷通道：「输入」与「新会话」

两个不走 AI 的即时通道，都是用户直接点的按钮：

### 「输入」按钮（发送按钮左边）

**起因**：有用户反馈 PTA 禁粘贴，而设置页里的「模拟输入测试」实测能绕过去，于是把它从「测试」变成日常可用的快捷通道。

- 点一下就把输入框里的文本**整段写进作答区**，写成功后**清空输入框**；写入失败时输入框内容保留，方便改完再试
- 走的是 `write_editor_code` 工具同一条链路（`src/background/input-methods.ts` 的 `writeEditorCode`）：默认实现 → 回读比对 →
  不一致就清空并按备用顺序（`replaceSelection` → CDP 真实点击 + 逐字按键 → 整段 dispatch）重试，四种全败才报错
- **不经过模型**：面板直接把文本发给后台（`code/input` 消息），不占用 API Key、不产生对话气泡、不污染上下文
- 结果（成功说明 / 失败原因）回显在聊天区上方的提示条上
- 输入框为空、只有空白、或正在生成时按钮禁用（生成中先点「停止」）

### 「新会话」按钮（标题栏右上角）

用户做下一题时不需要上一题的上文，而插件的对话历史原本只能靠刷新整个页面清掉。

- 点了就把对话清回只剩欢迎语，同时清掉提示条；不用刷新页面、不用重开悬浮窗
- 还在生成时点它，会先给后台发 `chat/stop` 把那一轮掐掉；那一轮迟到的流式增量因为请求号已失效，不会再冒出来
- API Key 与所有设置不受影响

## v1.0：默认接口、面板尺寸与设置页

- **设置页顶部作者卡片**：圆角矩形卡片，左边是矩形圆角头像（`public/avata.jpg`，跟着构建进 dist 并加进
  `web_accessible_resources`，设置页用 `ext.runtime.getURL` 取），右边是大字昵称 `OCTest`、
  下面一行小字邮箱 `octestwx@qq.com`，再下面是可点的网站链接 `octestpi.top`（点开走后台开新标签页）
- **默认接口换成硅基流动**：`https://api.siliconflow.cn/v1` + `deepseek-ai/DeepSeek-V4.1-Flash`（`manifest` 的 `host_permissions` 已放行该域名；DeepSeek 的权限保留，切回去只要改设置页）
- **「教程」按钮**：接口地址输入框右侧，下面写着「怎么配 Key、怎么用，看教程」；点它由后台开新标签页去
  `http://octestpi.top/pta-assist-plugin`（content script 没有开标签页的权限；后台只放行 `http(s)`，
  不让它变成任意开页面的入口）
- **版本号**：标题栏徽标 `v1.0`（manifest 的 `version` 仍是数字 `1.0.0`——Chrome 的清单版本号不允许带后缀，带了装不上）
- **面板能改大小了**：右下角把手拖拽调整，宽高与位置一起存（`pta-assistant-panel-layout`），刷新还在，夹在 360×320 与视口之间；老版本只存过位置的 key 会顺手删掉
- **双击插件图标恢复默认位置与大小**：后台把间隔 ≤400ms 的两次点击认成双击，第二下只发 `panel/reset-layout` 而不再开关面板
- **删掉「用调试器发送真实按键」开关**：`simulate_keyboard_input` 一律走调试器（attach 失败照旧退回模拟事件）。旧版本存过的这个字段在读设置时会被丢掉
- **「模拟输入测试」整块对用户隐藏**：那是排查 PTA 禁粘贴时的调试按钮组，普通用户用不到。
  代码全部保留，由 `SettingsPanel.tsx` 顶部的 `SHOW_INPUT_METHOD_TESTS` 控制，改成 `true` 就恢复显示
- **接口地址下面那句「要改 host_permissions」的提示已从界面移除**（属于开发者的事，写在 README 里就够了）

## PTA 三件套（原计划 v0.7，提前做了）

三个工具都在**页面主世界**执行（编辑器实例挂在页面自己的 JS 对象上，隔离世界看不到），走的是已有的主世界注入器：

| 工具 | 做什么 | 实现 |
|---|---|---|
| `read_problem` | 拿到当前题目的题面 | ① 按类名找，但**遍历所有匹配**而不是只取第一个（只取第一个的话，文本太少的那个会把整个选择器废掉）；② 类名对不上时**按小标题定位**：同时出现「题目描述/输入格式/输出格式/样例输入/样例输出」里两个以上的**最小**容器；③ 都失败才退整页正文，并从第一个小标题开始截断、滤掉「上一题/下一题/图例/Toggle Sidebar/复制」这类纯 UI 文案行；④ 顺手把样例抠成「输入/输出」成对返回，可以直接当 `compile_and_run_c` 的 stdin |
| `read_editor_code` | 读作答区里的代码 | 题面的「输入样例/输出样例」**也是 CodeMirror**（`contenteditable="false"` + `aria-readonly="true"`），所以先收集所有编辑器实例、**剔除只读的**，再在可写的里面取内容最长的；用 `view.state.doc` 读完整文档；只有只读实例时会明确说「只有样例框、没有作答区」而不是含糊报「编辑器是只读的」 |
| `write_editor_code` | 改作答区里的代码（默认整段覆写） | 同样跳过只读样例框；优先 `view.dispatch({changes})` **原子写入**并**把光标留在文末**；退路是聚焦 + 全选 + `execCommand('insertText')`；两条路都**回读比对**。写完还会**自动检查**（`verify` 参数，默认开）：① 回读逐行比对；② 拿题面**第一组样例**编译并比对输出（"样例 1 输出一致" / "不一致——第 1 行不同：期望「7」，实际「8」" / "编译失败——…"）；③ 报告**提交按钮现在可用不可用**（确认页面认了这次修改）。写完还会**用真实按键敲一个空格再退格**，触发页面的修改标记（敲不动就在结果里说明，让用户手动敲一个字符） |

编辑器实例不在公开 API 上，只能顺着 DOM 摸：先在 `#pta-answer-editor / .cm-editor / .cm-content` 及其祖先上找 `cmTile.view / cmView / editorView / view / _view`（PTA 用的是 `cmTile.view`），再退一步扫自身属性找「有 `state.doc` + `dispatch`」的对象，找到后把路径一并写进结果里。

系统提示里也把优先级写死了：读题面用 `read_problem`、读代码用 `read_editor_code`、改代码用 `write_editor_code`，**不要**用 `js_inject` 去 dispatch 编辑器、改 `input.value`、或想办法模拟粘贴。

### PTA 收尾：提交与判题

| 工具 | 做什么 | 实测经验（来自同行实践） |
|---|---|---|
| `submit_answer` | 点提交并用轮询等结论（默认等 20 秒，可调到 120） | 提交前先读一次旧结论、关掉上一次的弹窗；按文字分三级找按钮——**真按钮精确匹配 → 真按钮包含匹配 → 退到 `a/[role=button]/div[class*=btn]`**，顺序不能反（PTA 登录页上「登录」既是标签页又是按钮，按 DOM 顺序会点错）。提交期间挂上判题观察器，把弹窗里出现过的文字存进页面快照 |
| `read_judge_result` | 等到并读出判题结论，不点任何东西（默认等 60 秒，可调到 120） | 每 **0.3 秒**重读一次页面，直到**文字非空 ∧ 能归一化成状态码**为止——只看「变了」会把「评测中」当结论，然后把还在评测的弹窗关掉，这次结果永远等不到。用户可能在结论出来之后、模型来读之前就把弹窗关掉，所以每次读到的文字都记在 `__ptaJudgeSnapshot` 里（由页面里的 `MutationObserver` 持续更新，合并 300ms 内的连续 DOM 变化），弹窗没了还能回看最后一次结论，并明确标注这是页面上的判题记录 |
| `close_dialogs` | 关掉挡在页面上的弹窗 | ESC → 在**识别出的弹窗容器内部**找关闭控件 → 点文字按钮（关闭/确定/我知道了/取消）→ 最多三轮（关一层常常还压着一层）；拿到结论之后才关 |

「停止」按钮对这两条等待中的工具同样有效：后台把 `signal` 一路传到 `injectScript`，中止时先往页面里置 `__ptaAborted = true`（`executeScript` 撤不回来，只能靠页面里的循环自己看标记），页面里所有等待都走 `sleepOrAbort`（最多 100ms 一醒），后台这一侧同时和 abort 赛跑、不再等页面返回。工具收尾照常发 `chat/tool-end`（内容是「已停止」），所以面板上的工具卡片不会一直转圈；随后 agent loop 直接按中止结束，不再喂下一轮模型请求。

判题快照只在**页面上已经读不到任何判题文字**时才用来兜底（弹窗被关掉了）：只要页面还挂着「评测中」这类中间状态文字，就说明这次还在评测，这时宁可继续等，也不返回上一条旧结论——错报结论比不报更糟。重新提交会清空快照。观察器的开头那次读不受防抖限制（结论可能只活几十毫秒），防抖只用来补尾部那一次。

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