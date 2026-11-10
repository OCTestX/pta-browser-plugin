/**
 * 「编辑器增强」（整理代码 / 彩虹括号 / 实时检查 / 函数中文注释）的跨世界消息契约。
 *
 * 为什么需要跨世界：PTA 的 CodeMirror 实例只挂在页面的 JS 对象上，只有 MAIN world
 * 拿得到 EditorView；而 `chrome.runtime` 只有隔离世界的 content script 能调。
 * 两边的桥是 `window.postMessage`（实测双向都能送达）。
 *
 * 消息形状钉在这一个文件里：MAIN world 的脚本（字符串，见
 * `src/background/editor-agent.ts`）和 content script（TS，见
 * `src/content/editor-assist.ts`）都按它来。改字段只改这里。
 *
 * 注意：MAIN world 的脚本拿不到模块系统，它把 `ASSIST_MESSAGE_KEY` 和下面的
 * 消息形状**各抄一份**；改这里时必须同步改 `editor-agent.ts` 顶部那段注释里的
 * 常量，否则两边对不上，消息会被 `isAssistMessage` 全部筛掉。
 */

import type { CFunctionDoc } from './c-library-docs';

/** 载荷上的标记字段：值是我们生成的随机 token，用来过滤页面自己的消息 */
export const ASSIST_MESSAGE_KEY = '__ptaEditorAssist';

/** 协议版本：页面脚本与 content script 对不上就重建 agent */
export const EDITOR_ASSIST_VERSION = 1;

/**
 * 功能开关。分两批上线：
 *   · v4.2 只开 format / rainbow；
 *   · v5.0 再打开 check（内置编译器实时检查）与 hover（标准库中文注释）。
 * 关掉的功能，页面脚本连监听器都不装，不白费 CPU。
 */
export interface EditorAssistFeatures {
  format: boolean;
  rainbow: boolean;
  check: boolean;
  hover: boolean;
}

/** 注入 MAIN world 脚本时塞进 `__args` 的参数 */
export interface EditorAssistInstallArgs {
  token: string;
  version: number;
  /** 标准库函数中文说明表（页面脚本直接查，不必每次回来问） */
  docs: Record<string, CFunctionDoc>;
  features: EditorAssistFeatures;
}

/** 一个括号：绝对字符下标 + 层级（层级已对颜色表取模） */
export interface BracketMark {
  at: number;
  depth: number;
}

/**
 * 一条要画波浪线的诊断。
 *
 * `from` / `to` 是**字符下标**（0 基，[from, to)），不是 clang 的行列号：
 * clang 的列号按 UTF-8 字节算，含中文的行会偏大，换算在后台用
 * `offsetOfPosition` 一次做掉，页面脚本只管画。
 */
export interface DiagnosticBox {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'note';
  message: string;
  advice: string;
}

/** MAIN world 的 agent → 隔离世界 */
export type AgentEvent =
  /** 找到了可写编辑器（换题、字体变化后会重发） */
  | { kind: 'hello'; version: number; language: string }
  | { kind: 'editor-lost' }
  /** 正文变了。content script 据此算彩虹括号 / 触发编译检查（已防抖） */
  | { kind: 'doc'; text: string; language: string; check?: boolean; fragment?: boolean }
  /** 用户点了「整理代码」 */
  | { kind: 'format-request'; text: string; language: string };

/** 隔离世界 → MAIN world 的 agent */
export type AgentCommand =
  | { kind: 'rainbow'; text: string; marks: BracketMark[] }
  /**
   * `source` 是发起整理时的原文：应用到页面前会比一次，
   * 用户在这几百毫秒里又敲了字就整条丢掉，绝不覆盖新内容。
   */
  | { kind: 'format-apply'; source: string; text: string; summary: string }
  /** `note` 有值表示这次没检查（比如语言不是 C），只更新提示文案 */
  | { kind: 'diagnostics'; text: string; boxes: DiagnosticBox[]; note?: string };

/**
 * 是不是我们自己的消息。
 *
 * 只看标记字段：token 由 content script 生成、每次安装都换，页面脚本即使
 * 旁听到了也没法用它做别的事（能做的只是再发一条一样形状的消息）。
 */
export function isAssistMessage(data: unknown, token: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  return record[ASSIST_MESSAGE_KEY] === token && typeof record.kind === 'string';
}

/** 造一条发给页面脚本的消息载荷 */
export function assistMessage(token: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { [ASSIST_MESSAGE_KEY]: token, ...payload };
}
