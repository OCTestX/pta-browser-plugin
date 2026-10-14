import { useCallback, useEffect, useRef, useState } from 'react';
import { ext } from '../../shared/browser';

export interface PanelPosition {
  x: number;
  y: number;
}

const STORAGE_KEY = 'pta-assistant-panel-position';
const MARGIN = 8;

/** 面板位置存在 chrome.storage.local 里，刷新页面后还在 */
export function usePanelPosition(panelRef: React.RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    void (async () => {
      const stored = await ext.storage.local.get(STORAGE_KEY);
      const saved = stored[STORAGE_KEY] as PanelPosition | undefined;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        setPosition(clamp(saved, panelRef.current));
      }
    })();
  }, [panelRef]);

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!panel) return;
      // 标题栏上的按钮照常点击，不触发拖动
      if ((event.target as HTMLElement).closest('button')) return;

      const rect = panel.getBoundingClientRect();
      const offset = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      dragging.current = true;

      const move = (moveEvent: PointerEvent) => {
        setPosition(
          clamp(
            { x: moveEvent.clientX - offset.x, y: moveEvent.clientY - offset.y },
            panelRef.current,
          ),
        );
      };

      const up = () => {
        dragging.current = false;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setPosition((current) => {
          if (current) void ext.storage.local.set({ [STORAGE_KEY]: current });
          return current;
        });
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      event.preventDefault();
    },
    [panelRef],
  );

  const reset = useCallback(() => {
    setPosition(null);
    void ext.storage.local.remove(STORAGE_KEY);
  }, []);

  return { position, startDrag, reset, dragging };
}

/** 别让面板被拖出视口 */
function clamp(position: PanelPosition, panel: HTMLElement | null): PanelPosition {
  const width = panel?.offsetWidth ?? 420;
  const height = panel?.offsetHeight ?? 400;
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  return {
    x: Math.min(Math.max(position.x, MARGIN), maxX),
    y: Math.min(Math.max(position.y, MARGIN), maxY),
  };
}
