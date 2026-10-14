import { useCallback, useEffect, useState } from 'react';
import { ext } from '../../shared/browser';
import type { Settings, SettingsView } from '../../shared/settings';

/** 设置存在 background 的 chrome.storage.local 里，content script 只能拿到不含 Key 的视图 */
export function useSettings() {
  const [view, setView] = useState<SettingsView | null>(null);

  useEffect(() => {
    void (async () => {
      const loaded = (await ext.runtime.sendMessage({ type: 'settings/get' })) as SettingsView;
      setView(loaded);
    })();
  }, []);

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
