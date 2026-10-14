/**
 * 往作答区里写字：**实测可用的 4 种**（一种方法一个按钮，设置页里可以逐个试）。
 *
 * 2026-10-14 在 PTA 真实页面上逐个试过的结论：
 *   可用：先 focus 再 dispatch / 整段 dispatch / replaceSelection / CDP 真实点击 + 逐字按键
 *   不可用（会被页面弹「禁止粘贴」或内容进不去，已从按钮里撤掉）：
 *     CDP 逐字真实按键(char)、CDP keyDown+text、CDP 整段 insertText、execCommand(insertText)、
 *     手工派发 beforeinput+input、改 DOM + 派发 input、模拟输入法事件链、手工派发 paste 事件、
 *     原生 value setter、剪贴板 + 真 Ctrl+V、剪贴板 + execCommand(paste)、
 *     dispatch + userEvent 标注、逐行 dispatch
 */
export interface InputMethod {
  id: string;
  label: string;
  hint: string;
  group: string;
}

export const INPUT_METHODS: InputMethod[] = [
  {
    id: 'dispatchFocus',
    label: '先 focus 再 dispatch',
    hint: '先 view.focus() 再整段替换（写入工具的默认实现）',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'dispatch',
    label: '整段 dispatch',
    hint: 'view.dispatch 一次换掉全文',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'replaceSelection',
    label: 'replaceSelection',
    hint: '用 view.state.replaceSelection 生成事务再 dispatch',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'cdpClickTyping',
    label: 'CDP 真实点击 + 逐字按键',
    hint: '先用 CDP 发真实鼠标点击聚焦，再逐字敲（模拟手打）',
    group: 'CDP 真实输入',
  },
];

export const INPUT_METHOD_GROUPS: string[] = [
  ...new Set(INPUT_METHODS.map((method) => method.group)),
];

/** 写入工具的默认实现 */
export const DEFAULT_WRITE_METHOD = 'dispatchFocus';

/**
 * 写入工具的备用顺序：先默认实现，再依次兜底。
 * 每次失败都会先清空作答区，再用下一种重写。
 */
export const WRITE_FALLBACK_CHAIN: string[] = [
  'dispatchFocus',
  'replaceSelection',
  'cdpClickTyping',
  'dispatch',
];

export const DEFAULT_INPUT_METHOD = DEFAULT_WRITE_METHOD;

export function findInputMethod(id: string): InputMethod {
  return INPUT_METHODS.find((method) => method.id === id) ?? INPUT_METHODS[0];
}

export function inputMethodIndex(id: string): number {
  return Math.max(0, INPUT_METHODS.findIndex((method) => method.id === id));
}
