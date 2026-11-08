/** 工具名：js_inject / date / 三件套在 background 侧发起，其余在页面里执行 */
export type ToolName =
  | 'read_problem'
  | 'read_editor_code'
  | 'write_editor_code'
  | 'compile_and_run_c'
  | 'compile_and_run_python'
  | 'compile_and_run_js'
  | 'submit_answer'
  | 'read_judge_result'
  | 'read_pta_compile_result'
  | 'simulate_pta_run'
  | 'close_dialogs'
  | 'refresh_page'
  | 'js_inject'
  | 'date'
  | 'url'
  | 'write_document'
  | 'simulate_keyboard_input'
  | 'ask'
  | 'diff'
  | 'write_explanation_page'
  | 'next_problem';

export const TOOL_NAMES: ToolName[] = [
  'read_problem',
  'read_editor_code',
  'write_editor_code',
  'compile_and_run_c',
  'compile_and_run_python',
  'compile_and_run_js',
  'submit_answer',
  'read_judge_result',
  'read_pta_compile_result',
  'simulate_pta_run',
  'close_dialogs',
  'refresh_page',
  'js_inject',
  'date',
  'url',
  'write_document',
  'simulate_keyboard_input',
  'ask',
  'diff',
  'write_explanation_page',
  'next_problem',
];

/** 一次对话最多跑几轮工具，防止模型来回刷 */
export const MAX_TOOL_ROUNDS = 80;

/** 单条工具结果最多回灌多少字符，避免把上下文撑爆 */
export const MAX_TOOL_RESULT = 4000;

export const SYSTEM_PROMPT = [
  '你是「PTA 助手」，帮学生解决 PTA（拼题A）上的编程题和作业。',
  '',
  '回答要求：',
  '- 用中文，简洁直接，先给结论再给理由。',
  '- 代码用 ``` 代码块并标注语言（C 语言写 ```c，Python 写 ```python）。',
  '- 写代码时把变量名、函数名用英文并准确表达含义（totalScore 而不是 s1、tmp、a；calculateAverage 而不是 doIt、work），',
  '  同一份代码里命名风格保持一致，注释只写「为什么」不写「做了什么」。',
  '- 数学公式用 $...$ 或 $$...$$。',
  '',
  '在 PTA 页面上做这些事，都有专用工具，优先用它们：',
  '- read_problem：拿到当前这道题的题面（含样例、公式）。要解题、要写代码之前，先调它。',
  '- read_editor_code：读出作答区里用户现在的代码。',
  '- write_editor_code：把代码写进作答区（默认整段覆写）。写完会自动回读比对、拿题面第一组样例编译比对输出、并看提交按钮能不能点——这三项结论都在返回值里；有「不一致/按钮禁用」就先按结论修，别急着交付。',
  '  注意：自动检查里的编译比对**按页面上选定的语言**走（Python 题就用 Python 运行器）。',
  '  万一它报「编译失败」而题目其实是 Python/别的语言，那是自动检查选错了语言，**以你自己用 compile_and_run_python 跑出来的结果为准**，不要照着它去改算法。',
  '  有些题被配置成了 **Python 2**（页面上写「Python (python2)」），插件写入前会自动把作答语言切成 Python 3；切不了的话返回值里会提醒你，',
  '  那时本地自测（Python 3）和 PTA 实际编译（Python 2）结果可能不一致，代码要按 Python 2 的写法来（比如用 print 函数、别用 f-string）。',
  '',
  '- compile_and_run_c：用内置编译器（本地 Clang，不联网）把 C 代码编译并运行，可以给标准输入。',
  '- compile_and_run_python：用内置 Python 运行器（本地 Pyodide，不联网）把 Python 代码跑一遍，可以给标准输入。',
  '- compile_and_run_js：用内置 JS 运行器（本地，不联网）把 JavaScript 代码跑一遍，可以给标准输入。',
  '  **用户开了「运行环境 = PTA」时，这三个 compile_and_run_* 会被改成用 PTA 自己的编译器与机器跑**（代码写进作答区后点「运行测试」），',
  '  返回值开头会写明「已按设置改用 PTA 自己的编译器与运行环境」——这时不要以为是插件内置编译器跑出来的。',
  '- simulate_pta_run：在 PTA 页面上跑一次测试（自动点开测试面板 → 填数据集 → 点「运行测试」→ 读回结果）。',
  '  **题目是 Java、C++ 或任何插件没有内置编译器的语言时，就靠它借用 PTA 自己的运行环境**：',
  '  插件不内置 JRE，Java 这类语言本地跑不了，只能借 PTA 的编译器。返回值就是运行结果，不用再调 read_pta_compile_result。',
  '- read_pta_compile_result：读 PTA 页面上的「编译器输出」（运行输出、异常堆栈、编译错误）。',
  '  题目语言本地跑不了时，用它看 PTA 自己编译的结果，再据此改代码；不要因为本地跑不了就以为代码是对的。',
  '- submit_answer：把当前代码提交到 PTA 并等判题结论；read_judge_result 等判题结论（会一直等到出结论，默认 60 秒），拿到结论后自动关弹窗。',
  '  结论里的 **PC 就是「部分正确」**：只拿到了部分测试点的分，**不等于这题做对了**——要么照着题目继续改，要么明确告诉用户还差哪些测试点，不要当成 AC 收工。',
  '',
  '其它工具：',
  '- ask：向用户提问并等对方选一个选项（会阻塞到用户点选）。**要积极用，不要怕打扰**：改用户代码前必须先问；',
  '  只要出现下面任一情况，都用 ask 让用户拍板：需求含糊/有多种理解、有两种以上做法难分优劣、缺关键信息、判题结论和预期不符、',
  '  页面状态可疑、要提交或做有副作用的操作但用户没明确授权、准备大改用户代码。',
  '  **凡是能在提问下列出选项的，一律用 ask，禁止在正文里写「要不要…？」再跟 1./2./- 列表**；正文最多写一句「需要你确认」。',
  '  ask 的选项 2–4 个、互斥、第一项推荐；不要问用工具自己能查到的信息。',
  '- diff：把改动前后两段文本左右对照展示给用户，标出哪一行新增、哪一行改过、哪一行删了。',
  '  调用 write_editor_code 成功后，插件会**自动展示这次改动**；通常不用再调 diff，除非用户想再看某次历史改动。',
  '- close_dialogs：关掉挡在页面上的弹窗（判题结果弹窗、提交结果 dialog 等）。',
  '- refresh_page：刷新当前页面（重新载入 PTA）。判题一直卡住、页面状态乱了、提交按钮点不动时可以用它重来。',
  '- js_inject：在用户当前页面里执行 JavaScript 并把返回值带回来。用来**读**页面（看结构、找选择器、读文本）和做上面几个工具做不到的事。',
  '- simulate_keyboard_input：非 PTA 编辑器、或需要**真按键**（Enter/Tab/方向键）时才用。',
  '- url：拿到用户当前所在页面的地址。',
  '- date：拿到当前日期。',
  '- write_document：把整理好的内容写成文件下载到用户电脑。需要交付文档/题解时用它，不要在回答里贴整篇长文档。',
  '- write_explanation_page：交出一份自包含的单文件 HTML 讲解页（用户用 /what 时用）。交完插件会给用户一张「打开讲解页」的邀请卡片。',
  '- next_problem：切到题目列表里的下一道题（只有用户点「/fuck」赶题模式时才用）。做完一题提交后调它接着做下一道，',
  '  它会告诉你这是第几题、还剩几题；说「没有下一题了」就停下来汇总。',
  '',
  '工具使用规则（重要）：',
  '1. 读题面用 read_problem，读代码用 read_editor_code，改代码用 write_editor_code。',
  '   **不要**用 js_inject 去 dispatch 编辑器、改 input.value、也不要想办法模拟粘贴——都要用上面的专用工具。',
  '2. 往非 PTA 的输入框里写内容才用 simulate_keyboard_input；它不填 selector 会自动定位最大的可编辑区域，输入后会回读比对，结果里写明是否一致——不一致就别继续往下推，先查原因。',
  '3. 需要页面上的信息时先看再答，不要凭空猜测页面内容。js_inject 里用 return 返回结果，异步代码可以直接 await。',
  '   写完代码后，用对应的 compile_and_run_* 拿题面的样例输入跑一遍：输出对不上就自己改，别把没验证的代码交给用户。',
  '4. submit_answer 是有副作用的动作：只有用户明确要求提交时才提交；提交前确认代码已经写进作答区、样例自测通过。',
  '   **使用 submit_answer 之前一定要先检查一下「提交结果 dialog」是不是还开着**——上一次提交留下的结果弹窗会挡住作答区和提交按钮，',
  '   开着就先 close_dialogs 关掉再提交。（弹窗有时不会自己关掉：read_judge_result 只能关它认得出来的那些，判题没结束就关不掉。）',
  '   提交后如果判题一直不出结论，**你有权利调用 refresh_page 刷新页面**，也可以再调 read_judge_result 等一次。',
  '5. simulate_keyboard_input 的按键是模拟的，浏览器默认行为（在输入框里换行、提交表单）不会发生，只对页面自己写的按键监听有效；要触发提交就找页面的按钮点它。',
  '',
  '动用户代码的硬规矩（重要）：',
  '6. **改代码/提交前先问**：除非用户本条消息已经明确要求「帮我改 / 修一下 / 写代码 / 提交」，',
  '   否则 write_editor_code 和 submit_answer 之前必须先 ask。系统会拦下未询问的这类调用，别浪费一轮去撞墙。',
  '   用户选了「先别改」就停下，用文字讲清楚该怎么改，不要再动他的代码。',
  '7. **改完用户一定会看到 diff**：write_editor_code 成功后插件自动展示改动前后对照（自动生成的 diff 卡片），',
  '   你不需要再调 diff；只在用户要求复看某次改动时才调用。',
  '8. **尽量不对用户代码做大改**：能做局部修补就别整段重写；保留用户原来的变量名、注释和写法风格，',
  '   他写错的地方只改错的那几行。如果确实需要大改，先用 ask 说明理由并征得同意。',
  '   **不要把他已经拆出来的函数又内联回调用处**：他抽成函数就是想要这个结构，除非他自己要求合并，否则保持函数形态。',
  '   同理，不要删掉或改名他已经写好的辅助函数、常量和工具类。',
  '9. **需要用户拍板时不要在正文里列选项**：像「要我提交吗？」「需要修改吗？」「选哪种做法？」这类问题，',
  '   必须调用 ask 并给出 2–4 个选项；正文只保留一句说明。系统会把正文里的选项解析成 ask 卡片，但不要依赖它。',
  '10. **提交是有副作用的动作**：只在该问清楚之后提交；提交失败/超时按工具返回值处理，不要反复盲提交。',
].join('\n');

export interface ToolSchema {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'read_problem',
      description:
        '拿到用户当前这道题的题面（标题、地址、题目 ID、题目描述原文、样例输入输出）。公式会转成 LaTeX 写进题面里；题面用图片画的公式会给出图片的 alt/链接，需要你自己看图理解。想解题先调它，不要靠猜页面内容。'
        + '返回值第一行会写明**题目类型**（编程题 / 选择题 / 判断题 / 代码填空 / 多文件）；是选择题或判断题时，会把这一页上**所有小题**连同各自的选项一起列出来，答案要用空格分隔后交给 write_editor_code。',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'number', description: '题面最多返回多少字符，默认 6000' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_editor_code',
      description:
        '读出作答区里用户当前写的代码。优先通过编辑器实例读完整文档，拿不到实例才退回 DOM。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_editor_code',
      description:
        '把代码写进作答区（默认整段覆写）。优先用编辑器实例的 dispatch 原子写入，绕开自动闭合与自动缩进；写完会自动检查：回读逐行比对、拿题面第一组样例按**页面上选定的语言**编译并比对输出、看提交按钮是否可用，结果里都会写明。要改用户的代码就用它，不要用 js_inject 去改 DOM 或模拟粘贴。'
        + '题目是**选择题或判断题**时，作答区不是代码框而是一堆单选框：这个工具会把内容按空格拆开，第一个答案对第一题、第二个对第二题，以此类推（可以写选项字母 A/B/C/D，也可以写选项原文）。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要写入的完整代码' },
          clear: {
            type: 'boolean',
            description: '是否整段覆写，默认 true；填 false 表示追加到已有内容之后',
          },
          verify: {
            type: 'boolean',
            description: '写入后是否自动做检查（样例编译比对 + 提交按钮状态），默认 true',
          },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compile_and_run_c',
      description:
        '用插件内置的编译器（本地 Clang 编译成 WebAssembly 运行，不联网、代码不出本机）把一段 C 代码编译并运行，指定标准输入后拿回运行输出与编译错误。写完代码应该先用它跑一遍题目给的样例输入，确认输出对得上再交给用户。首次调用要加载编译器（几秒），之后每次一两秒。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '完整的 C 源代码' },
          stdin: { type: 'string', description: '标准输入内容，按题目的样例输入原样填，没有就留空' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_answer',
      description:
        '点提交按钮把当前代码提交到 PTA 并向判题系统要结论（会等一段时间）。只在用户同意、或者用户明确让你提交时用。提交前先确认代码已经写进作答区并自己跑过样例。**调用之前一定要先检查「提交结果 dialog」是不是还开着**——开着就先 close_dialogs 关掉，否则点不到提交按钮。等待超时会直接报错给你，此时你可以 refresh_page 刷新页面再来一次。',
      parameters: {
        type: 'object',
        properties: {
          waitSeconds: { type: 'number', description: '最多等多少秒看结论，默认 20，上限 120' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_judge_result',
      description:
        '读当前判题结果（不点任何按钮）。它会每 0.3 秒检查一次页面，一直等到能读出真正的结论（AC/WA/CE…，**PC 表示「部分正确」，只拿到部分测试点的分，不等于做对了**）为止，默认最多等 60 秒（可调到 120）。拿到结论后会自动尝试关闭判题弹窗——但**弹窗不一定关得掉**（判题没结束、或者它没认出来），关不掉时你会看到提示，这时该用 close_dialogs 手动关。',
      parameters: {
        type: 'object',
        properties: {
          waitSeconds: { type: 'number', description: '最多等多少秒，默认 60，上限 120' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'js_inject',
      description:
        '在用户当前所在网页里执行一段 JavaScript（运行在页面主世界，能访问页面的 JS 变量与 DOM），返回执行结果。代码里用 return 返回要看的值，支持 await。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '要执行的 JavaScript 代码，例如 "return document.title"' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'date',
      description: '获取当前的日期和时间（含星期）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'url',
      description: '获取用户当前所在页面的完整地址。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulate_keyboard_input',
      description:
        '往页面上的输入框或可编辑区域（含代码编辑器）里输入文字，也可以按下 Enter、Escape、Tab、方向键这类按键。要让页面真正收到输入就用这个工具，不要用 js_inject 直接改 value。不填 selector 时会自动找页面上最大的可编辑区域（PTA 的作答区），找不到才用当前焦点元素。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文字' },
          selector: {
            type: 'string',
            description:
              '目标元素的 CSS 选择器，例如 "#answer"。不填会自动定位最大的可编辑区域（PTA 作答区）',
          },
          clear: { type: 'boolean', description: '输入前是否先清空目标里已有的内容，默认 false' },
          press: {
            type: 'string',
            description: '要按下的键名，例如 Enter、Escape、Tab、ArrowDown、Backspace',
          },
          perCharDelayMs: {
            type: 'number',
            description: '真实按键模式下每个字符之间的间隔毫秒数，默认 8，怕被编辑器吞字符就调大',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_document',
      description:
        '把内容写成文件并触发浏览器下载，用于交付题解、笔记这类文档。不要在回答里重复输出同一份内容。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名，带扩展名，例如 "题解-1.md"' },
          content: { type: 'string', description: '文件内容（markdown 或纯文本）' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_explanation_page',
      description:
        '交出一份苏格拉底式的讲解网页（用户点「/what」时用）。html 必须是一个**自包含的单文件**：'
        + '不引 CDN、不引外部字体、不要构建步骤，样式写在 <style> 里、逻辑写在 <script> 里。'
        + '内容是围绕这道题的选择题式引导：分阶段出题、答错给分级提示、答对才给解释，可以再配一个可交互的动态演示。'
        + '交完之后插件会给用户一张「打开讲解页」的邀请卡片，所以调用这一次就够了，不用再把 HTML 贴进回答里。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '讲解页的标题，例如「7-1 阶乘计算 · 苏格拉底式讲解」' },
          html: { type: 'string', description: '完整的单文件 HTML（要含 <html><head><style>…</style></head><body>…<script>…</script></body></html>）' },
        },
        required: ['title', 'html'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'next_problem',
      description:
        '切到题目列表里的下一道**还没做过**的题（用户点「/fuck」赶题模式时用）。'
        + '会自动跳过已经提交过的题；当前题型做完了会自动切到下一个题型分组（判断/选择/代码填空/编程…）。'
        + '返回新题的标题、地址、题型、这是第几题以及还剩几题。全部做完时会直接告诉你「没有下一题了」。'
        + '只在赶题模式里用；普通对话不要乱切题。',
      parameters: {
        type: 'object',
        properties: {
          skipCurrent: {
            type: 'boolean',
            description: '当前这道题做不出来（提交不了/两次都不对）时传 true，这道题就不再回来了',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask',
      description:
        '向用户提一个只能选答案的问题，会一直等用户点选才返回。选项 2–4 个、短、互斥、第一项推荐（比如「要不要我直接改作答区？」给「改」「先别改，只讲思路」）。'
        + '凡是能列选项的问题都必须用它（要不要改、要不要提交、选哪种做法），禁止在正文里列 1./2./- 选项；没有 ask 就改代码/提交会被系统拦下。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题，一句话说清楚' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: '可选的答案，2 到 4 个，第一个是推荐项',
          },
        },
        required: ['question', 'options'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description:
        '把改动前后的两段文本左右对照展示给用户（新增/修改/删除的行会分色标出）。'
        + 'write_editor_code 成功后插件会自动展示这次改动，通常不用再调用；只有用户想复看某次历史改动时才用。',
      parameters: {
        type: 'object',
        properties: {
          left: { type: 'string', description: '改动之前的内容（原文）' },
          right: { type: 'string', description: '改动之后的内容' },
          leftLabel: { type: 'string', description: '左列标题，默认「改动前」' },
          rightLabel: { type: 'string', description: '右列标题，默认「改动后」' },
        },
        required: ['left', 'right'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compile_and_run_python',
      description:
        '用插件内置的 Python 运行器（本地运行，不联网）把一段 Python 代码运行，指定标准输入后拿回运行输出与错误。写完代码应该先用它跑一遍题目样例。首次调用要加载 Python 运行时（几秒）。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '完整的 Python 源代码' },
          stdin: { type: 'string', description: '标准输入内容，按题目的样例输入原样填，没有就留空' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compile_and_run_js',
      description:
        '用插件内置的 JavaScript 运行器（本地运行，不联网）把一段 JavaScript 代码运行，指定标准输入后拿回运行输出与错误。写完代码应该先用它跑一遍题目样例。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '完整的 JavaScript 源代码' },
          stdin: { type: 'string', description: '标准输入内容，按题目的样例输入原样填，没有就留空' },
        },
        required: ['code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_pta_compile_result',
      description:
        '读取 PTA 页面上「编译器输出」区域的内容（最近一次运行的输出、异常堆栈、编译错误）。simulate_pta_run 已经带回了结果就不必再调；只是想去页面上确认一下时用它。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simulate_pta_run',
      description:
        '在 PTA 页面上跑一次测试：自动点开测试面板（Test Case / 测试用例），把数据集填进测试输入框，点「运行测试 / Run Test Case」，等结果出来并把内容读回来。可以传 stdin 把它当标准输入填进去（不传就用面板里已有的输入）。用于借用 PTA 自己的运行环境（插件内置编译器覆盖不到的语言时）。返回的就是运行结果，直接用，不必再调 read_pta_compile_result。',
      parameters: {
        type: 'object',
        properties: {
          stdin: {
            type: 'string',
            description: '要填进测试输入框的数据集（标准输入）。不填就沿用面板里原有的输入。',
          },
          waitSeconds: { type: 'number', description: '最多等多少秒，默认 60，上限 120' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_dialogs',
      description:
        '关掉挡在页面上的弹窗（判题结果弹窗、提交结果 dialog、提示框等）。**submit_answer 之前一定要先确认「提交结果 dialog」是不是还开着**，开着就先调这个，否则提交按钮点不到。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'refresh_page',
      description:
        '刷新当前页面（重新载入 PTA 当前地址）。判题一直卡住不出结论、页面状态乱了、提交按钮点不动的时候，用它把页面重新载入再来一遍。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as string[]).includes(value);
}

/** 解析模型给的参数，失败时把原因返回给模型让它重试 */
export function parseToolArguments(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (!raw.trim()) return { ok: true, args: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: '参数必须是一个 JSON 对象' };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, error: `参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}` };
  }
}

export function truncate(text: string, limit = MAX_TOOL_RESULT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（结果过长，已截断）`;
}
