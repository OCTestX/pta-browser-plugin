import type { Settings } from '../shared/settings';
import { findInputMethod } from '../shared/input-methods';
import type { ToolOutcome } from './agent';
import { compareOutput } from './compile';
import { clickAt, createDebuggerIo, detach, insertTextOnce, pressWithCtrl } from './debugger-input';
import { injectScript } from './js-inject';
import { INPUT_METHOD_SCRIPT } from './pta-scripts';
import { describeTypist, runTypist } from './typist';

/**
 * 设置页「模拟输入测试」的执行侧：一种方法一个按钮，逐个实测哪种不会被页面拦住。
 * **不看「用调试器发送真实按键」这个开关** —— CDP 类方法一律直接尝试，挂不上就如实报错。
 */

interface RunInputMethodOptions {
  methodId: string;
  text: string;
  tabId: number;
  settings: Settings;
  runPageTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

/** 走页面脚本就能完成的方法 */
const PAGE_METHODS = new Set([
  'dispatch',
  'dispatchFocus',
  'dispatchUserEvent',
  'replaceSelection',
  'dispatchTyped',
  'execCommand',
  'inputEvents',
  'domMutation',
  'composition',
  'pasteEvent',
  'valueSetter',
  'execCommandPaste',
]);

export async function runInputMethod(options: RunInputMethodOptions): Promise<ToolOutcome> {
  const { methodId, text, tabId } = options;
  const method = findInputMethod(methodId);

  if (!text.trim()) return { output: '测试文本是空的', isError: true };

  try {
    if (PAGE_METHODS.has(method.id)) {
      const page = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: method.id, text });
      return finish(method.label, page.ok, page.output);
    }

    if (method.id === 'cdpSysTyping' || method.id === 'cdpKeyDownText') {
      // 逐字真实按键：先让页面聚焦（顺带选中原文），再逐字敲
      const focused = await options.runPageTool('simulate_keyboard_input', {
        focusOnly: true,
        clear: true,
      });
      if (focused.isError) return { output: focused.output, isError: true };
      const mode = method.id === 'cdpKeyDownText' ? 'keyDownText' : 'char';
      const stats = await runTypist(createDebuggerIo(tabId, mode), text, 8);
      const readBack = await options.runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：${describeTypist(stats)}；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    if (method.id === 'cdpClickTyping') {
      // 先用 CDP 发一次真实鼠标点击聚焦，再逐字敲
      const rectRaw = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'rect', text });
      const rect = parseRect(rectRaw.output);
      if (rect) await clickAt(tabId, rect.x, rect.y);
      const mode = 'char';
      const stats = await runTypist(createDebuggerIo(tabId, mode), text, 8);
      const readBack = await options.runPageTool('simulate_keyboard_input', { readOnly: true });
      const where = rect ? `点击(${rect.x},${rect.y})后` : '（没拿到作答区坐标，直接）';
      return {
        output: `${method.label}：${where}${describeTypist(stats)}；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    if (method.id === 'cdpInsertText') {
      const focused = await options.runPageTool('simulate_keyboard_input', {
        focusOnly: true,
        clear: true,
      });
      if (focused.isError) return { output: focused.output, isError: true };
      await insertTextOnce(tabId, text);
      await sleep(200);
      const readBack = await options.runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：已整段插入 ${text.length} 个字符；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    if (method.id === 'clipboardPaste') {
      // 页面先把文本写进剪贴板，再由插件发真 Ctrl+V
      const page = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'clipboardPaste', text });
      if (!page.ok || !page.output.includes('MARK_CLIPBOARD_READY')) {
        return { output: `${method.label}：${page.output}`, isError: true };
      }
      await pressWithCtrl(tabId, 'v');
      await sleep(300);
      const readBack = await options.runPageTool('simulate_keyboard_input', { readOnly: true });
      return {
        output: `${method.label}：已写剪贴板并发送真 Ctrl+V；${compare(readBack.output, text)}`,
        isError: false,
      };
    }

    return { output: `没有实现的方法：${method.id}`, isError: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { output: `${method.label} 失败：${reason}`, isError: true };
  } finally {
    await detach(tabId);
  }
}

function finish(label: string, ok: boolean, output: string): ToolOutcome {
  return { output: `${label}：${output}`, isError: !ok };
}

function parseRect(output: string): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(output) as { x?: number; y?: number };
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // 拿不到就退回不用点击
  }
  return null;
}

function compare(actual: string, expected: string): string {
  const diff = compareOutput(expected, actual);
  return diff.same ? '回读比对：与目标一致' : `回读比对：与目标不一致（${diff.detail}）`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
