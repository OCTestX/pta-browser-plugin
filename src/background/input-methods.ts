import { isAbortError, throwIfAborted } from '../shared/abort';
import { findInputMethod, WRITE_FALLBACK_CHAIN } from '../shared/input-methods';
import type { ToolOutcome } from './agent';
import { compareOutput } from './compile';
import { clickAt, createDebuggerIo, detach } from './debugger-input';
import { injectScript } from './js-inject';
import { INPUT_METHOD_SCRIPT } from './pta-scripts';
import { describeTypist, runTypist } from './typist';


/** 单次执行一种写入方法（页面脚本 JSON 模式），返回回读比对结果 */
async function writeOnce(
  tabId: number,
  method: string,
  code: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; detail: string }> {
  const result = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method, text: code, json: true }, undefined, signal);
  // injectScript 会把对象 JSON 化，这里解析回来
  try {
    const parsed = JSON.parse(result.output) as { ok: boolean; detail: string };
    return parsed;
  } catch {
    return { ok: false, detail: result.output };
  }
}

/** 清空作答区：换备用实现之前先把内容全部删掉 */
async function clearEditor(tabId: number, signal?: AbortSignal): Promise<void> {
  const result = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'clear', text: '' }, undefined, signal);
  if (!result.ok || !result.output.includes('已清空')) {
    throw new Error(result.output);
  }
}

/** 回读编辑器全文（优先编辑器实例） */
async function readDoc(tabId: number, signal?: AbortSignal): Promise<string> {
  const result = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'readDoc', text: '' }, undefined, signal);
  return result.output;
}

/**
 * 写入工具的完整链路：默认「先 focus 再 dispatch」→ 回读比对，
 * 不一致就清空作答区，按备用顺序（replaceSelection → CDP 真实点击 + 逐字 → 整段 dispatch）重试；
 * 全部失败则报错（会列出每一次尝试的原因）。
 */
export async function writeEditorCode(options: {
  tabId: number;
  code: string;
  /** 传了就能被面板的「停止」打断：每种写入方法前后都看一眼标记 */
  signal?: AbortSignal;
}): Promise<ToolOutcome> {
  const attempts: string[] = [];
  const { signal } = options;

  for (const method of WRITE_FALLBACK_CHAIN) {
    try {
      // 换下一种实现之前先确认没被停掉，否则会把作答区清空却什么都没写进去
      throwIfAborted(signal);
      await clearEditor(options.tabId, signal);
      const result = await writeOnce(options.tabId, method, options.code, signal);
      if (result.ok) {
        const parts = [`写入成功（${findInputMethod(method).label}）`, result.detail];
        if (attempts.length > 0) parts.push(`之前失败的尝试：${attempts.join('；')}`);
        return { output: parts.join('；'), isError: false };
      }
      attempts.push(`${findInputMethod(method).label}——${result.detail}`);
    } catch (error) {
      // 被用户停掉的不算「这种写法失败」，别再往下一种实现接着试
      if (isAbortError(error, signal)) throw error;
      attempts.push(
        `${findInputMethod(method).label}——${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    output: `四种写入方法全部失败（作答区已清空）：${attempts.join('；')}`,
    isError: true,
  };
}

/**
 * 设置页「模拟输入测试」：单次执行一种方法，文本汇报（含回读比对）。
 * 不看「用调试器发送真实按键」开关 —— CDP 方法一律直接尝试。
 */
export async function runInputMethod(options: {
  methodId: string;
  text: string;
  tabId: number;
}): Promise<ToolOutcome> {
  const { methodId, text, tabId } = options;
  const method = findInputMethod(methodId);

  if (!text.trim()) return { output: '测试文本是空的', isError: true };

  try {
    if (method.id === 'cdpSysTyping' || method.id === 'cdpClickTyping') {
      // CDP 真实点击：先用页面报告的坐标发真实鼠标点击聚焦
      if (method.id === 'cdpClickTyping') {
        const rectRaw = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'rect', text });
        const rect = parseRect(rectRaw.output);
        if (rect) await clickAt(tabId, rect.x, rect.y);
      }
      await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: 'cdpClickTyping', text: '' });
      const stats = await runTypist(createDebuggerIo(tabId, 'char'), text, 8);
      const actual = await readDoc(tabId);
      return {
        output: `${method.label}：${describeTypist(stats)}；${compare(actual, text)}`,
        isError: false,
      };
    }

    // 其余两种都在页面脚本里（文本汇报，含页面提示）
    const page = await injectScript(tabId, INPUT_METHOD_SCRIPT, { method: method.id, text });
    return { output: `${method.label}：${page.output}`, isError: !page.ok };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { output: `${method.label} 失败：${reason}`, isError: true };
  } finally {
    await detach(tabId);
  }
}

/** 原子写入后戳一下页面：净效果为零，但产生真实输入事件，让页面的「已修改」标记生效 */
export async function pokeEditor(tabId: number): Promise<string> {
  const io = createDebuggerIo(tabId, 'char');
  await io.typeChar(' ');
  await io.press('Backspace');
  return '已用真实按键敲了一个字符再删掉（触发页面的修改标记）';
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
