// 斜杠指令：面板里输入「/」时列出来的那些。
//
// 放在 shared 是因为两端都要用：前端输入框拿它渲染菜单，后台靠它认出
// 「这条消息其实是条指令」，并据此改写这一轮的行为（放行权限、改提示词）。

import type { ApiMessage } from './types';

export interface SlashCommand {
  /** 指令 id（不含斜杠） */
  id: string;
  /** 菜单里显示的名字 */
  name: string;
  /** 右边那句简短解释 */
  summary: string;
}

/**
 * 目前支持的指令。
 *
 * /fuck 是「极限赶时间无人监管模式」：不问、不解释、直接提交，
 * 提交完自动切到下一题接着做，直到题目列表做完或者用户按停止。
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'new', name: '/new', summary: '开新会话，清空当前上下文' },
  { id: 'resolve', name: '/resolve', summary: '直接答题，自动放行写入与提交' },
  { id: 'fuck', name: '/fuck', summary: '赶时间模式：直接做题直接提交，一路做完所有题' },
  { id: 'what', name: '/what', summary: '苏格拉底式讲解题面，生成可交互网页' },
  { id: 'why', name: '/why', summary: '讲解当前代码错在哪里' },
];

/** 认出消息开头的斜杠指令；不是指令就返回 null */
export function parseSlashCommand(text: string): { id: string; rest: string } | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/);
  if (!match) return null;
  const id = match[1].toLowerCase();
  if (!SLASH_COMMANDS.some((command) => command.id === id)) return null;
  return { id, rest: match[2].trim() };
}

/**
 * 这个指令是不是「用户已经明确授权你改代码、并且提交」。
 *
 * /resolve 与 /fuck 都是用户自己点出来的明确授权，所以这一轮不用再 ask。
 * 放这里是为了能脱离浏览器单测（后台的 agent.ts 依赖 chrome.*，测不了）。
 */
export function commandForcesWrite(commandId: string | undefined): boolean {
  return commandId === 'resolve' || commandId === 'fuck';
}

/** 输入框里的「/xxx」按前缀筛出候选指令（空串时给全部） */
export function filterSlashCommands(prefix: string): SlashCommand[] {
  const needle = prefix.replace(/^\//, '').trim().toLowerCase();
  if (!needle) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) => command.id.startsWith(needle) || command.name.toLowerCase().includes(needle),
  );
}

/**
 * 把指令说明并进**开头的 system 消息**。
 *
 * OpenAI 兼容接口要求 system 必须排在最前面；以前把 `/why` 的说明 push 到消息末尾，
 * 模型直接返回 HTTP 400「System message must be at the beginning」，所有斜杠指令都失效。
 */
export function buildConversation(
  systemPrompt: string,
  messages: ApiMessage[],
  instruction = '',
): ApiMessage[] {
  const system = instruction ? `${systemPrompt}\n\n${instruction}` : systemPrompt;
  return [{ role: 'system', content: system }, ...messages];
}
