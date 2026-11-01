# PTA 助手

> 本项目完全使用 AI 开发，作者只起到充钱和测试的作用。

PTA 助手是一个运行在浏览器里的 PTA（拼题A）解题助手：自带 agent loop、本地编译器和完整的页面适配，支持 Chrome / Edge / Brave / Vivaldi / Opera / Firefox / Zen。

- 插件下载与教程：**<https://me.octest.top/pta-assist-plugin>**
- 作者主页：**<https://me.octest.top>**

## 功能

| 能力 | 说明 |
|---|---|
| 对话 agent loop | 请求模型 → 执行工具 → 回灌结果 → 再来一轮，最多 80 轮 |
| 本地编译器 | C/C++（Clang wasm）、Python（Pyodide）、JavaScript 全部在本机运行，代码不出本机 |
| PTA 页面适配 | 读题面、读写作答区、提交、读判题结论、模拟运行，覆盖新版页签式结果区 |
| 禁粘贴也能贴 | 接管 `Ctrl+V` / `⌘V`，读剪贴板后走插件自己的写入链路；抢不过页面时用 `Ctrl+M` |
| diff 全屏 | diff 卡片可在新标签页显示完整改动，不折叠没改动的行 |
| 公式与 Markdown | 流式渲染 Markdown、表格与 KaTeX 公式 |
| 随时停止 | 模型流、页面脚本、编译、逐字输入、写入作答区都能被「停止」打断 |
| 对话持久化 | 按页面地址分桶存进浏览器本地，刷新不丢 |

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

### 打开悬浮窗

- 点工具栏的 PTA 助手图标：开关悬浮窗
- 双击图标或双击标题栏：恢复默认位置与大小
- 拖标题栏移动、拉右下角改大小，位置与尺寸会被记住

| 面板按钮 | 作用 |
|---|---|
| 新会话 | 清空对话上下文，连带清掉存盘的对话记录 |
| 发送 / 停止 | 发送消息；生成或写入途中可随时停止 |
| 输入 | 把输入框文本写进作答区（不走 AI） |
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

接口地址旁边有「教程」，打开的也是 <https://me.octest.top/pta-assist-plugin>。

### 粘贴：Ctrl+V / Ctrl+M

PTA 会拦截普通粘贴。插件只在可写作答区里接管：

| 操作 | 行为 |
|---|---|
| `Ctrl+V` / `⌘V` | 读取系统剪贴板，在光标处插入；不触发页面的「禁止粘贴」 |
| `Ctrl+M` | 备用快捷键，`Ctrl+V` 被页面抢先拦掉时用 |
| 右键 / 中键粘贴 | 同样走内置粘贴 |
| 面板「输入」按钮 | 剪贴板读不到时的兜底，把输入框里的文本整段写进作答区 |

写入过程中页面底部会出现提示条。剪贴板读取失败时，content script 会转给 background（Chrome 用 offscreen 文档，Firefox 用 background 页的 DOM）。

### diff 全屏

diff 卡片表头有「全屏查看」：新标签页打开完整 diff，不折叠、不限高；只保留最近 8 份，过期后回到面板重新点一次。

### 状态保存

| 状态 | 说明 |
|---|---|
| 输入草稿 | 没发出去的文本保存在本地，刷新不丢 |
| 布局位置 | 拖动/缩放，刷新页面后自动恢复 |
| 对话记录 | 按页面地址分桶存盘（同一道题恢复同一段对话，最多 60 条、单条 8000 字符） |

对话记录存在 `chrome.storage.local`，按页面地址分桶：同一道题恢复同一段对话，换题就是新的一段，不会串上下文。点「新会话」会把存盘的那份一起清掉。

## AI 可用的工具

| 工具 | 功能 |
|---|---|
| `read_problem` | 读取当前题面（样例、公式转 LaTeX） |
| `read_editor_code` | 读取作答区代码 |
| `write_editor_code` | 写入作答区（自动回读比对、样例编译、检查提交按钮） |
| `compile_and_run_c` | 本地编译运行 C/C++（Clang wasm） |
| `compile_and_run_python` | 本地运行 Python（Pyodide） |
| `compile_and_run_js` | 本地运行 JavaScript |
| `read_pta_compile_result` | 读取 PTA 最近一次编译/运行结果 |
| `simulate_pta_run` | 在 PTA 页面点「运行测试」并读回结果 |
| `submit_answer` | 提交作答区代码并等判题结论 |
| `read_judge_result` | 读取判题结论（AC/WA/PC/TLE 等） |
| `close_dialogs` | 关闭挡在页面上的弹窗 |
| `refresh_page` | 刷新当前页面 |
| `js_inject` | 在页面主世界执行 JavaScript |
| `simulate_keyboard_input` | 模拟键盘输入 |
| `ask` | 向用户提选择题（阻塞等待点选） |
| `diff` | 左右对照展示改动 |
| `write_document` | 写文件并下载到本机 |
| `date` / `url` | 获取当前时间 / 当前页面地址 |

### 工具细节

**`read_problem`**：读取标题、题目 ID、描述、输入输出格式和样例；公式还原成 LaTeX（`$...$`），图片公式会附上说明与链接。

**`read_editor_code`**：读取作答区里当前代码（优先编辑器实例，DOM 只能读到渲染出来的行）。

**`write_editor_code`**：写入后自动做三件事——回读逐行比对、用第一组样例编译比对输出（按页面上选定的语言挑运行器）、检查提交按钮是否可用。有「不一致 / 按钮禁用」先把结论修掉。

**`submit_answer` / `read_judge_result`**：提交后等判题结论。PTA 结果页不会自己刷新，等待循环里每秒点一次页面上的「刷新 / Reload」。提交前先确认上一次的「提交结果 dialog」已经关掉（`close_dialogs`），否则它会挡住提交按钮。

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

**`js_inject`**：在页面主世界执行 JavaScript，支持顶层 `await`，15 秒超时；主世界不可用时退回隔离世界。

**`simulate_keyboard_input`**：向作答区或指定元素模拟输入。支持 `selector`、`text`、`clear`、`press`、`focusOnly`、`readOnly`。真实按键走 `chrome.debugger` 发 CDP 事件（trusted），用不了时自动退回模拟事件并在结果里说明。

**`ask`**：向用户提选择题。等不到作答 15 分钟后按「用户没有作答」继续；面板点选项后要等后台回执，被拒绝会把卡片恢复成可点。

**`diff`**：左右两列 + 中间一条道，行号夹在两边，改动块头尾画 `»` / `«`。改完代码必须调用一次；卡片可全屏。

**`write_document`**：把整理好的内容写成文件下载到本机；超过面板能力的长文档用它，不要在回答里贴整篇。

## 内置编译器

插件内置 C/C++、Python、JavaScript 三种语言的编译运行环境：不联网、代码不出本机。

| 工具 | 运行时 |
|---|---|
| `compile_and_run_c` | Clang 22.1.8 + wasm-ld + wasi-sdk 33 sysroot（约 91MB） |
| `compile_and_run_python` | Pyodide 0.26（约 15MB） |
| `compile_and_run_js` | 插件内置 JS Worker |

AI 会自动调用它们验证样例。例如：

```
帮我用 Python 解决这道题：
已知 n，求 1 到 n 的和。
样例：输入 5，输出 15。
```

AI 会写代码并调 `compile_and_run_python`，把样例输入 `5\n` 喂进去，确认输出 `15`。

对于**没有内置编译器**的语言（Java、C#、Go 等），走 PTA 自己的运行入口：

- **`simulate_pta_run`**：展开测试面板 → 把 `stdin` 填进测试输入框（不传就沿用原有输入）→ 点「运行测试 / Run Test Case」→ 读回结果（英文页还会带回 Expected Result）
- **`read_pta_compile_result`**：读取最近一次编译/运行输出

这两个工具只在 PTA 页面（`pintia.cn`）上生效。

## PTA 适配要点

### 判题结论归一化

- `Partially Accepted` 归一化成 `PC`（部分正确，不等于 AC）
- 整体结论块（Status + 结论值）优先于逐行扫描
- 裸状态码只在很短的一行里才算结论，避免被页面脚本里的 `you're` 命中成 `RE`

### 新版测试面板

新版测试区是页签：`Test Case` / `Running Result` / `Compiler's Log`，结果容器可能在第 5 层祖先里，而且跑完不一定自动切页签。

- `simulate_pta_run` 会主动点开结果页签；结果为空时回退 `Compiler's Log`
- `read_pta_compile_result` 同样先切页签再读，并排除作答区自己的代码
- 回归测试复刻了页签结构，覆盖「不自动切页签」「只有编译日志」两种情况

## 隐私与安全

- **API Key 只存在 `chrome.storage.local`，只有 background 能读**；content script 拿到的设置视图里没有 Key
- **请求由 background 发出**：避开页面 CSP，也不让 Key 进入页面上下文
- **代码不出本机**：内置编译器完全在浏览器里跑，不联网
- **改用户代码前必须先问**：用户没有明确要求改代码时，`write_editor_code` 之前必须先 `ask`

## 工程结构

```
manifest/manifest.json   手写清单（Chrome 用），Firefox 版本在构建时按差异打补丁
vite.config.ts           一次构建一个入口（background / content / diff），TARGET 决定产物目录
src/
  background/index.ts    图标点击、消息路由、进行中的请求
  background/agent.ts    agent loop
  background/deepseek.ts 调用 /chat/completions，解析 SSE 与 tool_calls 分片
  background/js-inject.ts 在页面主世界执行脚本（超时 + 隔离世界回退）
  background/compile.ts  内置编译器调度（C / Python / JS）
  background/clipboard.ts 读剪贴板的后台兜底
  background/pta-scripts.ts PTA 页面脚本：题面、代码、提交、判题、模拟运行
  background/settings.ts 设置读写，API Key 只留在这里
  content/index.tsx      content script：注入 Shadow DOM 并挂载 React
  content/App.tsx        悬浮窗主体
  content/paste.ts       Ctrl+V / Ctrl+M 内置粘贴
  content/hooks/         useChat、useSettings、usePanelLayout
  content/components/    消息列表、Markdown、工具卡片、输入区、设置页
  content/chatStore.ts   对话持久化（按页面地址分桶）
  diff/                  全屏 diff 标签页
  shared/                browser API、消息协议、工具定义、diff 引擎与样式
public/engine/           内置 C 编译器（wasm + sysroot + WASI shim，见该目录 README）
public/engine/pyodide/   内置 Python 运行时（约 15MB）
scripts/                 下载资源、打包、测试
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

需要 Node 22.18+。

加载开发产物：

- Chrome：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ `dist/chrome`
- Firefox：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ `dist/firefox/manifest.json`

改完代码重新构建，再在扩展管理页点刷新。构建脚本只清空产物目录内容、不删目录本身：目录被删掉重建后，浏览器里已加载的插件会报「File path cannot be resolved」，移除后重新加载即可。

点图标没反应时按顺序排查：页面是否在装插件之前打开（刷新）、是否 `chrome://` 内部页（预期不支持）、`chrome://extensions` 的错误页里 background 有没有报错。

## 设计说明

### 内置 C 编译器

把 Clang 22.1.8 + wasm-ld（LLD）+ wasi-sdk 33 的 sysroot 编成 WebAssembly 放进插件，编译、链接、运行全在 Web Worker 里完成。

| 环节 | 做法 |
|---|---|
| 编译 | `clang -cc1 -emit-obj`，头文件来自 sysroot |
| 链接 | `wasm-ld` 链接 `crt1.o` + `libc.a` + `libclang_rt.builtins.a` |
| 运行 | JS 实现的 WASI shim：stdin 预喂样例输入，stdout / stderr 分开收集 |

- 编译 + 链接 60 秒、运行 10 秒的阶段化硬超时；超时直接杀掉 Worker 重建（死循环没有协作式检查点）
- Chrome 用 offscreen 文档承载 Worker，Firefox 的 background 直接 `new Worker`
- 资源约 91MB，由 `scripts/fetch-engine.mjs` 从固定 Release 下载并 sha256 校验，之后完全离线
- 引擎来源 [cppstudio-io/wasm-clang-runtime](https://github.com/cppstudio-io/wasm-clang-runtime)（Apache-2.0）

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
- **判题等待**：PTA 结果页不会自动刷新，等待循环里会点页面上的「刷新 / Reload」

## 常见问题

| 问题 | 处理 |
|---|---|
| 点图标没反应 | 刷新页面；`chrome://` 页面不支持 |
| 按 Ctrl+V 没反应 | 先点一下作答区；仍不行用 Ctrl+M 或面板「输入」 |
| 全屏 diff 提示已过期 | 只保留最近 8 份，回面板重新点一次 |
| API Key 无效 | 设置页重填，或检查接口地址 |
| 编译器加载失败 | 确认扩展允许 WASM；或用 PTA 的「运行测试」 |
| 判题一直卡住 | 插件会自动点「刷新」；超时后可让 AI 调 `refresh_page` |

## License

[LICENSE](LICENSE)
