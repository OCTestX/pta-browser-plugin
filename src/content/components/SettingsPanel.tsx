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
  const [useDebuggerInput, setUseDebuggerInput] = useState(
    view?.useDebuggerInput ?? DEFAULT_SETTINGS.useDebuggerInput,
  );
  const [compileServiceURL, setCompileServiceURL] = useState(
    view?.compileServiceURL ?? DEFAULT_SETTINGS.compileServiceURL,
  );
  const [compileLanguageId, setCompileLanguageId] = useState(
    String(view?.compileLanguageId ?? DEFAULT_SETTINGS.compileLanguageId),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 设置是异步从 background 取回来的，取到后补上初值
  useEffect(() => {
    if (!view) return;
    setBaseURL(view.baseURL);
    setModel(view.model);
    setUseDebuggerInput(view.useDebuggerInput);
    setCompileServiceURL(view.compileServiceURL);
    setCompileLanguageId(String(view.compileLanguageId));
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
    const patch: Partial<Settings> = {
      baseURL,
      model,
      useDebuggerInput,
      compileServiceURL,
      compileLanguageId: Number.parseInt(compileLanguageId, 10) || DEFAULT_SETTINGS.compileLanguageId,
    };
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

      <label className="field">
        <span className="field__label">编译服务地址</span>
        <input
          className="field__input"
          type="text"
          value={compileServiceURL}
          onChange={(event) => setCompileServiceURL(event.target.value)}
        />
        <span className="field__hint">
          按 Judge0 协议（POST /submissions?wait=true）。默认是公共实例，介意代码外发就换成自建的；换域名要同时加进 manifest 的 host_permissions。
        </span>
      </label>

      <label className="field">
        <span className="field__label">编译语言 ID</span>
        <input
          className="field__input"
          type="text"
          value={compileLanguageId}
          onChange={(event) => setCompileLanguageId(event.target.value)}
        />
        <span className="field__hint">Judge0 的语言编号：50 = C (GCC)，54 = C++ (GCC)。</span>
      </label>

      <label className="field field--switch">
        <input
          type="checkbox"
          checked={useDebuggerInput}
          onChange={(event) => setUseDebuggerInput(event.target.checked)}
        />
        <span>
          用调试器发送真实按键
          <span className="field__hint">
            开启后 simulate_keyboard_input 走 chrome.debugger 发 CDP 事件，按键是可信的，编辑器和浏览器默认行为（换行、提交）都会响应；代价是输入的那几秒标签页顶部会出现「正在调试此浏览器」横幅，且该标签页此时不能打开开发者工具。
          </span>
        </span>
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
