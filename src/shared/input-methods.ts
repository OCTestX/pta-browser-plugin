/**
 * 往作答区里写字的方法清单：一种方法一个按钮，逐个实测哪种不会被页面拦住。
 * 这里只放数据（content 侧要渲染按钮，background 侧要实现），实现在 background/input-methods.ts。
 */
export interface InputMethod {
  id: string;
  label: string;
  hint: string;
  group: string;
}

export const INPUT_METHODS: InputMethod[] = [
  // ---- 编辑器状态（CodeMirror 自己的 API）----
  {
    id: 'dispatch',
    label: '整段 dispatch',
    hint: 'view.dispatch 一次换掉全文（实测可用，write_editor_code 走的就是它）',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'dispatchFocus',
    label: '先 focus 再 dispatch',
    hint: '先 view.focus() 再整段替换，有的页面会检查编辑器有没有焦点',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'dispatchUserEvent',
    label: 'dispatch + 标注输入',
    hint: '整段替换并标 userEvent=input.type，让页面当成「输入」而不是程序改动',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'replaceSelection',
    label: 'replaceSelection',
    hint: '用 view.state.replaceSelection 生成事务再 dispatch（CM6 的另一种写法）',
    group: '编辑器状态（CM6 API）',
  },
  {
    id: 'dispatchTyped',
    label: '逐行 dispatch',
    hint: '逐行多次事务 + userEvent，像「输入过程」而不是一次替换',
    group: '编辑器状态（CM6 API）',
  },

  // ---- CDP：走浏览器真实输入管线 ----
  {
    id: 'cdpSysTyping',
    label: 'CDP 逐字真实按键',
    hint: '逐字发真实按键（含自动闭合幻影调和），最接近手打',
    group: 'CDP 真实输入',
  },
  {
    id: 'cdpClickTyping',
    label: 'CDP 真实点击 + 逐字按键',
    hint: '先用 CDP 发鼠标点击聚焦编辑器，再逐字按键',
    group: 'CDP 真实输入',
  },
  {
    id: 'cdpKeyDownText',
    label: 'CDP keyDown+text 逐字',
    hint: '不用 char 事件，改用 keyDown 带 text 逐字敲',
    group: 'CDP 真实输入',
  },
  {
    id: 'cdpInsertText',
    label: 'CDP 整段插入',
    hint: '聚焦后一条 Input.insertText 把整段文字插进去',
    group: 'CDP 真实输入',
  },

  // ---- DOM 与事件 ----
  {
    id: 'execCommand',
    label: 'execCommand 整段插入',
    hint: '聚焦 + 全选后用 document.execCommand("insertText")',
    group: 'DOM 与事件',
  },
  {
    id: 'inputEvents',
    label: '手工派发 beforeinput+input',
    hint: '不改 DOM，只派发事件（isTrusted=false）',
    group: 'DOM 与事件',
  },
  {
    id: 'domMutation',
    label: '改 DOM + 派发 input',
    hint: '先把内容节点换成目标文本，再派发 input',
    group: 'DOM 与事件',
  },
  {
    id: 'composition',
    label: '模拟输入法事件链',
    hint: 'compositionstart/update/end + beforeinput(insertCompositionText)',
    group: 'DOM 与事件',
  },
  {
    id: 'pasteEvent',
    label: '手工派发 paste 事件',
    hint: '构造 ClipboardEvent 派发（isTrusted=false）',
    group: 'DOM 与事件',
  },
  {
    id: 'valueSetter',
    label: '原生 value setter',
    hint: '给 <input>/<textarea> 用；在 CodeMirror 上无效，留作对照',
    group: 'DOM 与事件',
  },

  // ---- 剪贴板 ----
  {
    id: 'clipboardPaste',
    label: '剪贴板 + 真 Ctrl+V',
    hint: '写剪贴板后由插件发真粘贴（预期被 onpaste 拦住，作对照）',
    group: '剪贴板',
  },
  {
    id: 'execCommandPaste',
    label: '剪贴板 + execCommand(paste)',
    hint: '写剪贴板后调 document.execCommand("paste")',
    group: '剪贴板',
  },
];

export const INPUT_METHOD_GROUPS: string[] = [
  ...new Set(INPUT_METHODS.map((method) => method.group)),
];

export const DEFAULT_INPUT_METHOD = INPUT_METHODS[0].id;

export function findInputMethod(id: string): InputMethod {
  return INPUT_METHODS.find((method) => method.id === id) ?? INPUT_METHODS[0];
}

export function inputMethodIndex(id: string): number {
  return Math.max(0, INPUT_METHODS.findIndex((method) => method.id === id));
}
