import { useMemo, useState } from 'react';
import { diffLines, diffStats, markWordChanges, segmentDiff, type DiffPart, type DiffRow } from '../../shared/diff';

interface DiffViewProps {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
  /** 表头右上角的「复制」按钮，把右边整段新代码复制走 */
  onCopy?: () => void;
  copied?: boolean;
  /** 卡片的「全屏查看」：打开新标签页看完整 diff */
  onFullscreen?: () => void;
  /** 全屏页模式：不折叠没改动的行，也不限高 */
  full?: boolean;
}

/** 超过这么多行没改动就先折叠，界面上只看得到改动的部分 */
const COLLAPSE_AFTER = 6;
/** 折叠时前后各留几行上下文 */
const CONTEXT_KEEP = 2;
/**
 * 一次最多渲染这么多行（面板里的卡片与全屏页都一样）。
 *
 * diff 的算法本身很快（两千行也就几毫秒），慢的是渲染：一行要建六七个节点，
 * 四千行就是两万个节点，React 建它们要几百毫秒，页面直接卡住。
 * 超出的部分不渲染，只写明一共多少行——想拿完整内容用「复制新代码」。
 */
const FULL_RENDER_LIMIT = 1200;

/**
 * 左右两列 + 中间一条道的差异视图（照 IDEA 的 diff 做的）：
 * 两边同高度的表格行，中间那条道上画行号和改动块的箭头（顶部 »、底部 «），
 * 连起来的竖线把一次改动圈成一团；没动的地方压暗、长了可以折叠。
 */
export function DiffView({
  left,
  right,
  leftLabel,
  rightLabel,
  onCopy,
  copied = false,
  onFullscreen,
  full = false,
}: DiffViewProps) {
  const rows = useMemo(() => diffLines(left, right), [left, right]);
  const segments = useMemo(() => segmentDiff(rows), [rows]);
  const stats = diffStats(rows);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  return (
    <div className={`diff${full ? ' diff--full' : ''}`}>
      <div className="diff__head">
        <span className="diff__head-cell">{leftLabel}</span>
        <span className="diff__head-gutter" />
        <span className="diff__head-cell diff__head-cell--right">
          <span>{rightLabel}</span>
          <span className="diff__head-actions">
            {onFullscreen && (
              <button type="button" className="diff__copy" onClick={onFullscreen}>
                全屏查看
              </button>
            )}
            {onCopy && (
              <button type="button" className="diff__copy" onClick={onCopy}>
                {copied ? '已复制' : '复制新代码'}
              </button>
            )}
          </span>
        </span>
      </div>

      <div className="diff__body">
        {(() => {
          // 行数是封顶的：数到上限就不往后渲染了。
          // 折叠掉的上下文本来就不画，所以只按真正要画出来的行数算额度。
          let budget = FULL_RENDER_LIMIT;
          let shown = 0;
          let total = 0;
          const clipped = segments.map((segment, index) => {
            // 这一段真正要画哪些行：改动块全画；没动的上下文折叠时只画前后两行
            const collapsed =
              !full && segment.kind === 'context' && segment.rows.length > COLLAPSE_AFTER && !expanded[index];
            const visible = collapsed
              ? [...segment.rows.slice(0, CONTEXT_KEEP), ...segment.rows.slice(-CONTEXT_KEEP)]
              : segment.rows;
            total += visible.length;
            if (budget <= 0) return { segment, rows: [] as DiffRow[], collapsed, clipped: true };
            const take = Math.min(visible.length, budget);
            budget -= take;
            shown += take;
            return { segment, rows: visible.slice(0, take), collapsed, clipped: take < visible.length };
          });

          return (
            <>
              {clipped.map(({ segment, rows: visibleRows, collapsed, clipped: cut }, index) => {
                if (segment.kind === 'hunk') {
                  if (visibleRows.length === 0) return null;
                  return (
                    <div className="diff__hunk" key={index}>
                      <div className="diff__row diff__row--fence">
                        <span className="diff__cell diff__cell--blank" />
                        <span className="diff__gutter diff__gutter--start">»</span>
                        <span className="diff__cell diff__cell--blank" />
                      </div>
                      {visibleRows.map((row, position) => (
                        <DiffRowView
                          key={position}
                          row={row}
                          capTop={position === 0}
                          capBottom={position === visibleRows.length - 1}
                        />
                      ))}
                      <div className="diff__row diff__row--fence">
                        <span className="diff__cell diff__cell--blank" />
                        <span className="diff__gutter diff__gutter--end">«</span>
                        <span className="diff__cell diff__cell--blank" />
                      </div>
                    </div>
                  );
                }

                // 没动的上下文：折叠时只画前后两行，中间放一个「点开」的按钮。
                // 被行数上限截掉的那段不放这个按钮——点开也画不出来（额度用完了）。
                const hidden = segment.rows.length - visibleRows.length;
                const head = collapsed ? visibleRows.slice(0, CONTEXT_KEEP) : visibleRows;
                const tail = collapsed ? visibleRows.slice(CONTEXT_KEEP) : [];

                return (
                  <div className="diff__context" key={index}>
                    {head.map((row, position) => (
                      <DiffRowView key={position} row={row} />
                    ))}
                    {collapsed && !cut && (
                      <button
                        type="button"
                        className="diff__more"
                        onClick={() => setExpanded((prev) => ({ ...prev, [index]: true }))}
                      >
                        ⋯ 还有 {hidden} 行没改动，点开
                      </button>
                    )}
                    {tail.map((row, position) => (
                      <DiffRowView key={`t${position}`} row={row} />
                    ))}
                  </div>
                );
              })}
              {shown < total && (
                <p className="diff__clipped">
                  改动太多（共 {total} 行），这里只渲染了前 {shown} 行；完整内容用「复制新代码」拿走。
                </p>
              )}
            </>
          );
        })()}
      </div>

      <div className="diff__legend">
        <span className="diff__tag diff__tag--add">新增 {stats.added}</span>
        <span className="diff__tag diff__tag--mod">修改 {stats.changed}</span>
        <span className="diff__tag diff__tag--del">删除 {stats.removed}</span>
      </div>
    </div>
  );
}

function DiffRowView({
  row,
  capTop = false,
  capBottom = false,
}: {
  row: DiffRow;
  capTop?: boolean;
  capBottom?: boolean;
}) {
  const words = useMemo(
    () => (row.type === 'mod' ? markWordChanges(row.left ?? '', row.right ?? '') : null),
    [row],
  );

  return (
    <div className={`diff__row diff__row--${row.type}`}>
      <span className="diff__cell diff__cell--left" title={row.left ?? ''}>
        <span className="diff__no">{row.leftNo ?? ''}</span>
        <span className="diff__text">{words ? <Parts parts={words.left} /> : row.left ?? ''}</span>
      </span>
      <span className={`diff__gutter${capTop ? ' diff__gutter--cap-top' : ''}${capBottom ? ' diff__gutter--cap-bottom' : ''}`} />
      <span className="diff__cell diff__cell--right" title={row.right ?? ''}>
        <span className="diff__no">{row.rightNo ?? ''}</span>
        <span className="diff__text">{words ? <Parts parts={words.right} /> : row.right ?? ''}</span>
      </span>
    </div>
  );
}

/** 行内被改掉的词加深色底——IDEA 里就是靠这个一眼看出改的是哪个符号 */
function Parts({ parts }: { parts: DiffPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.changed ? (
          <mark className="diff__word" key={index}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
