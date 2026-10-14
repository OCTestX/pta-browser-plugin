/**
 * 往作答区里写字的方法清单：从「最像手打」到「最直接」。
 * 设置页的测试按钮每点一次换下一种，用来实测哪种不会被 PTA 拦住。
 * （具体实现在 background/input-methods.ts，这里只放数据，content 侧也要用来显示"现在是第几种"。）
 */
export interface InputMethod {
  id: string;
  label: string;
  hint: string;
}

export const INPUT_METHODS: InputMethod[] = [
  {
    id: 'cdp-typing',
    label: 'CDP 逐字真实按键',
    hint: '走 chrome.debugger 逐字发真实按键（含幻影调和），最接近手打，需要调试器能挂上',
  },
  {
    id: 'cdp-insert-text',
    label: 'CDP 整段插入',
    hint: '聚焦后一条 Input.insertText 把整段文字插进去（输入法式插入）',
  },
  {
    id: 'execCommand',
    label: 'execCommand 整段插入',
    hint: '聚焦 + 全选后用 document.execCommand("insertText") 整段插入',
  },
  {
    id: 'inputEvents',
    label: '手工派发输入事件',
    hint: '派发 beforeinput + input（isTrusted=false），不改 DOM',
  },
  {
    id: 'dispatch',
    label: '编辑器实例整段 dispatch',
    hint: 'view.dispatch 一次换掉全文，完全不产生输入事件',
  },
  {
    id: 'dispatchTyped',
    label: '编辑器实例逐行 dispatch',
    hint: '逐行多次 transaction 并标注 userEvent=input.type，像"输入过程"',
  },
  {
    id: 'clipboard',
    label: '剪贴板 + 真 Ctrl+V（对照）',
    hint: '写剪贴板再发真粘贴；按同行实测这条预期会被 onpaste 拦住，用来对照',
  },
];

export const DEFAULT_INPUT_METHOD = INPUT_METHODS[0].id;

export function findInputMethod(id: string): InputMethod {
  return INPUT_METHODS.find((method) => method.id === id) ?? INPUT_METHODS[0];
}

