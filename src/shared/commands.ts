// 斜杠指令：面板里输入「/」时列出来的那些。
//
// 放在 shared 是因为两端都要用：前端输入框拿它渲染菜单，后台靠它认出
// 「这条消息其实是条指令」，并据此改写这一轮的行为（放行权限、改提示词）。

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
 * /fuck（无人监管赶题模式）先不做：它要绕过提问门、自动提交、自动跳下一题，
 * 风险比收益大，等这批稳定了再单独加。
 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'new', name: '/new', summary: '开新会话，清空当前上下文' },
  { id: 'resolve', name: '/resolve', summary: '直接答题，自动放行写入与提交' },
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

/** 输入框里的「/xxx」按前缀筛出候选指令（空串时给全部） */
export function filterSlashCommands(prefix: string): SlashCommand[] {
  const needle = prefix.replace(/^\//, '').trim().toLowerCase();
  if (!needle) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) => command.id.startsWith(needle) || command.name.toLowerCase().includes(needle),
  );
}
