import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';

/** 面板的位置与大小：一起存、一起夹在视口里 */
export interface PanelLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

const STORAGE_KEY = 'pta-assistant-panel-layout';
/** 老版本只存过位置，换 key 时顺手删掉，别在存储里留垃圾 */
const LEGACY_KEY = 'pta-assistant-panel-position';
const MARGIN = 8;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 320;

/** 面板布局存在 chrome.storage.local 里，刷新页面后还在 */
export function usePanelLayout(panelRef: React.RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<PanelLayout | null>(null);
  // 拖动/缩放过程中布局每帧都在变，用 ref 读最新值，松手时一次性落盘
  const latest = useRef<PanelLayout | null>(null);
  const dragging = useRef(false);

  const apply = useCallback((next: PanelLayout | null) => {
    latest.current = next;
    setLayout(next);
  }, []);

  const persist = useCallback(() => {
    if (latest.current) void ext.storage.local.set({ [STORAGE_KEY]: latest.current });
  }, []);

  useEffect(() => {
    void (async () => {
      const stored = await ext.storage.local.get([STORAGE_KEY, LEGACY_KEY]);
      await ext.storage.local.remove(LEGACY_KEY);
      const saved = stored[STORAGE_KEY] as Partial<PanelLayout> | undefined;
      if (!saved) return;
      apply(clamp(saved as PanelLayout));
    })();
  }, [apply]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      // 标题栏上的按钮照常点击，不触发拖动
      if ((event.target as HTMLElement).closest('button')) return;
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dragging.current = true;

      const move = (moveEvent: PointerEvent) => {
        apply(
          clamp({
            ...(latest.current ?? fromRect(rect)),
            x: moveEvent.clientX - offset.x,
            y: moveEvent.clientY - offset.y,
          }),
        );
      };

      const up = () => {
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        persist();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
    },
    [apply, persist, panelRef],
  );

  /** 拉右下角的把手改大小，位置不变 */
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      const start = { x: event.clientX, y: event.clientY };

      const move = (moveEvent: PointerEvent) => {
        apply(
          clamp({
            ...(latest.current ?? fromRect(rect)),
            width: rect.width + (moveEvent.clientX - start.x),
            height: rect.height + (moveEvent.clientY - start.y),
          }),
        );
      };

      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        persist();
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
      event.stopPropagation();
    },
    [apply, persist, panelRef],
  );

  /** 恢复默认：右上角固定位置 + CSS 里的默认尺寸，并删掉记住的布局 */
  const reset = useCallback(() => {
    apply(null);
    void ext.storage.local.remove(STORAGE_KEY);
  }, [apply]);

  return { layout, startDrag, startResize, reset, dragging };
}

/** 还没记住布局时，用屏幕上实际的位置与尺寸当起点（CSS 默认在右上角） */
function fromRect(rect: DOMRect): PanelLayout {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/** 别让面板被拖出视口，也别缩到放不下内容 */
function clamp(layout: PanelLayout): PanelLayout {
  const width = Math.min(
    Math.max(layout.width, MIN_WIDTH),
    Math.max(MIN_WIDTH, window.innerWidth - MARGIN * 2),
  );
  const height = Math.min(
    Math.max(layout.height, MIN_HEIGHT),
    Math.max(MIN_HEIGHT, window.innerHeight - MARGIN * 2),
  );
  return {
    width,
    height,
    x: Math.min(Math.max(layout.x, MARGIN), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    y: Math.min(Math.max(layout.y, MARGIN), Math.max(MARGIN, window.innerHeight - height - MARGIN)),
  };
}
