import { useCallback, useEffect, useState } from 'react';
import { ext } from '../../shared/browser';
import type { Settings, SettingsView } from '../../shared/settings';

/** 设置存在 background 的 chrome.storage.local 里，content script 只能拿到不含 Key 的视图 */
export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);

  const load = useCallback(async () => {
    const loaded = (await ext.runtime.sendMessage({ type: 'settings/get' })) as SettingsView;
    setView(loaded);
  }, []);

  useEffect(() => {
    void load();
    // 设置可能在别的标签页/后台被改（例如刚填完 API Key）。
    // 只加载一次的话，当前面板会一直以为 hasApiKey=false，模型下拉框就消失了。
    const onChanged = ext.storage.onChanged;
    if (!onChanged) return;
    const listener = (changes: Record<string, unknown>, areaName?: string) => {
      if ((!areaName || areaName === 'local') && 'pta-assistant-settings' in changes) void load();
    };
    onChanged.addListener(listener);
    return () => onChanged.removeListener(listener);
  }, [load]);

  const save = useCallback(async (patch: Partial<Settings>) => {
    const saved = (await ext.runtime.sendMessage({
      type: 'settings/save',
      patch,
    })) as SettingsView;
    setView(saved);
    return saved;
  }, []);

  return { view, save, hasApiKey: view?.hasApiKey ?? false };
}
