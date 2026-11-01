import { useEffect, useState } from 'react';
import { ext } from '../shared/browser';
import type { DiffPayload } from '../shared/messages';
import { DiffView } from '../content/components/DiffView';

const DIFF_STORAGE_PREFIX = 'pta-assistant-diff:';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; diff: DiffPayload }
  | { status: 'error'; message: string };

/** 全屏 diff：内容不折叠、不限高，整份代码一次看全 */
export function DiffPage() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = new URLSearchParams(location.search).get('id') ?? '';
    if (!id) {
      setState({ status: 'error', message: '地址里没有 diff id，回到面板重新点「全屏查看」' });
      return;
    }
    void (async () => {
      const key = `${DIFF_STORAGE_PREFIX}${id}`;
      const stored = await ext.storage.local.get(key);
      const diff = stored[key] as (DiffPayload & { createdAt?: number }) | undefined;
      if (!diff || typeof diff.left !== 'string' || typeof diff.right !== 'string') {
        setState({
          status: 'error',
          message: '这份 diff 已经过期（只保留最近几份）。回到面板重新点一次「全屏查看」',
        });
        return;
      }
      setState({
        status: 'ready',
        diff: {
          left: diff.left,
          right: diff.right,
          leftLabel: diff.leftLabel || '改动前',
          rightLabel: diff.rightLabel || '改动后',
        },
      });
    })();
  }, []);

  const copyRight = () => {
    if (state.status !== 'ready') return;
    const area = document.createElement('textarea');
    area.value = state.diff.right;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch {
      // 复制失败就留给用户自己选
    }
    area.remove();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="diff-page">
      <header className="diff-page__head">
        <div className="diff-page__titles">
          <h1 className="diff-page__title">完整 diff</h1>
          {state.status === 'ready' && (
            <span className="diff-page__meta">
              {state.diff.leftLabel} → {state.diff.rightLabel}
            </span>
          )}
        </div>
        <div className="diff-page__actions">
          {state.status === 'ready' && (
            <button type="button" className="diff-page__button" onClick={copyRight}>
              {copied ? '已复制' : '复制新代码'}
            </button>
          )}
          <button type="button" className="diff-page__button" onClick={() => window.close()}>
            关闭
          </button>
        </div>
      </header>

      <main className="diff-page__body">
        {state.status === 'loading' && <p className="diff-page__hint">正在读取 diff…</p>}
        {state.status === 'error' && <p className="diff-page__hint diff-page__hint--error">{state.message}</p>}
        {state.status === 'ready' && (
          <div className="diff-page__card">
            {/* full：完整显示，不折叠没改动的部分 */}
            <DiffView {...state.diff} full copied={copied} />
          </div>
        )}
      </main>
    </div>
  );
}
