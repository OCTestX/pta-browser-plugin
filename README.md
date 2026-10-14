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

- agent loop：模型可以连续调用工具，结果回灌后继续下一轮，直到给出最终回答；最多 6 轮（`MAX_TOOL_ROUNDS`）
- 四个工具：
  - `js_inject`：在**页面主世界**执行模型写的 JS（所以能拿到 PTA 页面自己的 JS 对象），支持顶层 await，15 秒超时；主世界不可用时自动退回隔离世界（DOM 操作照常，只是拿不到页面对象）
  - `url`：当前页面地址（在页面侧取，SPA 路由变化也准）
  - `date`：当前日期时间与星期
  - `write_document`：用 Blob + `a[download]` 触发下载，文件名会清洗掉路径分隔符，不需要 downloads 权限
- 工具调用在对话里显示成卡片：工具名、参数（`js_inject` 的代码完整展开）、状态、执行结果
- 会话重建：工具卡片会还原成 `tool` 消息、调用记录挂在对应的 assistant 消息上，所以下一轮请求的上下文是完整的
- 执行模型给的 JS 不弹确认（按需求选择），因此**代码会直接显示在卡片里供检查**；同时意味着页面内容有可能诱导模型写出危险代码，请只在可信页面上使用

已知限制：

- `js_inject` 依赖 host 权限：需要先用工具栏图标打开过悬浮窗（这时才拿到该标签页的 activeTab 授权）
- 页面如果 CSP 很严（不允许动态脚本），`js_inject` 会失败并把原因回灌给模型；PTA 站点没有任何 CSP，正常可用
- content.js 因为带上了 markdown + KaTeX 涨到 690K（gzip 205K），首次注入会有一点开销
- 若页面极其严格地限制字体（`font-src`），公式可能退回系统字体显示，结构仍然正确
- 依赖里 katex@0.16 有一条「原型污染绕过 trust 限制」的低危通告，我们没用 `trust` 选项，且输入来自模型而非攻击者

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