/** 工具名：js_inject / date / 三件套在 background 侧发起，其余在页面里执行 */
export type ToolName =
  | 'read_problem'
  | 'read_editor_code'
  | 'write_editor_code'
  | 'compile_and_run_c'
  | 'submit_answer'
  | 'read_judge_result'
  | 'close_dialogs'
  | 'js_inject'
  | 'date'
  | 'url'
  | 'write_document'
  | 'simulate_keyboard_input'
  | 'ask'
  | 'diff';

export const TOOL_NAMES: ToolName[] = [
  'read_problem',
  'read_editor_code',
  'write_editor_code',
  'compile_and_run_c',
  'submit_answer',
  'read_judge_result',
  'close_dialogs',
  'js_inject',
  'date',
  'url',
  'write_document',
  'simulate_keyboard_input',
  'ask',
  'diff',
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
  '- 代码用 ``` 代码块并标注语言（C 语言写 ```c）。',
  '- 数学公式用 $...$ 或 $$...$$。',
  '',
  '在 PTA 页面上做这些事，都有专用工具，优先用它们：',
  '- read_problem：拿到当前这道题的题面。要解题、要写代码之前，先调它。',
  '- read_editor_code：读出作答区里用户现在的代码。',
  '- write_editor_code：把代码写进作答区（默认整段覆写）。写完会自动回读比对、拿题面第一组样例编译比对输出、并看提交按钮能不能点——这三项结论都在返回值里；有「不一致/编译失败/按钮禁用」就先按结论修，别急着交付。',
  '',
  '- compile_and_run_c：用内置编译器（本地 Clang，不联网）把 C 代码编译并运行，可以给标准输入。写完代码要先用它跑一遍题目样例，确认输出对得上（首次调用要加载编译器几秒，之后很快）。',
  '- submit_answer：把当前代码提交到 PTA 并等判题结论；read_judge_result 等判题结论（会一直等到出结论，默认 60 秒）；close_dialogs 关掉挡着的弹窗（拿到结论之后再关）。',
  '  结论里的 **PC 就是「部分正确」**：只拿到了部分测试点的分，**不等于这题做对了**——要么照着题目继续改，要么明确告诉用户还差哪些测试点，不要当成 AC 收工。',
  '',
  '其它工具：',
  '- ask：向用户提问并等对方选一个选项（会阻塞到用户点选）。**改用户代码前必须先问**，用不用由用户拍板。',
  '- diff：把改动前后两段文本左右对照展示给用户，标出哪一行新增、哪一行改过、哪一行删了。改完代码一定要调用一次。',
  '- js_inject：在用户当前页面里执行 JavaScript 并把返回值带回来。用来**读**页面（看结构、找选择器、读文本）和做上面几个工具做不到的事。',
  '- simulate_keyboard_input：非 PTA 编辑器、或需要**真按键**（Enter/Tab/方向键）时才用。',
  '- url：拿到用户当前所在页面的地址。',
  '- date：拿到当前日期。',
  '- write_document：把整理好的内容写成文件下载到用户电脑。需要交付文档/题解时用它，不要在回答里贴整篇长文档。',
  '',
  '工具使用规则（重要）：',
  '1. 读题面用 read_problem，读代码用 read_editor_code，改代码用 write_editor_code。',
  '   **不要**用 js_inject 去 dispatch 编辑器、改 input.value、也不要想办法模拟粘贴——都要用上面的专用工具。',
  '2. 往非 PTA 的输入框里写内容才用 simulate_keyboard_input；它不填 selector 会自动定位最大的可编辑区域，输入后会回读比对，结果里写明是否一致——不一致就别继续往下推，先查原因。',
  '3. 需要页面上的信息时先看再答，不要凭空猜测页面内容。js_inject 里用 return 返回结果，异步代码可以直接 await。',
  '   写完 C 代码后，用 compile_and_run_c 拿题面的样例输入跑一遍：输出对不上就自己改，别把没验证的代码交给用户。',
  '4. submit_answer 是有副作用的动作：只有用户明确要求提交时才提交；提交前确认代码已经写进作答区、样例自测通过；拿到判题结论之后再用 close_dialogs 关弹窗。',
  '5. simulate_keyboard_input 的按键是模拟的，浏览器默认行为（在输入框里换行、提交表单）不会发生，只对页面自己写的按键监听有效；要触发提交就找页面的按钮点它。',
  '',
  '动用户代码的两条硬规矩（重要）：',
  '6. **改代码前先问**：除非用户在提问里已经明确说了「帮我改 / 修一下 / 写代码」这类要求，否则在 write_editor_code 之前',
  '   必须先用 ask 工具问一句（例如「要不要我直接改作答区？」，选项给「改」「先别改，只讲思路」）。',
  '   用户选了「先别改」就停下，用文字讲清楚该怎么改，不要再动他的代码。',
  '7. **改完必须让用户看见改了什么**：write_editor_code 之后立刻用 diff 工具把改动前后对照展示出来',
  '   （left 是改之前的代码，right 是改之后的），不要只在回答里用文字描述。',
  '8. **尽量不对用户代码做大改**：能做局部修补就别整段重写；保留用户原来的变量名、注释和写法风格，',
  '   他写错的地方只改错的那几行。如果确实需要大改，先用 ask 说明理由并征得同意。',
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
        '拿到用户当前这道题的题面（标题、地址、题目 ID、题目描述原文）。想解题先调它，不要靠猜页面内容。',
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
        '把代码写进作答区（默认整段覆写）。优先用编辑器实例的 dispatch 原子写入，绕开自动闭合与自动缩进；写完会自动检查：回读逐行比对、拿题面第一组样例编译并比对输出、看提交按钮是否可用，结果里都会写明。要改用户的代码就用它，不要用 js_inject 去改 DOM 或模拟粘贴。',
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
        '点提交按钮把当前代码提交到 PTA 并向判题系统要结论（会等一段时间）。只在用户同意、或者用户明确让你提交时用。提交前先确认代码已经写进作答区并自己跑过样例。',
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
        '读当前判题结果（不点任何按钮）。它会每 0.3 秒检查一次页面，一直等到能读出真正的结论（AC/WA/CE…，**PC 表示「部分正确」，只拿到部分测试点的分，不等于做对了**）为止，默认最多等 60 秒（可调到 120）。submit_answer 说还没出结论时，就调它等结果，不要反复空转；弹窗被关掉也不怕，它会回看页面上留着的判题记录。',
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
      name: 'close_dialogs',
      description: '关掉挡在页面上的弹窗（判题结果弹窗、提示框等）。拿到判题结论之后再关。',
      parameters: { type: 'object', properties: {}, required: [] },
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
      name: 'ask',
      description:
        '向用户提一个只能选答案的问题，会一直等用户点选才返回。选项要短、要互斥、包含用户可能的真实意图（比如「要不要我直接改作答区？」给「改」「先别改，只讲思路」）。要改用户代码而用户没明说的时候，必须先调用它。',
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
        '把改动前后的两段文本左右对照展示给用户（新增/修改/删除的行会分色标出），让用户一眼看出你把代码改成了什么样。改完 write_editor_code 必须调用一次。',
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
