import { useEffect, useState } from 'react';
import { ext } from '../../shared/browser';
import {
  DEFAULT_SETTINGS,
  PROVIDER_PRESETS,
  TUTORIAL_URL,
  isCompleteBaseURL,
  normalizeBaseURL,
  type Settings,
  type SettingsView,
} from '../../shared/settings';
import { INPUT_METHODS, INPUT_METHOD_GROUPS, inputMethodIndex } from '../../shared/input-methods';
import { SYSTEM_PROMPT } from '../../shared/tools';
import type { ModelsListResponse, TestInputResponse } from '../../shared/messages';

const METHOD_OK_KEY = 'pta-assistant-input-method-ok';

/** 作者信息：顶部作者卡片与底部署名共用 */
const AUTHOR_NAME = 'OCTest';
const AUTHOR_EMAIL = 'octestwx@qq.com';
const AUTHOR_SITE_LABEL = 'octestpi.top';
const AUTHOR_SITE_URL = 'http://octestpi.top';
/** 头像放在 public/ 里随构建进 dist，设置页用扩展自己的地址去取（页面 CSP 不管用） */
const AVATAR_URL = ext.runtime.getURL('avata.jpg');

/**
 * 「模拟输入测试」整块对普通用户隐藏：那是排查 PTA 禁粘贴时用的调试按钮组，
 * 用户不需要接触。代码留着（`runTest`、方法分组、结果回显都还在），改回 true 就恢复显示。
 */
const SHOW_INPUT_METHOD_TESTS = false;

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
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 模拟输入测试：默认拿系统提示词当测试文本，方便对照回读结果是不是一字不差
  const [testText, setTestText] = useState(SYSTEM_PROMPT);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  // 已经实测哪种方法能用，记下来标个 ✅
  const [workingMethod, setWorkingMethod] = useState<string | null>(null);
  // 模型下拉框：Key 与接口地址都齐了才出现，点了才去问接口要模型列表
  const [modelsOpen, setModelsOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

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

  // Key（填的或已存的）与接口地址都齐了，模型旁边才出现下拉框
  const canListModels = (apiKey.trim().length > 0 || Boolean(view?.hasApiKey)) && isCompleteBaseURL(baseURL);

  // 打开下拉框时才去加载：把面板上刚填的 Key 一起给后台（它那边才有权限发请求）
  const toggleModelList = async () => {
    if (modelsOpen) {
      setModelsOpen(false);
      return;
    }
    setModelsOpen(true);
    setModelsLoading(true);
    setModelsError(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'models/list',
        baseURL,
        apiKey: apiKey.trim() || undefined,
      })) as ModelsListResponse | undefined;
      if (!response?.ok) {
        setModels([]);
        setModelsError(response?.message ?? '后台没有响应');
        return;
      }
      setModels(response.models);
    } catch {
      setModels([]);
      setModelsError('插件后台没有响应，请在扩展管理页重新加载插件');
    } finally {
      setModelsLoading(false);
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
    const patch: Partial<Settings> = { baseURL, model };
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    return save(patch, '已保存');
  };

  // 跳转链接（硅基流动邀请页、作者网站）：开新标签页必须由后台来，content script 没这个权限
  const openLink = async (url: string) => {
    try {
      await ext.runtime.sendMessage({ type: 'ui/open-url', url });
    } catch {
      setStatus(`没能打开浏览器，请手动访问 ${url}`);
    }
  };

  return (
    <div className="settings">
      <section className="author">
        <img className="author__avatar" src={AVATAR_URL} alt={`${AUTHOR_NAME} 的头像`} width={64} height={64} />
        <div className="author__info">
          <span className="author__name">{AUTHOR_NAME}</span>
          <span className="author__email">{AUTHOR_EMAIL}</span>
          <button
            type="button"
            className="author__site"
            title={AUTHOR_SITE_URL}
            onClick={() => void openLink(AUTHOR_SITE_URL)}
          >
            {AUTHOR_SITE_LABEL}
          </button>
        </div>
      </section>

      <label className="field">
        <span className="field__label">API Key</span>
        <input
          className="field__input"
          type="password"
          value={apiKey}
          placeholder={view?.hasApiKey ? '已保存，留空表示不修改' : '填硅基流动的 API Key'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <div className="providers">
        <span className="providers__label">模型提供商</span>
        <span className="providers__list">
          {PROVIDER_PRESETS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`provider${normalizeBaseURL(baseURL) === provider.baseURL ? ' provider--on' : ''}`}
              title={provider.baseURL}
              onClick={() => {
                setBaseURL(provider.baseURL);
                setModelsOpen(false);
                setModels([]);
              }}
            >
              {provider.label}
            </button>
          ))}
        </span>
      </div>

      <label className="field">
        <span className="field__label">接口地址</span>
        <span className="field__row">
          <input
            className="field__input"
            type="text"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
          />
          <button type="button" className="button button--ghost field__jump" onClick={() => void openLink(TUTORIAL_URL)}>
            教程
          </button>
        </span>
        <span className="field__hint">怎么配 Key、怎么用，看教程</span>
      </label>

      <label className="field">
        <span className="field__label">模型</span>
        <span className="field__row">
          <input
            className="field__input"
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          {canListModels && (
            <button
              type="button"
              className={`button button--ghost field__jump field__models${modelsOpen ? ' field__jump--on' : ''}`}
              title="从这个接口加载可用模型列表"
              onClick={() => void toggleModelList()}
            >
              {modelsLoading ? '加载中…' : '选模型 ▾'}
            </button>
          )}
        </span>
        {modelsOpen && (
          <span className="model-list">
            {modelsLoading && <span className="model-list__hint">正在问接口要模型列表…</span>}
            {!modelsLoading && modelsError && <span className="model-list__hint model-list__hint--error">{modelsError}</span>}
            {!modelsLoading && !modelsError && models.length === 0 && (
              <span className="model-list__hint">没有模型可选</span>
            )}
            {!modelsLoading &&
              models.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`model-list__item${id === model ? ' model-list__item--on' : ''}`}
                  title={id}
                  onClick={() => {
                    setModel(id);
                    setModelsOpen(false);
                  }}
                >
                  {id}
                </button>
              ))}
          </span>
        )}
      </label>

      {SHOW_INPUT_METHOD_TESTS && (
        <label className="field">
          <span className="field__label">模拟输入测试（一种方法一个按钮）</span>
          <textarea
            className="field__input field__input--area"
            rows={3}
            value={testText}
            onChange={(event) => setTestText(event.target.value)}
          />
          <span className="field__hint">
            用下面的文本逐个试每种写入方法（会覆盖作答区内容、不提交）。CDP 那几个方法要调试器权限，一律直接试；
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
      )}

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
