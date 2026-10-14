import type { Settings } from '../shared/settings';
import { createDebuggerIo, detach, insertTextOnce, pressWithCtrl } from './debugger-input';
import { compareOutput } from './compile';
import { injectScript } from './js-inject';
import { INPUT_METHOD_SCRIPT } from './pta-scripts';
import { findInputMethod } from '../shared/input-methods';
import { describeTypist, runTypist } from './typist';
import type { ToolOutcome } from './agent';

/**
 * 往作答区里写字的多种方法，从「最像手打」到「最直接」。
 * 设置页的测试按钮每点一次换下一种，用来实测哪种不会被 PTA 拦住。
 */
interface RunInputMethodOptions {
  methodId: string;
  text: string;
  tabId: number;
  settings: Settings;
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

export async function runInputMethod(options: RunInputMethodOptions): Promise<ToolOutcome> {
  const { methodId, text, tabId, settings, runPageTool } = options;
  const method = findInputMethod(methodId);

  if (!text.trim()) return { output: '测试文本是空的', isError: true };

  try {
    if (method.id === 'cdp-typing') {
      // 先把焦点放到作答区（顺带选中原文，输入会替换掉它）
      const focused = await runPageTool('simulate_keyboard_input', { focusOnly: true, clear: true });
      if (focused.isError) return focused;
      const stats = await runTypist(createDebuggerIo(tabId), text, 8);
      const readBack = await runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：${describeTypist(stats)}；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    if (method.id === 'cdp-insert-text') {
      const focused = await runPageTool('simulate_keyboard_input', { focusOnly: true, clear: true });
      if (focused.isError) return focused;
      await insertTextOnce(tabId, text);
      await sleep(200);
      const readBack = await runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：已整段插入 ${text.length} 个字符；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    if (method.id === 'clipboard') {
      // 先让页面把文本写进剪贴板，再由插件发真 Ctrl+V（预期会被 onpaste 拦住，作对照）
      const page = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'clipboard', text });
      if (!page.ok) return { output: page.output, isError: true };
      await pressWithCtrl(tabId, 'v');
      await sleep(300);
      const readBack = await runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：${page.output}；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    // 其余方法都在页面脚本里做（主世界：要摸编辑器实例）
    const page = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: method.id, text });
    return { output: page.output, isError: !page.ok };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { output: `${method.label} 失败：${reason}`, isError: true };
  } finally {
    if (settings.useDebuggerInput || method.id.startsWith('cdp') || method.id === 'clipboard') {
      await detach(tabId);
    }
  }
}

function compare(actual: string, expected: string): string {
  const diff = compareOutput(expected, actual);
  return diff.same ? '回读比对：与目标一致' : `回读比对：与目标不一致（${diff.detail}）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
