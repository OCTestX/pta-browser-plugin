import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 面板里没有 clipboard 权限，用 execCommand 复制（用户点击触发，够用）。
 *
 * 先试 navigator.clipboard.writeText：它在部分环境里更稳；
 * 失败或者没有这个 API 时退回 execCommand。
 */
export function copyText(text: string): void {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
      return;
    }
  } catch {
    // 落到兜底
  }
  fallbackCopy(text);
}

function fallbackCopy(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.documentElement.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // 复制失败就算了，用户可以自己选
  }
  area.remove();
}

/**
 * 「复制」按钮的状态：点一下显示「已复制」，一会儿自己变回去。
 *
 * @param getText 取要复制的文本（点的时候再取，流式输出中拿到的是最新内容）
 */
export function useCopy(getText: () => string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    copyText(getText());
    setCopied(true);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1200);
  }, [getText]);

  return [copied, copy];
}
