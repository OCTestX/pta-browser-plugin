import { useEffect, useState } from 'react';
import { ext } from '../../shared/browser';
import { DEFAULT_SETTINGS, type Settings, type SettingsView } from '../../shared/settings';
import { INPUT_METHODS, INPUT_METHOD_GROUPS, inputMethodIndex } from '../../shared/input-methods';
import { SYSTEM_PROMPT } from '../../shared/tools';
import type { TestInputResponse } from '../../shared/messages';

const METHOD_OK_KEY = 'pta-assistant-input-method-ok';

/** 这次测试算不算「成功」：内容回读一致，而且页面没弹「禁止粘贴」这类提示 */
export function isMethodTestSuccess(ok: boolean, result: string): boolean {
  return ok && result.includes('回读比对：与目标一致') && !/禁止粘贴|不允许粘贴|不能粘贴|请勿粘贴/.test(result);
}

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
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 模拟输入测试：默认拿系统提示词当测试文本，方便对照回读结果是不是一字不差
  const [testText, setTestText] = useState(SYSTEM_PROMPT);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  // 已经实测哪种方法能用，记下来标个 ✅
  const [workingMethod, setWorkingMethod] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const stored = await ext.storage.local.get(METHOD_OK_KEY);
      const known = stored[METHOD_OK_KEY];
      if (typeof known === 'string' && INPUT_METHODS.some((item) => item.id === known)) {
        setWorkingMethod(known);
      }
    })();
  }, []);


  const runTest = async (methodId: string) => {
    const method = INPUT_METHODS.find((item) => item.id === methodId) ?? INPUT_METHODS[0];
    setTesting(method.id);
    setTestResult(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'tool/test-input',
        text: testText,
        method: method.id,
      })) as TestInputResponse | undefined;
      const result = response?.result ?? '后台没有响应';
      setTestResult(result);
      // 记下哪种方法在真页面上真的能用
      if (isMethodTestSuccess(response?.ok === true, result)) {
        setWorkingMethod(method.id);
        void ext.storage.local.set({ [METHOD_OK_KEY]: method.id });
      }
    } catch (error) {
      setTestResult(`测试失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(null);
    }
  };

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

      <label className="field">
        <span className="field__label">模拟输入测试（一种方法一个按钮）</span>
        <textarea
          className="field__input field__input--area"
          rows={3}
          value={testText}
          onChange={(event) => setTestText(event.target.value)}
        />
        <span className="field__hint">
          用下面的文本逐个试每种写入方法（会覆盖作答区内容、不提交）。CDP 那几个方法不看「用调试器发送真实按键」开关，一律直接试；
          哪个成功就会标上 ✅ 并记下来。实测结论：只有 <b>整段 dispatch</b> 能写进去，其余都被页面拦。
        </span>
        {workingMethod && (
          <span className="field__hint">
            当前可用方法：<b>{INPUT_METHODS[inputMethodIndex(workingMethod)].label}</b>
            （`write_editor_code` 工具走的正是这一种）
          </span>
        )}

        {INPUT_METHOD_GROUPS.map((group) => (
          <div className="method-group" key={group}>
            <span className="method-group__title">{group}</span>
            <div className="method-buttons">
              {INPUT_METHODS.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`method-button${workingMethod === item.id ? ' method-button--ok' : ''}`}
                  title={item.hint}
                  disabled={testing !== null}
                  onClick={() => void runTest(item.id)}
                >
                  {testing === item.id ? '输入中…' : item.label}
                  {workingMethod === item.id ? ' ✅' : ''}
                </button>
              ))}
            </div>
          </div>
        ))}

        {testResult && <pre className="settings__result">{testResult}</pre>}
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
