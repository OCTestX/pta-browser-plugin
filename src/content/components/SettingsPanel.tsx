import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type Settings, type SettingsView } from '../../shared/settings';

interface SettingsPanelProps {
  view: SettingsView | null;
  onSave: (patch: Partial<Settings>) => Promise<unknown>;
  onBack: () => void;
}

export function SettingsPanel({ view, onSave, onBack }: SettingsPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [baseURL, setBaseURL] = useState(view?.baseURL ?? DEFAULT_SETTINGS.baseURL);
  const [model, setModel] = useState(view?.model ?? DEFAULT_SETTINGS.model);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 设置是异步从 background 取回来的，取到后补上初值
  useEffect(() => {
    if (!view) return;
    setBaseURL(view.baseURL);
    setModel(view.model);
  }, [view]);

  const save = async (patch: Partial<Settings>, done: string) => {
    setSaving(true);
    try {
      await onSave(patch);
      setApiKey('');
      setStatus(done);
    } catch {
      setStatus('保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  // 输入框留空表示不修改已保存的 Key
  const saveCurrent = () => {
    const patch: Partial<Settings> = { baseURL, model };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    return save(patch, '已保存');
  };

  return (
    <div className="settings">
      <label className="field">
        <span className="field__label">API Key</span>
        <input
          className="field__input"
          type="password"
          value={apiKey}
          placeholder={view?.hasApiKey ? '已保存，留空表示不修改' : '填 DeepSeek 的 API Key'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <label className="field">
        <span className="field__label">接口地址</span>
        <input
          className="field__input"
          type="text"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
        />
        <span className="field__hint">
          换成其它地址时，要同时把该域名加进 manifest 的 host_permissions，否则请求会被浏览器拦掉。
        </span>
      </label>

      <label className="field">
        <span className="field__label">模型</span>
        <input
          className="field__input"
          type="text"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>

      <div className="settings__actions">
        <button type="button" className="button button--ghost" onClick={onBack}>
          返回对话
        </button>
        {view?.hasApiKey && (
          <button
            type="button"
            className="button button--ghost"
            disabled={saving}
            onClick={() => void save({ apiKey: '' }, '已清除 API Key')}
          >
            清除 Key
          </button>
        )}
        <button type="button" className="button" disabled={saving} onClick={() => void saveCurrent()}>
          保存
        </button>
      </div>

      {status && <div className="settings__status">{status}</div>}
      <div className="settings__note">
        API Key 只保存在本机的插件存储里，不会发送到除接口地址以外的任何地方。
      </div>
    </div>
  );
}
