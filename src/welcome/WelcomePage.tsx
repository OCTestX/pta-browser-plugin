// 欢迎页：首次安装自动打开。
//
// 干三件事：说清楚这插件怎么用、给出仓库地址、提供一个「粘贴备份就还原设置」的入口
// （换电脑/重装时不用再手填 Key 与接口地址）。
//
// 扩展页里可以直接用 chrome API（`ext`），不需要经过后台转发；只有设置读写走消息，
// 那样逻辑与设置页共用同一份（apiKey 永远不出 background）。

import { useState } from 'react';
import { ext } from '../shared/browser';
import type { SettingsBackupResponse } from '../shared/messages';

const GITHUB_URL = 'https://github.com/OCTestX/pta-browser-plugin';
const GITEE_URL = 'https://gitee.com/octestx/pta-browser-plugin';

const AUTHOR_NAME = 'OCTest';
const AUTHOR_EMAIL = 'octestwx@qq.com';
const AUTHOR_SITE_LABEL = 'me.octest.top';
const AUTHOR_SITE_URL = 'https://me.octest.top';

/** 打开外部链接：扩展页里 tabs.create 可以直接用 */
function openUrl(url: string): void {
  void ext.tabs.create({ url });
}

export function WelcomePage() {
  const [hex, setHex] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [importing, setImporting] = useState(false);

  const importBackup = async () => {
    const value = hex.trim();
    if (!value) {
      setStatus({ ok: false, text: '先把备份串粘贴进来' });
      return;
    }
    setImporting(true);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'settings/import',
        hex: value,
      })) as SettingsBackupResponse | undefined;
      if (response?.ok) {
        setStatus({ ok: true, text: '导入成功，设置已还原。打开题目页点一下插件图标就能用了。' });
        setHex('');
      } else {
        setStatus({ ok: false, text: response?.message ?? '导入失败，请重试' });
      }
    } catch {
      setStatus({ ok: false, text: '插件后台没有响应，请在扩展管理页重新加载插件' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <main className="page">
      <header className="hero">
        <h1 className="hero__title">PTA 助手</h1>
        <p className="hero__subtitle">
          在 PTA 题目页上开一个悬浮窗，帮你读题、写代码、跑样例、提交，顺带把作答区该有的编辑功能补齐。
        </p>
      </header>

      <section className="card">
        <h2 className="card__title">怎么开始</h2>
        <ol className="steps">
          <li>点右上角插件图标，或按 Alt + G 打开悬浮窗。</li>
          <li>在设置里填 API Key 与接口地址（模型提供商点一下就能填好）。</li>
          <li>回到题目页，输入 <code>/</code> 看可用指令，或者直接问它。</li>
        </ol>
        <p className="hint">
          作答区的连字符、参数提示、缩进线、代码提示（C / C++）都在设置里，默认关闭，按需打开。
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">导入设置备份</h2>
        <p className="hint">
          从旧电脑的设置页「备份设置」里抄来的那串十六进制，粘进来就能还原 API Key、接口地址、模型与全部开关。
        </p>
        <textarea
          className="backup__input"
          rows={4}
          spellCheck={false}
          placeholder="粘贴以 0-9a-f 组成的一整串"
          value={hex}
          onChange={(event) => setHex(event.target.value)}
        />
        <div className="backup__actions">
          <button type="button" className="button" disabled={importing} onClick={() => void importBackup()}>
            {importing ? '导入中…' : '导入'}
          </button>
          {status && (
            <span className={`backup__status${status.ok ? ' backup__status--ok' : ''}`}>{status.text}</span>
          )}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">仓库</h2>
        <div className="links">
          <button type="button" className="link" onClick={() => openUrl(GITHUB_URL)}>
            GitHub · OCTestX/pta-browser-plugin
          </button>
          <button type="button" className="link" onClick={() => openUrl(GITEE_URL)}>
            Gitee · octestx/pta-browser-plugin
          </button>
        </div>
      </section>

      <footer className="footer">
        <span className="footer__author">{AUTHOR_NAME}</span>
        <a className="footer__mail" href={`mailto:${AUTHOR_EMAIL}`}>
          {AUTHOR_EMAIL}
        </a>
        <button type="button" className="footer__site" onClick={() => openUrl(AUTHOR_SITE_URL)}>
          {AUTHOR_SITE_LABEL}
        </button>
      </footer>
    </main>
  );
}
