# PTA 助手

> 本项目完全使用 AI 开发，作者只起到充钱和测试的作用。

PTA 助手是一个运行在浏览器里的 PTA（拼题A）解题助手：自带 agent loop、本地编译器和完整的页面适配，支持 Chrome / Edge / Brave / Vivaldi / Opera / Firefox / Zen。

- 插件下载与教程：**<https://me.octest.top/pta-assist-plugin>**
- 作者主页：**<https://me.octest.top>**
- 代码仓库：[GitHub](https://github.com/OCTestX/pta-browser-plugin) · [Gitee](https://gitee.com/octestx/pta-browser-plugin)

> **本文档描述的是当前源码树的真实状态。** 改动功能时请同步改这里：插件的行为由本文档、提示词（`src/shared/tools.ts` 的 `SYSTEM_PROMPT`）和代码三者共同决定，任何一处说错，AI 就会按错的认知去动手。

## 功能

| 能力 | 说明 |
|---|---|
| 对话 agent loop | 请求模型 → 执行工具 → 回灌结果 → 再来一轮，最多 80 轮 |
| 本地编译器 | **C / C++**（Clang 22 wasm + libc++）、Python（Pyodide 0.26）、JavaScript 全部在本机运行，代码不出本机 |
| 借用 PTA 的运行环境 | Java、Go、C#、Rust 等没有内置编译器的语言，用 `simulate_pta_run` 在 PTA 上真跑一遍并读回结果 |
| 强制用 PTA 跑（可选） | 设置里可以强制把内置编译器的调用改走 PTA 自己的编译器与机器，编译错误也从 PTA 的「编译器输出」里读 |
| 读取 PTA 的编译错误 | `read_pta_compile_result` 读页面上的「编译器输出」（输出、异常堆栈、编译错误） |
| 禁粘贴也能贴 | 接管 `Ctrl+V` / `⌘V`，读剪贴板后走插件自己的写入链路；抢不过页面时用 `Ctrl+M`；右键粘贴同样接管 |
| 粘贴焦点判定 | 只有焦点在 PTA 的可写作答区里才接管，别的地方照常粘贴 |
| 视觉模式（VLM） | 题面含图片时把图片作为 `image_url` 发给支持看图的模型；不支持时明确降级纯文本；模型下拉用 eye icon 标出视觉能力 |
| 提交后自动刷新 | 等待判题结论时，只点**判题弹窗内**的「刷新 / Reload」；弹窗里没有就不点，绝不整页刷新 |
| 多标签页独立 | 面板开关、agent 会话、图标节流都按标签页隔离，可以同时开好几个 |
| 检查更新 | 设置页顶部比对 GitHub / Gitee 的 release 标签，有新版本就提示 |
| API Key 防误填 | Key 输入框关掉自动填充，密码管理器不会把 PTA 的密码套进来 |
| 快捷键 | `Alt+G` 打开悬浮窗并把光标放进输入框，`Esc` 关闭悬浮窗 |
| diff 全屏 | diff 卡片可在新标签页显示完整改动，不折叠没改动的行 |
| 公式与 Markdown | 流式渲染 Markdown、表格与 KaTeX 公式 |
| 随时停止 | 模型流、页面脚本、编译、逐字输入、写入作答区都能被「停止」打断 |
| 对话持久化 | 按标签页存进 `sessionStorage`，刷新不丢；同一题开两个标签也互不串 |
| 斜杠指令 | 输入 `/` 列出可用指令，上下键选、回车发送：`/new` `/resolve` `/what` `/why` |
| 连按回车开新会话 | 输入框空着的时候连按三次回车，直接开新会话 |
| 选择题 / 判断题 | 读题面会报题型并列出全部小题；答案用空格分隔填进单选框 |
| 苏格拉底式讲解页 | `/what` 生成可交互的单文件 HTML，插件给一张「打开讲解页」的邀请卡片 |
| 赶题模式 | `/fuck` 不问不解释直接提交，做完自动切下一题，一路做到题单走完 |
| Tab 补全 | 输入 `/` 后可以用 Tab 补全选中的指令 |
| 整理代码 | 作答区底部状态栏（「Test Case」右边）一个按钮：按语言重排缩进、在运算符两侧补空格（`7*2` → `7 * 2`）、无花括号的 `if`/`for`/`while` 体缩进一层；字符串和注释里的内容不动 |
| 彩虹括号 | 作答区里的括号按嵌套层级上色并加粗，配对的左右括号同色 |
| 实时语法检查 | 停手 0.35 秒后检查：C/C++ 用内置 clang `-fsyntax-only`，Python3 用内置 Pyodide `compile()`；Java 只做规则检查。**只有 error 画红色波浪线**（warning 只进计数），状态栏显示「N 个错误」，悬停给出中文修改建议 |
| 标准库中文注释 | 鼠标停在 `printf` / `malloc` / `sqrt` 这类 C 标准库函数名，或 `vector` / `sort` / `push_back` 这类 C++ STL 名字上，显示原型、作用与常见坑 |
| 上下文进度 | 顶栏一个小圆环显示上下文填充比例，token 明细停在圆环的提示里；窗口大小用模型真实值（接口或 models.dev 数据集查得），查不到才按模型名估算 |

## 安装

插件没有签名，浏览器不会自动安装。下载页：<https://me.octest.top/pta-assist-plugin>。

三条规则：

1. **Chromium 系只认文件夹**：把 zip 解压，在扩展管理页选「加载已解压的扩展程序」；直接选 zip 会报「无法加载清单」。
2. **Firefox / Zen 可以直接选 xpi**：`about:debugging` 里临时载入；关掉浏览器就失效。
3. **选对层级**：要选里面有 `manifest.json` 的那一层，别选到套了两层目录的。

### Chrome / Edge / Brave / Vivaldi / Opera

1. 打开下载页，下载 Chrome 版 zip 并解压
2. 打开扩展管理页（Chrome：`chrome://extensions`，Edge：`edge://extensions`）
3. 打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中解压出来、里面有 `manifest.json` 的文件夹
5. 点工具栏拼图图标，把「PTA 助手」固定出来

### Firefox / Zen

1. 下载 Firefox 版 xpi
2. 地址栏打开 `about:debugging#/runtime/this-firefox`
3. 点「临时载入附加组件…」，选择 xpi
4. 工具栏拼图图标里找到「PTA 助手」并固定

临时载入的插件在浏览器重启后失效，需要再载入一次；想要长期生效需要签名版本。

## 使用

> 自 v3.1 起**已移除全页面最大化模式**，所有操作都在悬浮窗与 diff 全屏标签页里完成。

### 打开悬浮窗

| 操作 | 行为 |
|---|---|
| 点工具栏的 PTA 助手图标 | 开关悬浮窗 |
| **`Alt+G`** | **打开悬浮窗，并把光标直接放进输入框**——按完就能立刻打字，不用再点一下输入框 |
| **`Esc`** | **关闭悬浮窗**（面板没开着时不拦，页面自己的 Esc 行为保持原样） |
| 双击图标或双击标题栏 | 恢复默认位置与大小 |
| 拖标题栏移动、拉右下角改大小 | 位置与尺寸会被记住 |

`Alt+G` 在面板已经开着时按也一样：不会重复打开，只把光标送回输入框。

| 面板按钮 | 作用 |
|---|---|
| 新会话 | 清空对话上下文，连带清掉存盘的对话记录 |
| 发送 / 停止 | 发送消息；生成或写入途中可随时停止 |
| ⚙ | 进入设置 |
| × | 关闭悬浮窗 |

正在打开的页面如果是在安装插件之前加载的，刷新一次即可；`chrome://` 开头的内部页面不允许注入，属正常。

### 第一次配置

点面板右上角齿轮：

| 配置 | 说明 |
|---|---|
| API Key | 模型接口密钥，只保存在 background 里，页面上拿不到 |
| 接口地址 | OpenAI 兼容地址，默认 `https://api.siliconflow.cn/v1` |
| 模型 | 可手填，也可以点「选模型」从接口拉取列表 |
| 视觉模式 | 自动 / 开 / 关，见下 |
| 运行环境 | 内置 / PTA，见下 |

接口地址旁边有「教程」，打开的也是 <https://me.octest.top/pta-assist-plugin>。

**API Key 不会被密码管理器自动填**：输入框上关掉了浏览器自动填充，并标记成「请密码管理器忽略」，所以不会把你在 PTA 上用的密码误套进来。

### 斜杠指令

在输入框里打一个 `/`，下面会弹出指令列表（左边命令名、右边一句解释），上下方向键选、**Tab 补全**、回车发送：

| 指令 | 作用 |
|---|---|
| `/new` | 开新会话，清空当前上下文（面板里直接生效，不走模型） |
| `/resolve` | 直接答题：这一轮不用再问「要不要改 / 要不要提交」，自动写代码、跑样例、提交 |
| `/fuck` | 极限赶时间无人监管模式：不问、不解释、直接提交，做完自动切下一题接着做 |
| `/what` | 生成一份苏格拉底式的讲解网页（详见下） |
| `/why` | 讲解作答区里现在的代码错在哪里，只讲不改 |

输入框空着的时候**连按三次回车**也是开新会话（按第一次会提示「再按 2 次回车」）。开新会话时，上一轮如果还在跑会被**立刻停掉**，不会跟新对话交错。

`/what` 生成的讲解页是一份自包含的单文件 HTML：围绕这道题出 10–12 道选择题、分 4 个阶段推进，答错给分级提示、答对才给解释，再配一个可改参数的动态演示。生成完插件会显示一张「打开讲解页」的邀请卡片，点它在新标签页打开。

讲解页开在 **PTA 站点上的一个固定地址**（`pintia.cn/pta-assistant/explain?id=…`），地址栏里是正常网址，不是把几万字符的 HTML 塞进去。页面内容装在一个**沙箱 iframe** 里（不给 `allow-same-origin` → 不透明来源）：读不到 PTA 的 cookie、拿不到扩展权限，也碰不到 API Key；模型产的脚本照常能跑。

> 为什么不开在扩展页（`chrome-extension://…/explain.html`）？扩展页的 CSP 是 `script-src 'self' 'wasm-unsafe-eval'`，而 **Chrome 不允许**在扩展页 CSP 里写 `'unsafe-inline'`，`blob:` 脚本也被 `script-src-elem` 拦掉——扩展页里一行模型产的内联脚本都跑不起来，讲解页会只剩静态正文。

`/fuck` 是给「限时突击」用的：模型不再问你任何问题（连 `ask` 都会被自动答掉），写完直接提交，拿到判题结论就调 `next_problem` 切到题目列表里的下一题接着做，直到列表走完或者你按面板上的「停止」。一道题最多自己改两次，还不过就跳过继续下一题。

> **v6.0.0 已在真机跑通整条链路**：同一题型内切题、跨题型切换（代码填空 8/8 → 编程 14/23）、代码填空题（读作答区模板后补全）、跳过已提交的题（认真实考试页的 `PROBLEM_ACCEPTED` / `PROBLEM_NO_ANSWER` 状态）、走到题单末尾附本轮统计。剩下的欠账只有「还没有独立的总览面板 UI」和「代码填空题的样例提取会被裁判测试程序样例干扰」，见 `todo.txt`。

赶题模式会在题目之间来回跳，所以做了三件事保证它不中断：

- 换题是**前端路由跳转**，不会整页刷新（实测两种题型都是），悬浮窗和对话都还在；
- 插件自己的 `close_dialogs` 会往页面上派发一个合成的 Esc 来关 PTA 的弹窗，那个 Esc **不会**被当成「用户按了 Esc」把悬浮窗关掉；
- 万一页面还是被刷了，重新挂载的悬浮窗会问后台一句「这个标签页上有正在跑的那一轮吗」，接回去之后「停止」按钮照样按得动，对话记录也不会丢。

### 运行环境：内置编译器 vs PTA

插件自带 C / C++ / Python / JavaScript 四种运行环境（不联网、代码不出本机），但有些题目 PTA 的编译器版本和你本机的不同，或者题目语言压根没有内置编译器（Java、Go、C# 等）。设置里的「运行环境」可以二选一：

| 模式 | 行为 |
|---|---|
| 内置（默认） | `compile_and_run_c` / `_cpp` / `_python` / `_js` 用插件内置的编译器与运行器，在本机跑 |
| PTA | 这四个工具**改用 PTA 自己的编译器与机器**：插件把代码写进作答区，点 PTA 的「运行测试」，再把结果读回来；编译错误也从 PTA 的「编译器输出」里读 |

走 PTA 模式时，工具返回值开头会写明「已按设置改用 PTA 自己的编译器与运行环境」，免得 AI 把结果当成内置编译器跑出来的。

注意：走 PTA 模式会**覆盖作答区里的代码**（PTA 只能跑编辑器里那一份），并且每次调用都要真的在页面上点一次「运行测试」，比内置编译器慢。写代码前后的自动样例检查在 PTA 模式下也改用 PTA 跑。

### 视觉模式（VLM）

题目里有图片时，插件按设置决定要不要让模型「看图」：

| 模式 | 行为 |
|---|---|
| 自动（默认） | 读到的题面含图片占位才切视觉模式；没图就走纯文本 |
| 开 | 始终按视觉模式工作 |
| 关 | 始终按纯文本模式，不看图 |

**当前模型不支持看图时会主动提醒一次**：插件会明确告诉你「题面包含图片，但当前模型（xxx）不支持看图，已按纯文本模式处理」——这次运行是被强制降级的，题面里的图可能没被读进去，需要换一台看图模型或把视觉模式关掉。这条提醒只出现一次，不会反复刷屏。

### 粘贴：Ctrl+V / Ctrl+M

PTA 会拦截普通粘贴。插件**只在焦点位于 PTA 的可写作答区时**才接管粘贴，别的网站、别的输入框一律照常：

| 操作 | 行为 |
|---|---|
| `Ctrl+V` / `⌘V` | 读取系统剪贴板，在光标处插入；不触发页面的「禁止粘贴」 |
| `Ctrl+M` | 备用快捷键，`Ctrl+V` 被页面抢先拦掉时用 |
| 右键 / 中键粘贴 | 同样走内置粘贴（粘贴事件也接管） |

判断依据：事件落在 CodeMirror 编辑区里（`.cm-content`，任意网站），或落在 `pintia.cn` 上的可编辑元素里；只读编辑器（`aria-readonly="true"` 或 `contenteditable="false"`）不接管，所以题面里只读的样例框粘贴照常。

写入过程中页面底部会出现提示条。剪贴板读取失败时，content script 会转给 background（Chrome 用 offscreen 文档，Firefox 用 background 页的 DOM）。

自 v3.2 起**已移除面板的「输入」按钮**：把代码复制（`Ctrl+C`）后点进作答区，按 `Ctrl+V`（或 `Ctrl+M`）粘贴即可。

### 作答区增强（整理代码 / 彩虹括号 / 实时检查 / 函数注释）

作答区（PTA 的 CodeMirror）多了一组增强，摆在**代码框底部状态栏**（「Test Case」按钮右边的空白）和代码里，**不改动 PTA 自己的界面、也不挡代码**：

| 增强 | 行为 |
|---|---|
| 整理代码 | 按语言重排：C/C++/Java/JS 按花括号层级重排缩进（4 空格），Python 不动缩进、只统一 Tab/空格与空行；字符串、字符常量、注释里的内容一个字都不改 |
| 彩虹括号 | 括号按嵌套层级上色，配对的左右括号同色；字符串和注释里的括号不参与 |
| 实时语法检查 | 停手 0.35 秒后检查：C/C++ 送内置 clang 做 `-fsyntax-only`（只编译、不链接、不运行），Python3 送 Pyodide `compile()`（只编译、不执行），Java 做规则扫描；**只有 error 画红色波浪线**（warning 只进计数），状态栏显示「N 个错误」，悬停显示原文和中文建议 |
| 标准库函数注释 | 鼠标停在 `printf` `malloc` `strlen` `sqrt` 这类 C 标准库 / `string.h` / `math.h` 函数名上，显示函数原型、作用与常见坑 |

整理代码的具体规则（C）：

| 原文 | 整理后 |
|---|---|
| `int x=1;` | `int x = 1;` |
| `7*2` | `7 * 2` |
| `if(n==1)` | `if(n == 1)` |
| `if(n==1)`<br>`return 1;` | `if(n == 1)`<br>`    return 1;` |
| `int *p=&a;` | `int *p = &a;` |
| `x++;` / `*p` / `-1` | 原样（自增、解引用、一元负号不算二元运算符） |

三条边界，别被它误导：

- **实时检查覆盖 C / C++ / Python3 / Java**：C/C++ 引擎分别走 `-x c` 与 `-x c++ -std=c++17`（C++ 头文件来自 sysroot 里的 libc++）；Python3 用内置 Pyodide 的 `compile()`，只检查语法、不执行；Java 没有内置编译器，只做规则检查（括号/引号/明显缺分号/`if` 缺括号等）。C/C++ 与 Python3 的检查结果都会画波浪线。
- **只做语法检查，不运行代码**：C/C++ 的 `-fsyntax-only` 不产出目标文件、不链接；Python3 只 `compile()` 不执行；Java 只做规则扫描。所以它比「编译并运行」快，也敢在每次停手后都跑一遍。
- **整理代码绝不覆盖新改动**：整理请求带着发起时的原文，回到页面前会比对一次；这期间你又敲了字，这次整理直接取消（提示「代码刚变过，这次整理取消了」）。

技术细节（为什么必须走 MAIN world、波浪线怎么定位、clang 的列号为什么按字节算）记在 **[docs/pta-page-notes.md](docs/pta-page-notes.md)** 第 2.1 节。

### diff 全屏

diff 卡片表头有「全屏查看」：新标签页打开完整 diff，不折叠、不限高；只保留最近 8 份，过期后回到面板重新点一次。

### 状态保存

| 状态 | 说明 |
|---|---|
| 输入草稿 | 没发出去的文本按标签页存在 `sessionStorage`，刷新不丢；不同标签互不串 |
| 布局位置 | 拖动/缩放，刷新页面后自动恢复 |
| 对话记录 | 按标签页存盘（刷新恢复本标签这一份；最多 60 条、单条 8000 字符） |

对话记录存在每个标签页自己的 `sessionStorage`，按标签页分桶：刷新恢复本标签这一份；同一道题开两个标签也互不串。点「新会话」只清当前标签页这份。

### 多个标签页同时用

面板开关只活在**当前标签页的内存里**，不写 storage、不跨标签页同步——在 A 页打开悬浮窗不会让 B 页的面板也弹出来。每个标签页各跑各的 agent 会话，互不干扰；在某个标签页开始新一轮对话时，只会中止**该标签页**上一轮还在跑的请求。

## AI 可用的工具

一共 25 个工具：

| 工具 | 功能 |
|---|---|
| `read_problem` | 读取当前题面（样例、公式转 LaTeX；代码填空题带作答区模板） |
| `read_editor_code` | 读取作答区代码；多文件题传 `all=true` 列出全部编辑器 |
| `write_editor_code` | 写入作答区（自动回读比对、样例编译、检查提交按钮；多文件题用 `editorIndex`） |
| `compile_and_run_c` | 本地编译运行 C（Clang wasm） |
| `compile_and_run_cpp` | 本地编译运行 C++（Clang wasm + libc++，`-std=c++17`，支持 `bits/stdc++.h`） |
| `compile_and_run_python` | 本地运行 Python（Pyodide） |
| `compile_and_run_js` | 本地运行 JavaScript（Node 风格 `require('readline')` / `process.stdin`） |
| `read_pta_compile_result` | 读取 PTA 最近一次编译/运行结果（含编译错误） |
| `simulate_pta_run` | 在 PTA 页面点「运行测试」并读回结果；可带 `code` 直接写完再跑 |
| `submit_answer` | 提交作答区代码并等判题结论 |
| `read_judge_result` | 读取判题结论（AC/WA/PC/TLE 等） |
| `next_problem` | 切到题目列表里的下一题（`/fuck` 赶题模式用） |
| `list_problems` | 读题目列表总览：题型分组、每题是否已提交、哪道是当前题 |
| `set_language` | 切换作答语言（C / C++ / Java / Python3 等，题组允许时） |
| `close_dialogs` | 关闭挡在页面上的弹窗 |
| `refresh_page` | 刷新当前页面 |
| `js_inject` | 在页面主世界执行 JavaScript |
| `simulate_keyboard_input` | 模拟键盘输入 |
| `ask` | 向用户提选择题（阻塞等待点选） |
| `diff` | 左右对照展示改动 |
| `write_document` | 写文件并下载到本机 |
| `write_zip` | 给上传 zip 的多文件题生成答案压缩包并下载 |
| `write_explanation_page` | 交一份自包含的 HTML 讲解页，面板给「打开讲解页」的邀请卡片 |
| `date` / `url` | 获取当前时间 / 当前页面地址 |

### 工具细节

**`read_problem`**：读取标题、题目 ID、题目集 ID、描述、输入输出格式和样例；公式还原成 LaTeX（`$...$`），图片公式会附上说明与链接。
返回值第一行会写明**题目类型**（编程题 / 选择题 / 判断题 / 代码填空 / 多文件）。是选择题或判断题时，作答区是一堆单选框而不是代码框，这时它会把**这一页上所有小题**连同各自的选项一起列出来。
是代码填空题时，会把**作答区模板**放在题面之前（长题面可能被工具结果预算截断，放最后会被挤掉），模型在原模板上补全，不会整段重写。
新版多文件题（type/9）通常是**上传 zip**，页面里没有可写编辑器，插件的编辑器工具用不上；老版多文件题若确实有多个代码框，才按下述 `all` / `editorIndex` 处理。

**`read_editor_code`**：读取作答区里当前代码（优先编辑器实例，DOM 只能读到渲染出来的行）。
只有页面存在多个代码编辑器时，`all=true` 才会列出全部可写编辑器及序号（从 0 开始），配合 `write_editor_code` 的 `editorIndex` 使用。

**`write_editor_code`**：写入后自动做三件事——回读逐行比对、用题面前几组样例编译比对输出（按页面上选定的语言挑运行器，最多跑 3 组，输入输出各不超过 4000 字）、检查提交按钮是否可用。有「不一致 / 按钮禁用」先把结论修掉。
题目是**选择题或判断题**时走的是另一条路：内容按空格拆开，第一个答案对第一题、第二个对第二题，以此类推（可以写选项字母 `A B C D`，也可以写选项原文），逐个勾到对应的单选框上。
页面有多个代码框时用 `editorIndex` 指定写第几个；`read_editor_code all=true` 给出的序号就是它。上传 zip 的多文件题没有编辑器，不要调用它写文件。
代码填空题（type/6）不按「一份完整程序」跑样例，改用带 `-include` 预置头的语法检查；多文件题若走编辑器写入，则明确提示用 `simulate_pta_run` 在 PTA 上验证，
避免把裁判程序片段 / 缺文件链接报成假编译失败。

**`compile_and_run_c`**：用内置的 Clang 22（wasm）编译并运行 **C** 代码，可以给标准输入。引擎按 `.c` 编译。

**`compile_and_run_cpp`**：同一套 Clang 22 + wasm-ld + libc++ 静态库，按 `.cpp`、`-std=c++17` 编译运行 **C++**，支持 `iostream` / `vector` / `string` / `algorithm` / `map` 等标准库，可以给标准输入。C++ 题优先用它本地验样例，不要拿 C 前端去编 C++。

**`compile_and_run_python`** / **`compile_and_run_js`**：本地运行 Python（Pyodide）与 JavaScript，可以给标准输入。

**`simulate_pta_run`**：在 PTA 页面上真跑一次测试——自动点开测试面板（Test Case / 测试用例）→ 把 `stdin` 填进测试输入框（不传就沿用面板里原有的输入）→ 点「运行测试 / Run Test Case」→ 轮询读回结果。英文页还会带回 Expected Result；跑完没有输出时回退去读 `Compiler's Log` 页签。
运行前会快照测试区里所有只读编辑器：用例表、上次遗留的结果都不算本次输出；只认新增结果框、已有输出容器里新写入的段落、或结果页签由隐藏变可见。
传 `code`（可配 `language`）时，插件先把代码写进作答区再运行：Java / Go / C# / Rust 这类没有本地编译器的语言，一次调用就能「写代码 + 在 PTA 上真跑」。

**`set_language`**：切换作答区右上角的编程语言（题组允许时）。页面选 C 但要写 C++、或要切到 Java / Python3 时用它；不传 `language` 只读当前语言。

**`read_pta_compile_result`**：读 PTA 页面上的「编译器输出」区域：最近一次运行的输出、异常堆栈、编译错误。

> **没有内置编译器的语言（Java、Go、C#、Rust 等）走这两个工具。** Java 另有代码整理和规则语法提示，但**不内置 JRE**，本地跑不了；Go / C# / Rust 也没有本地工具链。运行只能借 PTA 自己的编译器：先 `simulate_pta_run` 跑一遍拿结果，需要看编译错误再 `read_pta_compile_result`。不要因为本地跑不了就以为代码是对的。

**`submit_answer` / `read_judge_result`**：提交后等判题结论。PTA 结果页不会自己刷新，等待循环里只点**判题弹窗内**的「刷新 / Reload」按钮；弹窗里没有就不点，避免整页刷新把这一轮打断。提交前先确认上一次的「提交结果 dialog」已经关掉（`close_dialogs`），否则它会挡住提交按钮。

判题结论归一化：

| 代号 | 含义 |
|---|---|
| `AC` | 通过（Accepted） |
| `PC` | 部分正确（Partially Accepted）——不等于做对 |
| `WA` | 答案错误 |
| `RE` | 运行时错误 |
| `TLE` | 超时 |
| `MLE` | 内存超限 |
| `CE` | 编译错误 |

**`list_problems`**：读考试页侧栏的总览——每个题型分组的「已答/总数」、当前题型的每道题是否已提交（认 `PROBLEM_ACCEPTED` / `PROBLEM_SUBMITTED` 等状态类，`PROBLEM_NO_ANSWER` 算未提交）、哪一道是当前题。用户问「还有哪些题没做」或赶题模式规划路线时用它。

**`next_problem`**：切到下一道还没提交的题。先在同一题型里往后找，找不到再回头找；当前题型做完后点题型分组链接切到下一个题型，等侧栏网格真的换好再点第一道未提交的题（不会点到旧题型的链接上）。全部做完时返回「没有下一题了」，并附上本轮统计（做过几题、AC 几题、未过哪几题）。

**`js_inject`**：在页面主世界执行 JavaScript，支持顶层 `await`，15 秒超时；主世界不可用时退回隔离世界。

**`simulate_keyboard_input`**：向作答区或指定元素模拟输入。支持 `selector`、`text`、`clear`、`press`、`focusOnly`、`readOnly`。真实按键走 `chrome.debugger` 发 CDP 事件（trusted），用不了时自动退回模拟事件并在结果里说明。

**`ask`**：向用户提选择题。等不到作答 15 分钟后按「用户没有作答」继续；面板点选项后要等后台回执，被拒绝会把卡片恢复成可点。凡是能列选项的问题（要不要改、要不要提交、选哪种做法）都必须用它，正文里列选项会被护栏转成 ask 卡片。

**`diff`**：左右两列 + 中间一条道，行号夹在两边，改动块头尾画 `»` / `«`。`write_editor_code` 成功后插件会**自动展示**这次改动，模型不用再调；卡片可全屏。

**`write_document`**：把整理好的内容写成文件下载到本机；超过面板能力的长文档用它，不要在回答里贴整篇。
多文件题（type/9，上传 zip）传 `files`（键为 zip 内路径、值为文件文本），插件用浏览器原生代码打包成 zip 下载，用户再点「Upload Answer Zip」上传。

**`write_zip`**：专门给上传 zip 的多文件题用；只接受 `filename` + `files`，生成标准 zip 并触发下载。含 `..` 的路径会被丢弃。若模型接口把自由对象 `files` 强制序列化成 `{}`（例如 Qwen），可改用 `filesJson` 传 JSON 字符串。

### 提示词里的硬规矩

提示词（`src/shared/tools.ts` 的 `SYSTEM_PROMPT`）里写死的规则，代码之外还有一层确定性护栏兜底：

| 规则 | 内容 |
|---|---|
| 改代码/提交前先问 | 用户本条没明确要求改代码或提交时，`write_editor_code` / `submit_answer` 会被系统直接拦下 |
| 少动用户代码 | 能局部修补就别整段重写，保留用户原来的变量名、注释和写法风格 |
| **不内联用户已提取的函数** | 用户把代码抽成函数了，就保持函数形态，**不要又内联回调用处**；也不要删掉或改名他已经写好的辅助函数、常量、工具类 |
| **命名用英文表意** | 变量名、函数名用英文并准确表达含义（`totalScore` 而不是 `s1`/`tmp`/`a`，`calculateAverage` 而不是 `doIt`），同一份代码里风格一致，注释只写「为什么」 |
| 能问就问 | 凡是能列成选项的问题一律用 `ask`，不要在正文里写「要不要…？」再跟列表 |
| 自动展示 diff | `write_editor_code` 成功后自动生成 diff 卡片，模型不用再调 `diff` |

## 内置编译器

插件内置 **C**、**C++**、Python、JavaScript 四种语言的编译运行环境：不联网、代码不出本机。

| 工具 | 运行时 |
|---|---|
| `compile_and_run_c` | Clang 22.1.8 + wasm-ld + wasi-sdk 33 sysroot（约 91MB） |
| `compile_and_run_cpp` | 同一套 Clang + wasm-ld，加 sysroot 里的 libc++ / libc++abi 静态库，`-std=c++17` |
| `compile_and_run_python` | Pyodide 0.26.4（约 15MB） |
| `compile_and_run_js` | 插件内置 JS Worker（提供 Node 风格 `require('readline')`、`process.stdin/stdout`、顶层 `await`） |

AI 会自动调用它们验证样例。例如：

```
帮我用 Python 解决这道题：
已知 n，求 1 到 n 的和。
样例：输入 5，输出 15。
```

AI 会写代码并调 `compile_and_run_python`，把样例输入 `5\n` 喂进去，确认输出 `15`。

对于**没有内置编译器**的语言（Java、Go、C#、Rust 等），走 PTA 自己的运行入口：

- **`simulate_pta_run`**：展开测试面板 → 把 `stdin` 填进测试输入框（不传就沿用原有输入）→ 点「运行测试 / Run Test Case」→ 读回结果（英文页还会带回 Expected Result）
- **`read_pta_compile_result`**：读取最近一次编译/运行输出

这两个工具只在 PTA 页面（`pintia.cn`）上生效。

## PTA 适配要点

更细的实测笔记（怎么找题面、怎么认作答区、怎么逐字敲代码、判题结论怎么归一化、踩过的坑）见 **[docs/pta-page-notes.md](docs/pta-page-notes.md)**。

### 判题结论归一化

- `Partially Accepted` 归一化成 `PC`（部分正确，不等于 AC）
- 整体结论块（Status + 结论值）优先于逐行扫描
- 裸状态码只在很短的一行里才算结论，避免被页面脚本里的 `you're` 命中成 `RE`

### 题型与选择题

PTA 的题型是固定的几个，题目集合地址里带着（`/problems/type/N`）：

| N | 题型 | 作答区 |
|---|---|---|
| 1 | 判断题（True or False） | 单选框 |
| 2 | 选择题（Multiple Choice） | 单选框（每题一组，选项是 A/B/C/D…） |
| 6 | 代码填空（Code Completion） | 代码编辑器 |
| 7 | 编程题（Programming） | 代码编辑器 |
| 9 | 多文件（Multiple Files） | **上传 zip**（含多个源文件；教材题集实测），部分旧题可能有代码编辑器 |

- 选择题/判断题的一页上排着**好几小题**，没有「一个题面容器」这回事，所以按单选框的 `name` 分组抠：题号、题干、每个选项的字母与文字分别取出来
- 选项的 `id` 形如 `input-radio-option-<题号>-A`，按这个就能把「A」对上具体那个单选框
- 题干里混着两类噪音：页面的 UI 文案（复制内容 / 全屏 / 收起）和代码块行号槽里的数字，读的时候要滤掉


### 新版测试面板

新版测试区是页签：`Test Case` / `Running Result` / `Compiler's Log`，结果容器可能在第 5 层祖先里，而且跑完不一定自动切页签。

- `simulate_pta_run` 会主动点开结果页签；结果为空时回退 `Compiler's Log`
- `read_pta_compile_result` 同样先切页签再读，并排除作答区自己的代码
- 回归测试复刻了页签结构，覆盖「不自动切页签」「只有编译日志」两种情况

## 隐私与安全

- **API Key 只存在 `chrome.storage.local`，只有 background 能读**；content script 拿到的设置视图里没有 Key
- **请求由 background 发出**：避开页面 CSP，也不让 Key 进入页面上下文
- **代码不出本机**：内置编译器完全在浏览器里跑，不联网
- **Key 输入框不让密码管理器碰**：`autocomplete="off"` + `data-lpignore="true"`，避免把 PTA 的密码误套进来
- **改用户代码前必须先问**：用户没有明确要求改代码时，`write_editor_code` 之前必须先 `ask`
- **唯一的外部出口**是模型接口、上下文长度查询（`models.dev`）与 release 标签检查（`api.github.com`、`gitee.com`）

## 工程结构

```
manifest/manifest.json   手写清单（Chrome 用），Firefox 版本在构建时按差异打补丁
vite.config.ts           一次构建一个入口（background / content / diff），TARGET 决定产物目录
src/
  background/
    index.ts             图标点击、消息路由、进行中的请求、设置读写入口
    agent.ts             agent loop、工具分发、视觉模式判断
    deepseek.ts          调用 /chat/completions，解析 SSE 与 tool_calls 分片
    pta-scripts.ts       PTA 页面脚本：题面、代码、提交、判题、模拟运行、编译输出
    js-inject.ts         在页面主世界执行脚本（超时 + 隔离世界回退）
    input-methods.ts     写入作答区（编辑器事务 / 逐字输入）
    typist.ts            逐字输入
    debugger-input.ts    chrome.debugger 发 CDP 真实按键
    compile.ts           内置运行器调度（C / C++ / Python / JS）
    compiler-host.ts     承载 wasm 引擎的 Worker（Chrome 走 offscreen 文档）
    clipboard.ts         读剪贴板的后台兜底
    explain-pages.ts     讲解页的存与取（/what 生成的那份 HTML）
    batch-progress.ts    /fuck 本轮统计（做过几题、AC 几题、未过哪几题）
    settings.ts          设置读写、检查更新（GitHub / Gitee release 标签）
    model-context.ts     查模型真实的上下文长度（接口 /models 优先，再查 models.dev）
  content/
    index.tsx            content script：注入 Shadow DOM 并挂载 React
    App.tsx              悬浮窗主体
    shortcuts.ts         Alt+G 打开并聚焦输入框、Esc 关闭
    paste.ts             Ctrl+V / Ctrl+M / 右键粘贴的内置粘贴与焦点判定
    pageTools.ts         需要页面上下文的工具
    panelStore.ts        面板开关、布局、草稿（草稿按标签页存 sessionStorage）
    chatStore.ts         对话持久化（按标签页分桶，sessionStorage）
    hooks/               useChat、useSettings、usePanelLayout
    components/          Composer（输入区）、MessageList、ToolCard、DiffView、Markdown、SettingsPanel
  diff/                  全屏 diff 标签页（main.tsx + DiffPage.tsx）
  shared/
    browser.ts           chrome / browser API 垫片
    messages.ts          消息协议与类型
    tools.ts             工具定义 + 系统提示词
    settings.ts          设置类型、默认值、视觉模式判定
    model-context.ts     上下文字段的纯逻辑（从模型列表 / models.dev 里挑值，不依赖 chrome）
    guardrails.ts        写入与提交护栏、ask 选项解析
    c-library-docs.ts    C 标准库函数的中文注释表
    cpp-library-docs.ts  C++ STL 常用名字的中文注释表
    context-window.ts    长对话压缩（赶题模式防止上下文撑爆）
    abort.ts             统一的 AbortSignal 工具
    types.ts             通用类型
    diff.ts / diff.css   diff 引擎与样式
    input-methods.ts     输入方法清单
    commands.ts          斜杠指令清单与解析
scripts/                 下载资源、打包、测试
docs/                    PTA 页面适配的实测笔记
public/engine/           内置 C / C++ 编译器（wasm + sysroot + WASI shim，见该目录 README）
public/engine/pyodide/   内置 Python 运行时（约 15MB）
```

## 开发与调试

```bash
npm install
npm run build      # 下载引擎资源 + 类型检查 + 产出 dist/chrome、dist/firefox
npm run test       # 全部测试（需要先 build）
npm run package            # 两个浏览器各打一个包
npm run package:chrome     # 只打 Chrome zip
npm run package:firefox    # 只打 Firefox xpi
npm run icons              # 重新生成图标（python3 + Pillow）
```

需要 Node 22.18+（测试脚本直接跑 `src` 里的 TS，用的是 Node 的类型擦除）。

加载开发产物：

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ `dist/chrome`
- Firefox：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ `dist/firefox/manifest.json`

改完代码重新构建，再在扩展管理页点刷新。构建脚本只清空产物目录内容、不删目录本身：目录被删掉重建后，浏览器里已加载的插件会报「File path cannot be resolved」，移除后重新加载即可。

> **只重建不重新加载扩展，后台的改动不会生效。** `background.js` 跑在 MV3 的 service worker 里，浏览器会把它的脚本缓存住；content script 每次页面加载都是现读的（所以面板、设置页的改动立刻可见），可后台的改动会停留在旧版本。症状很典型：设置页多了一个新控件，后台却还是旧行为。
>
> 依次试这几招：
>
> 1. 扩展管理页点「重新加载」（CDP 的话是 `Extensions.loadUnpacked` 传 `dist/chrome` 的绝对路径）；
> 2. 还不行就把 profile 里的 service worker 缓存删掉再重启浏览器——`~/.config/chromium/Default/Service Worker` 与 `Default/Code Cache`（这两个目录是**缓存**，删了会重新生成，不会丢登录态）；
> 3. 改完记得刷新页面，content script 才会换成新的。
>
> 判断有没有生效：看新加的控件在不在、后台的行为对不对，别只看构建产物。

点图标没反应时按顺序排查：页面是否在装插件之前打开（刷新）、是否 `chrome://` 内部页（预期不支持）、`chrome://extensions` 的错误页里 background 有没有报错。

## 设计说明

### 内置 C / C++ 编译器

把 Clang 22.1.8 + wasm-ld（LLD）+ wasi-sdk 33 的 sysroot 编成 WebAssembly 放进插件，编译、链接、运行全在 Web Worker 里完成。

| 环节 | 做法 |
|---|---|
| 编译 | `clang -cc1 -emit-obj`；C 用 `-x c`，C++ 用 `-x c++ -std=c++17` 并把 libc++ 头放在 C 头之前；memfs 里补了 `bits/stdc++.h` 万能头 |
| 链接 | `wasm-ld` 链接 `crt1.o` + C++ 时 `libc++.a` / `libc++abi.a` / `libc.a` + `libclang_rt.builtins.a` |
| 运行 | JS 实现的 WASI shim：stdin 预喂样例输入，stdout / stderr 分开收集 |

- 编译 + 链接 60 秒、运行 10 秒的阶段化硬超时；超时直接杀掉 Worker 重建（死循环没有协作式检查点）
- Chrome 用 offscreen 文档承载 Worker，Firefox 的 background 直接 `new Worker`
- 资源约 91MB，由 `scripts/fetch-engine.mjs` 从固定 Release 下载并 sha256 校验，之后完全离线
- 引擎来源 [cppstudio-io/wasm-clang-runtime](https://github.com/cppstudio-io/wasm-clang-runtime)（Apache-2.0）

### 护栏（提示词 + 代码双重约束）

提示词之外，agent loop 里有三层确定性护栏：

| 护栏 | 行为 |
|---|---|
| 自动 diff | `write_editor_code` 成功后，后台用「写入前原文 + 写入的代码」**合成一张 diff 卡片**，不依赖模型自觉；模型再调同一份 diff 会去重 |
| ask 硬门 | 未 ask 过、且用户本条没明确要求时，`write_editor_code` / `submit_answer` 直接返回失败并提示先 ask；用户选了「先别改 / 先不提交」后这一轮继续拦住 |
| 正文选项转 ask | 模型在正文里列选项（1./- / A.、还是、是/否问题）时，解析成真正的 ask 卡片并等用户点选，再继续下一轮 |

授权判定按操作区分：提交一律先问（用户本条明确说「提交」除外）；改代码只有本条明确要求「改 / 写 / 修 / 重写 / 补全 / 实现 / 优化」时才免问。识别不到的问题宁可漏转，也不会把普通疑问句硬塞进 ask。

局限：正文是流式上屏的，转 ask 时原文已经显示；护栏不撤回已输出的文字，只额外给出可点卡片。

### 视觉模式怎么判断的

1. AI 调 `read_problem` 读题面，图片在文本里留 `[图片 …]` 占位；视觉模式激活时插件再把真实 URL 作为 `image_url` 内容块补发给模型
2. 插件用 `statementHasImages()` 看有没有这个占位
3. 有图片就按设置（自动 / 开 / 关）决定要不要走视觉模式
4. 当前模型不支持看图（`modelSupportsVision()` 按集中能力表判断，含 Qwen3.8-27B）时，**提醒一次**本次被降级成纯文本，然后照常继续跑，不中断工具链

### 性能

内容多时不卡依赖几件事：流式增量按 `requestAnimationFrame` 合并、消息与工具卡片 `memo`、滚动状态只在跨越阈值时更新、消息区 `contain: content` + 气泡 `content-visibility: auto`、进度条只动 `transform`。

### 「停止」在任何时刻都有效

整个 agent loop 共用同一个 `AbortSignal`：模型流、等用户作答、页面工具、页面脚本、编译器、逐字输入、写入作答区都接得上；工具跑到一半被停也会补一条收尾事件，面板不会永远转圈。

### 新对话强制停旧对话

同一页面里开始新一轮时，background 会把该标签页上一轮还在跑的请求 `abort()` 并释放挂起的 `ask`；不同标签页互不影响。

### 其他

- **ask 超时 15 分钟**：问用户判题结果时可能中途去查资料；走人也可以点「停止」
- **KaTeX 字库**：只带 woff2，构建时复制到 `dist/<target>/katex-fonts/`
- **UTF-8 校验**：Chrome 会拒绝含 Unicode 非字符的脚本，构建时统一转义成 `\uXXXX`
- **判题等待**：PTA 结果页不会自动刷新，等待循环里只点**判题弹窗内**的「刷新 / Reload」；弹窗里没有就干等，绝不点页面级 Reload
- **检查更新**：设置页读取设置时顺手查一次 release 标签，1 小时内缓存一次结果

## 常见问题

| 问题 | 处理 |
|---|---|
| 点图标没反应 | 刷新页面；`chrome://` 页面不支持 |
| `Alt+G` 没反应 | 先点一下页面让内容脚本拿到焦点；某些页面会吞掉 Alt 组合键 |
| 按 Ctrl+V 没反应 | 先点一下作答区；仍不行用 Ctrl+M |
| 题目里有图，但 AI 没看懂 | 模型不支持看图，插件会提示被降级了：换看图模型，或把视觉模式改成「关」避免误判 |
| 全屏 diff 提示已过期 | 只保留最近 8 份，回面板重新点一次 |
| API Key 无效 | 设置页重填，或检查接口地址 |
| 编译器加载失败 | 确认扩展允许 WASM；或用 PTA 的「运行测试」（`simulate_pta_run`） |
| Java / Go / C# 这类语言跑不了 | Java 支持代码整理 + 规则语法提示，但不内置 JRE；Go / C# / Rust 也没有本地工具链。运行仍让 AI 用 `simulate_pta_run` 借 PTA 的环境 |
| 判题一直卡住 | 插件只点判题弹窗内的「刷新」；弹窗里没有就不点，超时后让 AI 调 `refresh_page` 再 `read_judge_result` |

## 更新记录

| 版本 | 主要内容 |
|---|---|
| v6.8.1 | 修用户真机反馈：`compile_and_run_*` 的 `stdin` 传数字时不再被静默丢成空串（`2` → `'2'`）；Python 实时检查增加 AST 未定义名字检查，`returnsentence` 这类拼写会报 `undefined name`（fragment 模式降为 warning，保留语法错误）；提交/读判题只在**判题弹窗内**点「刷新 / Reload」，删掉页面级 Reload 回退，避免整页刷新导致拿不到判题结果 |
| v6.8.0 | 实时检查扩到 Python3：内置 Pyodide 只 `compile()` 不执行，返回行/UTF-8 字节列/中文建议；C/C++ 仍走 clang `-fsyntax-only`。Java 加入保守规则检查（括号/引号/明显缺分号/`if` 缺括号）与真正的 Java 代码整理（缩进、运算符空格、泛型尖括号保护、文本块保守跳过）。修 `/* ... */` 整理后丢失分隔符的问题；C/C++ 单行、行尾、多行块注释都保留 `/*`/`*/`。README、提示词与测试同步 |
| v6.7.0 | 多标签改为标签页级 `sessionStorage`：草稿/对话刷新保留，同 URL 两个标签也互不串；顺手修掉 reload 后布局被重置。`set_language` 支持 react-select `mousedown` 展开与 `cpp/c++/g++` 别名，判断题选项接受 `T/TRUE/FALSE` 并剥离题干行号槽，`simulate_pta_run` 在编译错误出现时立即读回编译器日志。视觉模式真正把图片作为 `image_url` 送进模型，修正 `vlmMode=off` 语义，加入 Qwen3.8-27B 视觉能力与模型下拉 eye icon；Qwen 的 `files` 空对象用 `filesJson` 兜底。C++ 引擎按阶段超时、排队超时不再重启引擎、日志写满后仍能回收编译诊断。新增 `test-tab-store` / `test-model-capabilities`，扩充 `test-compile` 与 `test-pta-tools` |
| v6.6.0 | 上传 zip 的多文件题（type/9）现在能真正交付答案：新增独立工具 `write_zip`（只接受 `filename` + `files`，键为 zip 内路径、值为文件文本），用浏览器原生 Blob 生成标准 zip 并触发下载，用户再点「Upload Answer Zip」上传；`write_document` 也支持 `files` 兼容旧调用。不引外部库、路径穿越 `../` 会被拒绝。`read_problem` 会从 Problem Folder 抠出文件清单、提醒样例不是 stdin，并明确让模型用 `write_zip` 打包；README / 提示词 / 工具 schema 同步；jsdom 冒烟覆盖 zip 打包，Node 侧用 Python `zipfile` 验证生成的 zip 字节、文件名与内容。修复内置 Python 运行器 stdin 耗尽后返回空串、导致 `sys.stdin.read()` 死循环的问题：改为返回 `null` 表示 EOF，并新增回归测试 |
| v6.5.0 | 真机打开「101计划 Python 版数据结构」的 type/9 多文件题，发现新版多文件题**根本没有代码编辑器**：作答区是「上传 zip」+ 文件清单，`read_editor_code all=true` / `write_editor_code editorIndex` 用不上。现在 `read_problem` 检测不到可写编辑器时明确说明这是上传 zip 题、让模型按文件清单交付内容，不再假装有「作答区模板」；README、提示词、工具 schema 同步区分「上传 zip 的多文件题」与「确实有多个代码框的老题」。真机 `read_problem` 已验证给出正确作答方式 |
| v6.4.0 | 真机 7-2 复测发现 `simulate_pta_run` 仍会把可见的用例表当结果：新考试页把本次结论放在状态条（Last Tested At / Non-zero Exit Code）而不是结果框里。改成先认状态条变化 / 结果框由隐藏变可见 / 输出容器新写入文本，再扣掉运行前就存在的只读框；单测覆盖「用例表本来就可见」「结果页签预先渲染」「老页面 #out 写入」三种路径。真机最终不再返回 4 段假样例，而是如实提示「没读到输出」或给出状态条结论 |
| v6.3.0 | `next_problem` 切题后等题目标题渲染完再返回（赶题统计不再记成「Programming - Problem List」），跨题型切换返回新题型里的真实序号而不是固定 0；/fuck 模式每次成功换题往面板推一条进度横幅（已做 / AC / 还剩几题） |
| v6.2.0 | 修掉 `simulate_pta_run` 把测试区自带的用例表当成运行结果（真机 7-2 读回 4 段用例而不是程序输出）：运行前快照所有只读编辑器，只认新增结果框 / 新写入的文本 / 结果页签由隐藏变可见；修掉隐藏测试面板抢走 stdin 写入（按祖先 display:none 判定可见性，jsdom 也能跑）；`write_editor_code` 对代码填空 / 多文件题不再按完整程序跑样例（前者改为带 prelude 的语法检查、后者明确提示用 PTA 验证），避免假「编译失败」；长文本工具结果按工具放宽截断（`read_problem` / `read_editor_code` 12000、`list_problems` 8000），`read_editor_code all=true` 每个编辑器单独限长并提示用 `editorIndex` 读全文 |
| v6.1.0 | 本地 C++ 补 `bits/stdc++.h` 万能头（PTA 竞赛代码最常见的写法）；修掉 `read_problem` 把题面里的「函数接口定义 / 裁判测试程序样例」当成样例喂给模型（真机 6-1 第二组假样例）；代码填空题的实时检查改用 `-include` 预置常用 C/C++ 头（`printf` / `std::vector` 不再被报成未声明，真机 6-1 的 3 个假错误清零）；测试输入框优先选有布局的可见实例（页面上残留的隐藏测试面板不再抢走写入）；内置 JS 运行器补 Node 风格垫片：`require('readline')`、`process.stdin/stdout`、顶层 `await`；`simulate_pta_run` 支持直接传 `code`（可选 `language`），Java / Go / C# / Rust 一次调用完成「写代码 + 在 PTA 上真跑」；新增 `set_language` 工具切换作答语言；长对话自动压缩（系统提示全保留、按预算留最近消息、不拆 assistant/tool 对），赶题模式跑几十题不会把上下文撑爆 |
| v6.0.0 | 内置编译器支持 **C++**：同一套 Clang 22 + wasm-ld，按 `.cpp -std=c++17` 编译、链接 sysroot 里的 libc++ / libc++abi / libc，新工具 `compile_and_run_cpp`；实时语法检查与 STL 悬停注释一起覆盖 C++（`checkLanguage` 先判 C++ 再判 C，`C++ (g++)` 不再被当成 C）；修掉题面语言检测把 C++ 认成 C、以及 Java/Go 被当成 C 编译并报假错的 bug；代码填空题 `read_problem` 直接带作答区模板（放在题面前面，避免被 4000 字截断吃掉）；多文件题 `read_editor_code all=true` 列出全部编辑器、`write_editor_code editorIndex` 按序号写；新增 `list_problems` 工具（题型分组 + 每题已提交状态 + 当前题）；`next_problem` 跨题型切换改为等侧栏网格真的换好再点，并认真实考试页的 `PROBLEM_ACCEPTED` / `PROBLEM_NO_ANSWER` 状态标记（原来只认 `PROBLEM_SUBMITTED`，会把已经 AC 的题再点一遍）；赶题模式走到题单末尾附上本轮统计（做过/AC/未过），且题目 ID 改从 `problemSetProblemId` 取（原来取成题目集 ID，整份题单被记成同一道题）；`write_editor_code` 自动样例检查最多跑前 3 组 |
| v5.1.0 | 作答区增强按反馈修正：彩虹括号改成**逐行定位**（每行只查一次 `posAtDOM`，不再逐括号做布局查询、也不是只数 span——行内的裸标点会让下标整体偏移），并**加粗**；CM6 重画行会清掉内联样式，所以改成监听编辑器 DOM 变动、同一帧内补色，滚动/移动光标不再掉色；工具栏与状态栏用 `ResizeObserver` 跟随，展开/收起「Test Case」不再滞后；clang 把「这一行少了分号」指在行尾时，波浪线不再因为跨行被丢掉（原来底部报错、代码里一条线都没有）；**只有 error 画波浪线**（warning 只计数）；「整理代码」重写：运算符两侧补空格（`7*2` → `7 * 2`）、`int *p`/`*p`/`-1` 不当二元运算符、无花括号的 `if`/`for`/`while` 体缩进一层、预处理指令顶格、保持幂等；Python 只规范运算符空格不动缩进 |
| v5.0.0 | 内置编译器实时检查：停手 0.35 秒后把作答区代码送进本地 clang 做 `-fsyntax-only`（只编译、不链接、不运行，一次 30–45ms），出错的字符下画红色波浪线、代码框底部状态栏显示「N 个错误」，鼠标停在波浪线上给出 clang 原文与中文修改建议；C 标准库 / `string.h` / `math.h` 常用函数的中文注释（悬停函数名即显示原型、作用与常见坑）；检查不计入引擎重建计数，日志超 1MB 自行回收 |
| v4.2.0 | 作答区增强：代码框底部状态栏上的「整理代码」按钮（按花括号重排缩进、清理行尾空白与多余空行，字符串和注释不动，改动过期就不应用）；彩虹括号（按嵌套层级给括号上色，配对的左右括号同色，字符串/注释里的括号不算）；页面脚本走 MAIN world 注入，与隔离世界用 `window.postMessage` + 每次安装随机 token 通信 |
| v4.1.0 | `/fuck` 赶题模式（不问、不解释、直接提交，做完自动切下一题；还在调，欠账见 `todo.txt`）；指令菜单支持 Tab 补全；顶栏上下文长度改用模型真实值（接口 / models.dev 查得，查不到才估算）；讲解页不再把 HTML 塞进地址栏，改开在 PTA 的固定地址（沙箱 iframe 里渲染）；修掉题面样例框的行号槽/折叠标记漏进正文；修掉生成页面里出现字面 `&gt;`；修掉插件自己的合成 Esc 把悬浮窗关掉；选择题的提交按钮认得英文的 Save |
| v4.0.0 | 斜杠指令：输入 `/` 列出指令（上下键选、回车发送），`/new` `/resolve` `/what` `/why`；空输入框连按三次回车开新会话；顶栏改成上下文填充圆环（token 明细藏进提示）、token 化简成 12.71K 这种写法；选择题/判断题：读题面报题型并列出全部小题，答案按空格填进单选框；`/what` 生成苏格拉底式讲解页并给「打开讲解页」的邀请卡片；修掉两个 bug：全选时粘贴变成追加、助手回答末尾断成两个对话框 |
|---|---|
| v3.5.0 | 设置页新增「运行环境」开关：默认走插件内置编译器，打开后强制改用 PTA 自己的编译器与机器跑代码（编译错误也从 PTA 的「编译器输出」里读）；真机测试器 `pta-drive.mjs` 改为按路径算扩展 ID（原来写死了，换机器就找不到插件）、新增 `custom` 模式可自由下指令 |
| v3.4.0 | 视觉模式（VLM）：题面含图自动切换、模型不支持看图时主动提醒降级、设置页新增「视觉模式」开关；`Alt+G` 打开悬浮窗并聚焦输入框、`Esc` 关闭；设置页顶部检查 GitHub/Gitee release 提示新版本；API Key 输入框防密码管理器误填；提示词补充英文表意命名与「不内联用户已提取的函数」；按代码校正文档中过时的描述（刷新按钮点击频率、内置编译语言范围等） |
| v3.3.0 | 提示词强化；自动 diff 护栏、ask 工具硬门、正文选项自动转 ask 卡片 |
| v3.2.0 | 移除面板「输入」按钮，改为复制后用 `Ctrl+V` / `Ctrl+M` 内置粘贴 |
| v3.1.1 | 文档与发布：Manual 合并进 README、站点链接改为 `me.octest.top`、Release 打包补齐 Pyodide、产物名跟随完整版本号 |
| v3.1 | **移除全页面最大化模式**；新增 `Ctrl+V` / `Ctrl+M` 内置粘贴、diff 全屏、流式渲染与滚动性能优化、新版 PTA 页签式测试结果、新对话强制停旧对话 |
| v3.0.1 | 版本号同步、文档整理 |
| v3.0 | 全页面最大化模式、内置 Python/JavaScript 编译器、PTA 编译结果读取与模拟运行 |

## License

[LICENSE](LICENSE)
