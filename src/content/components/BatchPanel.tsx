import { memo, useState } from 'react';
import type { BatchProblemItem, BatchSnapshot } from '../../shared/batch';
import { problemTypeShortName } from '../../shared/problem-types';

interface BatchPanelProps {
  /** 赶题模式的进度快照；null 表示没在赶题模式，卡片不画 */
  snapshot: BatchSnapshot | null;
  /** 按「停止」打断这一轮 */
  onStop?: () => void;
  /** 跳到某道题（地址在快照里） */
  onOpenProblem?: (problem: BatchProblemItem) => void;
  /**
   * 重做这些没过的题。
   * 面板会把每道题的地址写进一条指令，跳到第一道；跳过去之后页面重新挂载，
   * 插件把那条指令补发出去，agent 就能一道一道把它们重做一遍。
   */
  onRedo?: (problems: BatchProblemItem[]) => void;
  /**
   * 接着赶剩下的题（用户中途按了停止时给这个出口）。
   * agent 会从当前这道题接着做，已提交过的题它自己会跳过。
   */
  onContinue?: () => void;
}

/**
 * 赶题模式（/fuck）的总览卡。
 *
 * 之前进度只以文字横幅的形式出现在对话里，用户得往回翻才知道跑到哪了。
 * 这张卡把「做了几题 / 过了几题 / 还剩几题 / 正在做哪道」摆在一眼能看到的地方，
 * 题目清单按顺序列出来，每道题一个结论标记。
 */
export function BatchPanel({ snapshot, onStop, onOpenProblem, onRedo, onContinue }: BatchPanelProps) {
  // 收起后只留一行标题，进度还在：长对话里不至于被这张卡挡住
  const [collapsed, setCollapsed] = useState(false);

  if (!snapshot || !snapshot.active) return null;

  const {
    attempted,
    accepted,
    failed,
    unknown,
    remaining,
    total,
    problems,
    current,
    finished,
    stopReason,
    elapsedMinutes,
  } = snapshot;
  // 用户按了停止 ≠ 题单做完了：卡片上要写清楚，并给出「接着赶」的出口
  const stopped = stopReason === 'stopped';
  // 出错中断也不是走完了题单：不能写成「已收工」
  const errored = stopReason === 'error';
  // 进度条按整份题单的题数画：本轮做过的部分 + 题单里剩下的部分
  const scale = typeof total === 'number' && total > 0 ? total : Math.max(attempted, 1);
  // 本轮各题型做了几题：题单里判断/选择/填空/编程混着走，用户想知道分布
  const byType = new Map<string, number>();
  for (const problem of problems) {
    const name = problemTypeShortName(problem.type) || '其它';
    byType.set(name, (byType.get(name) ?? 0) + 1);
  }
  const typeChips = [...byType.entries()];
  // 没过的题单独列出来：这一轮跑完，用户最想知道的就是这几道
  const failedProblems = problems.filter((problem) => problem.status === 'failed');
  // 没过的题里带地址的：可以「跳过去接着重做」
  const redoable = failedProblems.filter((problem) => Boolean(problem.url));
  // 这一轮还在跑的时候别乱跳：agent 正在这道题上写代码，跳走等于打断它
  const canJump = finished && Boolean(onOpenProblem);

  return (
    <section className={`batch${collapsed ? ' batch--collapsed' : ''}`} aria-label="赶题进度">
      <header className="batch__head">
        <button
          type="button"
          className="batch__toggle"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? '展开赶题进度' : '收起赶题进度'}
          aria-expanded={!collapsed}
        >
          <span className="batch__caret" aria-hidden="true">
            {collapsed ? '▶' : '▼'}
          </span>
          <span className="batch__title">赶题模式</span>
        </button>
        <span className={`batch__state${finished && !errored ? ' batch__state--done' : ''}`}>
          {finished ? (stopped ? '已停止' : errored ? '出错中断' : '已收工') : '进行中'}
        </span>
        <span className="batch__elapsed">{elapsedMinutes} 分钟</span>
        {finished && (stopped || errored) && onContinue && (
          <button
            type="button"
            className="batch__redo"
            title="从当前这道题接着赶剩下的题（已经提交过的题会自动跳过）"
            onClick={onContinue}
          >
            {typeof remaining === 'number' && remaining > 0 ? `继续赶剩下的 ${remaining} 题` : '继续赶题'}
          </button>
        )}
        {finished && redoable.length > 0 && onRedo && (
          <button
            type="button"
            className="batch__redo"
            title="跳到第一道没过的题，把这几道题的地址一起交给 agent，它会一道一道重做"
            onClick={() => onRedo(redoable)}
          >
            重做没过的 {redoable.length} 题
          </button>
        )}
        {!finished && onStop && (
          <button type="button" className="batch__stop" onClick={onStop} title="停止赶题">
            停止
          </button>
        )}
      </header>

      {!collapsed && (
        <>
          <div
            className="batch__bar"
            role="img"
            aria-label={`本轮已做 ${attempted} 题${typeof total === 'number' ? `，题单共 ${total} 题` : ''}`}
          >
            <span className="batch__seg batch__seg--ok" style={{ flexGrow: accepted }} />
            <span className="batch__seg batch__seg--bad" style={{ flexGrow: failed }} />
            <span className="batch__seg batch__seg--todo" style={{ flexGrow: unknown }} />
            <span className="batch__seg batch__seg--rest" style={{ flexGrow: Math.max(0, scale - attempted) }} />
          </div>

          <p className="batch__ratio">
            {attempted === 0 && typeof remaining !== 'number'
              ? '还没开始做题'
              : (
                  <>
                    本轮已做 <b>{attempted}</b> 题
                    {typeof total === 'number' && <>，题单共 {total} 题</>}
                    {typeof remaining === 'number' && remaining > 0 && <>，还剩 {remaining} 题</>}
                  </>
                )}
          </p>

          <div className="batch__stats">
            <Stat label="已做" value={attempted} />
            <Stat label="AC" value={accepted} tone={accepted > 0 ? 'ok' : undefined} />
            <Stat label="未过" value={failed} tone={failed > 0 ? 'bad' : undefined} />
            <Stat label="剩余" value={remaining ?? '—'} />
          </div>

          {typeChips.length > 0 && (
            <p className="batch__types">
              {typeChips.map(([name, count]) => (
                <span className="batch__type" key={name}>
                  {name}
                  <b>{count}</b>
                </span>
              ))}
            </p>
          )}

          {current && (
            <p className="batch__current">
              <span className="batch__current-label">{finished ? '最后做到' : '正在做'}</span>
              <span className="batch__current-title">{current.title}</span>
            </p>
          )}

          {problems.length > 0 && (
            <ul className="batch__list">
              {problems.map((problem) => (
                <ProblemRow
                  key={problem.key}
                  problem={problem}
                  onOpen={canJump ? (target) => onOpenProblem?.(target) : undefined}
                />
              ))}
            </ul>
          )}

          {failedProblems.length > 0 && (
            <p className="batch__failed">
              未过：
              {failedProblems.slice(0, 3).map((problem) => (
                <span className="batch__failed-item" key={problem.key}>
                  {problem.title}
                  {problem.verdict ? `（${problem.verdict}）` : ''}
                </span>
              ))}
              {failedProblems.length > 3 && <> 等 {failedProblems.length} 题</>}
            </p>
          )}

          {typeof remaining === 'number' && remaining > 0 && (
            <p className="batch__hint">
              {finished ? `还有 ${remaining} 题没做` : `还剩 ${remaining} 题，做完自动切下一题`}
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** 一个数字格子 */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: 'ok' | 'bad';
}) {
  return (
    <div className={`batch__stat${tone ? ` batch__stat--${tone}` : ''}`}>
      <span className="batch__stat-value">{value}</span>
      <span className="batch__stat-label">{label}</span>
    </div>
  );
}

/** 清单里的一行：题目标题 + 结论标记 */
const ProblemRow = memo(function ProblemRow({
  problem,
  onOpen,
}: {
  problem: BatchProblemItem;
  /** 点一下跳到那道题；没有地址就不可点 */
  onOpen?: (problem: BatchProblemItem) => void;
}) {
  const mark =
    problem.status === 'accepted'
      ? { text: 'AC', className: 'ok' }
      : problem.status === 'failed'
        ? { text: problem.verdict || '未过', className: 'bad' }
        : problem.status === 'current'
          ? { text: '进行中', className: 'now' }
          : { text: '待做', className: 'todo' };
  const clickable = Boolean(onOpen && problem.url);
  return (
    <li className={`batch__row batch__row--${problem.status}`}>
      <button
        type="button"
        className={`batch__row-title${clickable ? ' batch__row-title--link' : ''}`}
        title={clickable ? `${problem.title}（点一下跳到这道题）` : problem.title}
        disabled={!clickable}
        onClick={() => (clickable ? onOpen?.(problem) : undefined)}
      >
        {problem.title}
      </button>
      <span className={`batch__mark batch__mark--${mark.className}`}>{mark.text}</span>
    </li>
  );
});
