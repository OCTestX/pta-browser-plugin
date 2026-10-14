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
  | 'simulate_keyboard_input';

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
  '- submit_answer：把当前代码提交到 PTA 并等判题结论；read_judge_result 读当前结论；close_dialogs 关掉挡着的弹窗（拿到结论之后再关）。',
  '',
  '其它工具：',
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
        '读当前判题结果（不点任何按钮）。submit_answer 说还没出结论时，可以过一会儿再调它看；拿到结论之前不要关判题弹窗。',
      parameters: { type: 'object', properties: {}, required: [] },
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
