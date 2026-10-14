/** 工具名：js_inject / date 在 background 执行，url / write_document 在页面里执行 */
export type ToolName = 'js_inject' | 'date' | 'url' | 'write_document';

export const TOOL_NAMES: ToolName[] = ['js_inject', 'date', 'url', 'write_document'];

/** 一次对话最多跑几轮工具，防止模型来回刷 */
export const MAX_TOOL_ROUNDS = 6;

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
  '可以用这些工具：',
  '- url：拿到用户当前所在页面的地址',
  '- date：拿到当前日期',
  '- js_inject：在用户浏览器当前页面里执行一段 JavaScript，把返回值带回来。用它读取或操作页面内容。',
  '- write_document：把整理好的内容写成文件下载到用户电脑。需要交付文档/题解时用它，不要在回答里贴整篇长文档。',
  '',
  '注意：需要页面上的信息时先用 url / js_inject 去看，不要凭空猜测页面内容；js_inject 里用 return 返回结果，异步代码可以直接 await。',
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
