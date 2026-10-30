# PTA 助手

> **本项目完全使用 AI 开发，作者只起到充钱和测试的作用。**

PTA 助手是一个帮助学生完成 PTA（拼题A）题目的浏览器插件，支持 Chrome / Edge / Brave / Vivaldi / Firefox / Zen 等浏览器（Chromium 系与 Gecko 系都支持）。

核心能力：

- 内置自定义 agent loop：请求模型 → 执行工具 → 回灌结果 → 再来一轮
- 内置 C/C++、Python、JavaScript 三种语言的本地编译运行环境（无需联网、代码不出本机）
- 完整的 PTA 页面适配：读题面、读写代码、提交、读判题结论、模拟运行
- 悬浮窗 + 全页面最大化模式，状态全局单例同步
- 支持 markdown 渲染、KaTeX 数学公式、工具调用卡片、多轮追问

## 安装

插件**没有签名**，所以每个浏览器的装法不太一样。先记住三条铁律：

1. **Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera）只认「文件夹」**：把 `pta-assistant-v3.0.1.zip` **先解压**，再在扩展管理页里「加载已解压的扩展程序」选那个文件夹。直接选 zip 会报「无法加载清单」。
2. **Gecko 系（Firefox / Zen）可以直接选 xpi**：`about:debugging` → 临时载入附加组件 → 选 `pta-assistant-v3.0.1.xpi`。临时载入**关掉浏览器就没了**，再开一次要再载一遍。
3. **一定要选对文件夹层级**：解压后要选**里面有 `manifest.json` 的那一层**。别选到套了两层目录的，也别选项目根目录。

### Chrome / Edge / Brave / Vivaldi / Opera

1. 下载 `pta-assistant-v3.0.1.zip` 并**解压**
2. 打开扩展管理页（Chrome：`chrome://extensions`；Edge：`edge://extensions`；其它内核浏览器地址类似）
3. 打开「开发者模式」
4. 点「加载已解压的扩展程序」，选中解压出来、里面有 `manifest.json` 的那个文件夹
5. 点浏览器右上角拼图图标，把「PTA 助手」**固定**到工具栏

### Firefox / Zen

1. 下载 `pta-assistant-v3.0.1.xpi`
2. 地址栏打开 `about:debugging#/runtime/this-firefox`
3. 右上角点「临时载入附加组件…」，选择刚下载的 `.xpi`
4. 工具栏出现拼图图标，点它找到「PTA 助手」并**固定**到工具栏
5. 关掉浏览器就失效，下次启动要重新载入；想省这一步需要官方签名版本

## 装完之后

- **点图标没反应**：页面是在装插件之前打开的，刷新一下页面；`chrome://` 这类浏览器内部页面不允许注入，属正常
- **图标不在工具栏**：默认不固定，点拼图图标 → 找到「PTA 助手」→ 点图钉
- **想换位置/大小**：拖标题栏移动、拉右下角改大小，位置与尺寸会被记住；**双击标题栏或双击工具栏图标**恢复默认
- **第一次用**：点右上角齿轮填 API Key（默认接硅基流动），接口地址旁边有「教程」按钮

## 基础工具列表

插件内置以下工具供 AI 调用：

| 工具 | 功能 |
|---|---|
| `read_problem` | 获取当前题目的完整题面（含样例、公式还原成 LaTeX） |
| `read_editor_code` | 读取作答区中用户当前编写的代码 |
| `write_editor_code` | 把代码写入作答区（自动验证、回读比对、样例编译） |
| `compile_and_run_c` | 本地编译并运行 C/C++ 代码（Clang wasm 引擎） |
| `compile_and_run_python` | 本地运行 Python 代码（Pyodide） |
| `compile_and_run_js` | 本地运行 JavaScript 代码 |
| `read_pta_compile_result` | 读取 PTA 页面最近一次编译/运行结果 |
| `simulate_pta_run` | 在 PTA 页面点「运行测试」并读回结果（覆盖无内置编译器的语言） |
| `submit_answer` | 提交当前作答区代码，等判题结论 |
| `read_judge_result` | 读取判题结论（AC/WA/PC/TLE 等） |
| `close_dialogs` | 关掉挡在页面上的弹窗 |
| `refresh_page` | 刷新当前页面（页面状态乱掉时用） |
| `js_inject` | 在页面主世界执行任意 JS（拿到 PTA 页面自己的 JS 对象） |
| `simulate_keyboard_input` | 模拟键盘输入到作答区或指定元素 |
| `ask` | 向用户提选择题，在面板上点选 |
| `diff` | 把改动前后的代码左右两列对照展示 |
| `write_document` | 编写文档并下载到用户的浏览器 |
| `date` | 获取当前日期时间 |
| `url` | 获取当前页面 URL |

注意：只有当用户说可以发版时才可以使用 v3.0.1 等标签标记 commit。

## 工程结构

```
manifest/manifest.json   手写的清单文件（Chrome 用），Firefox 版本在构建时按差异打补丁
vite.config.ts           构建配置：一次构建一个入口（background / content / fullpage），target 决定产物目录
src/
  background/index.ts    background：图标点击、消息路由、维护进行中的请求
  background/agent.ts    agent loop：请求模型 → 执行工具 → 回灌结果 → 再来一轮
  background/deepseek.ts 调用 /chat/completions，解析 SSE 文本增量与 tool_calls 分片
  background/js-inject.ts 在页面主世界执行模型给的 JS（含超时与隔离世界回退）
  background/compile.ts   内置编译器调度：C/Python/JS 三个引擎，阶段化超时，Worker 承载
  background/debugger-input.ts chrome.debugger 发 CDP 真实按键（Input.dispatchKeyEvent / insertText）
  background/pta-scripts.ts PTA 页面适配脚本：读题面、读写代码、提交、判题、模拟运行
  background/settings.ts 设置读写（chrome.storage.local），API Key 只留在这里
  content/index.tsx      content script：注入 Shadow DOM 宿主节点并挂载 React
  content/App.tsx        悬浮窗主体（对话 / 设置两个视图）
  content/pageTools.ts   页面侧工具：url 取当前地址，write_document 触发下载
  content/hooks/         useChat（消息、流式增量、工具事件）、useSettings
  content/components/    消息列表、markdown 渲染、工具卡片、输入区、设置页
  content/katexStyles.ts KaTeX 样式的字库地址改写成扩展地址
  content/styles.css     悬浮窗样式（跟随 content.js 一起注入，不污染页面）
  content/chatStore.ts   对话持久化：按页面地址分桶，chrome.storage.local
  fullpage/              全页面最大化模式（React 组件复用 content 侧）
  shared/                browser API 入口、消息协议、工具定义、设置与消息类型
  shared/abort.ts        「停止」的统一语义：造/认 AbortError、随时打断任意一步
public/engine/           内置 C 编译器：Clang/LLD 的 wasm + sysroot + WASI 运行时（见该目录 README）
public/engine/pyodide/    内置 Python 运行时（Pyodide，约 15MB）
public/avata.jpg         作者头像：设置页作者卡片与底部署名用
scripts/
  fetch-engine.mjs      下载 C 编译器的三大资源（约 91MB，build 前自动跑一次）
  fetch-pyodide.mjs     下载 Pyodide 运行时（约 15MB，build 前自动跑一次）
  gen-icons.py          生成 public/icons 下的图标
  package-firefox.mjs   把 dist/firefox 打成无签名的 xpi（npm run package:firefox）
  package-chrome.mjs    把 dist/chrome 打成 zip（npm run package:chrome）
  zip.mjs               两个打包脚本共用的手写 zip 实现（固定时间戳，可复现打包）
  test-typist.mjs       键盘模拟：幻影闭合符、缩进修正、回读比对
  test-diff.mjs         diff 引擎：行配对、行号、颜色分类、超大输入降级
  test-pta-tools.mjs    PTA 工具脚本：题面、代码读写、判题、模拟运行的集成测试
  test-compile.mjs      内置 C 编译器：真实引擎编译运行 + 样例比对
  test-deepseek.mjs     假的 fetch 跑 SSE 解析与错误映射
  test-background.mjs   后台逻辑：agent loop、请求路由、工具调度
  smoke.mjs             jsdom 冒烟测试：清单完整性、悬浮窗、流式对话、设置页
```

## 开发与调试

```bash
npm install
npm run build      # fetch-engine + fetch-pyodide + 类型检查 + 产出 dist/chrome、dist/firefox
npm run test       # 全部测试（需要先 build）
npm run icons      # 重新生成图标（需要 python3 + Pillow）
npm run package            # 两个浏览器各打一个包（dist/pta-assistant-v3.0.1.xpi 与 .zip）
npm run package:firefox    # 只打 Firefox 的 xpi（无签名）
npm run package:chrome     # 只打 Chrome 的 zip（上传应用商店 / 给用户手动解压安装）

需要 Node 22.18+。

构建脚本刻意不删产物目录本身（只让 Vite 清空目录内容）：目录被删掉重建后，浏览器里已加载的插件还指向旧目录，刷新时会报「File path cannot be resolved / 无法加载清单」。遇到这个报错就把插件「移除」再重新加载一次。

加载方式：

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `dist/chrome`
- Firefox（开发）：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选择 `dist/firefox/manifest.json`

改代码后需要重新 build，再在扩展管理页点刷新按钮。

点图标打不开悬浮窗时的排查顺序：

1. 页面是在插件安装/重载之前打开的 —— 正常情况下点图标会自动补注入（`scripting.executeScript`），实在不行刷新页面
2. `chrome://` 开头的内部页面不允许注入，属于预期
3. 打开 `chrome://extensions` 点「错误」看 background 有没有报错

## 设计决策

### 安全

- **API Key 存在 `chrome.storage.local`，只有 background 能读到**：content script 拿到的视图里没有 Key，页面上也拿不到明文
- **请求由 background 发出**（不是 content script 直连）：既避开页面自身的 CSP，也不让 Key 进入页面上下文
- **改用户代码前必须先 ask**：系统提示里的硬规矩——用户没有明确要求改代码时，`write_editor_code` 之前必须先 ask 一次；用户选了「先别改」就停下讲思路

### 内置 C 编译器（v0.9）

`compile_and_run_c` 完全在插件本地编译运行：不联网、代码不出本机、不用配任何服务地址。

做法：把 Clang 22.1.8 + wasm-ld（LLD）+ wasi-sdk 33 的 sysroot 全部编成 WebAssembly 塞进插件，整套引擎跑在 Web Worker 里。

| 环节 | 做法 |
|---|---|
| 编译 | `clang -cc1 -emit-obj`，C 头文件来自 sysroot 的 `include/wasm32-wasip1` |
| 链接 | `wasm-ld` 链接 `crt1.o` + `libc.a` + `libclang_rt.builtins.a`，产出用户程序的 .wasm |
| 运行 | 用 JS 实现的 WASI shim 跑这个 .wasm：stdin 预喂（题目的样例输入）、stdout / stderr 分开收集 |

资源约 91MB（`public/engine/`），三个大文件不进 git，`npm run build` 会先跑 `scripts/fetch-engine.mjs` 从固定的 Release 下载并 sha256 校验（只需一次，之后永久离线）。

实现取舍：

- **Worker 而不是直接跑**：编译 + 运行是同步 CPU 密集任务，更重要的是学生写错边界条件容易写出死循环，wasm 里没有协作式检查点，唯一能停下来的办法就是 `worker.terminate()` 整个杀掉再重建
- **Chrome 用 offscreen 文档承载 Worker**：MV3 的 service worker 里建不了 Worker；Firefox 的 background 是 event page，直接 `new Worker`。编译期间后台每 20 秒戳一次扩展 API，防止 service worker 被按空闲回收
- **阶段化超时**：编译 + 链接 60 秒（首次含引擎加载），运行 10 秒，超时就杀 Worker 并汇报「运行超时（多半是死循环）」
- **用 noeh 版 clang/lld**：标准版有一条 exnref 指令要 Chrome 125+，剥掉它之后 Chrome 63+ / Firefox 115+ / 各种国产内核 WebView 都能跑
- **必须在 manifest 里放行 wasm**：MV3 扩展页默认 CSP 是 `script-src 'self'`，不含 wasm 权限。manifest 里写的是 `script-src 'self' 'wasm-unsafe-eval'`
- **语义参照 PTA 判题机**（GCC），和桌面 clang/gcc 一致：自测通过不等于提交能过，但至少不会因为编译器方言吃亏
- 引擎来源 [cppstudio-io/wasm-clang-runtime](https://github.com/cppstudio-io/wasm-clang-runtime)（Apache-2.0，其前身是 binji/wasm-clang），`shared.js` 改成了 C 专用、补了 stderr 分流；详见 `public/engine/README.md`

### 判题结论归一化（v2.0）

PTA 的判题结果页是英文的，结论不在弹窗里，而是「Status 标签 + 结论值」一块。

- **`Partially Accepted` 才是 PTA 的「部分正确」原文**，它包含 `Accepted`，不单独列出来就会被报成 AC
- **裸状态码只在 ≤24 字符的一行里才算结论**：页面里「不再支持旧浏览器」的提示脚本中 `you're` 的 `re` 会被 `\bRE\b` 命中，整页被报成「判题结论：RE」；脚本/样式节点不参与判题文字收集
- **整体结论优先于明细表**：先找「Status 标签 + 结论值」的整体结论块，再退回逐行扫
- **「部分正确」排在所有正向词前面**，归一化成 `PC`；「通过」只在真的在讲结论时才算 AC（`通过测试点 6/10`「通过率 60%」这类统计不算）

### 全局单例状态同步（v3.0）

悬浮窗与全页面最大化模式共享同一份状态，通过 `chrome.storage.local` + `storage.onChanged` 实时同步：

| 状态 | 说明 |
|---|---|
| 面板开关 | 在任一界面打开/关闭，所有界面同步 |
| 输入草稿 | 未发送的文本在所有输入框实时同步 |
| 布局位置 | 拖动/缩放，刷新页面后自动恢复 |
| 对话记录 | 按页面地址分桶存盘（最多 60 条、单条 8000 字符） |

### 「停止」在任何时刻都有效（v2.0）

整个 agent loop 的每一段都接同一个 `AbortSignal`（语义统一在 `src/shared/abort.ts`）：

| 阶段 | 怎么停的 |
|---|---|
| 模型请求（SSE） | fetch 带 signal；中止时主动 `reader.cancel()` |
| 等用户作答 | `chat/stop` 解掉等待，返回「用户已停止这次提问」 |
| 页面工具 | `abortable()` 与中止赛跑，content script 不回话也能立刻放手 |
| 页面里跑的脚本 | 往页面置 `__ptaAborted = true`，页面里的循环自己看标记 |
| 内置编译器 | `runInEngine` 收到中止就换掉整个引擎 |
| 逐字敲键盘 | `runTypist` 每个字符前看一眼标记 |
| 写入作答区 | 每次换写入实现之前看一眼标记 |

另两层保险：

- **工具跑到一半被停**：照样补一条 `chat/tool-end`（内容「已停止」），卡片不会永远转圈
- **面板不等后台回话**：点「停止」立刻自己收尾，之后迟到的 `chat/*` 事件一律不上屏

### 其他工程细节

- **ask 的 15 分钟超时**：问用户判题结果这类问题，用户可能中途去查资料；真有走人的情况点「停止」一样能收工
- **对话持久化**：对话记在 `chrome.storage.local`，按页面地址分桶，刷新页面不丢
- **KaTeX 字库**：只带 woff2（20 个文件 296K），构建时复制到 `dist/<target>/katex-fonts/`，CSS 里的相对地址改写成扩展地址
- **UTF-8 校验坑**：Chrome 会用 `base::IsStringUTF8` 校验脚本，Unicode 非字符（U+FFFE / U+FFFF 之类）会被判成「不是 UTF-8 编码」而拒绝加载整个插件。构建里已经统一把非字符转义成 `\uXXXX`
- **判题等待**：PTA 的判题结果页不会自己刷新，等待循环里每秒点一次页面上的「刷新 / Reload」按钮

## 版本历史

| 版本 | 主要内容 |
|---|---|
| v3.0.1 | 版本号同步、文档整理 |
| v3.0 | 全页面最大化模式、全局单例状态同步、内置 Python/JavaScript 编译器、PTA 编译结果读取与模拟运行 |
| v2.0 | 模型下拉框、判题结论修正（部分正确不再报成 AC）、「停止」随时可用 |
| v1.0 | 设置页作者卡片、默认接硅基流动、面板可改大小 |
| v0.9 | 内置 C 编译器（Clang wasm，完全本地） |
| v0.8 | 面板可拖动缩放、智能滚动、工具卡片折叠 |
| v0.7 | PTA 三件套：读题面 / 读写代码 / 提交与判题 |
| v0.5 | 模拟键盘输入（CDP 真实按键 + 幻影闭合符对抗） |
| v0.4 | agent loop、js_inject / url / date / write_document 四工具 |
| v0.3 | markdown + KaTeX 流式渲染 |
| v0.2 | 接入 DeepSeek，单轮流式对话 |
| v0.1 | 基础悬浮窗 UI |
