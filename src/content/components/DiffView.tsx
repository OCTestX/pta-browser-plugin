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
}

/** 超过这么多行没改动就先折叠，界面上只看得到改动的部分 */
const COLLAPSE_AFTER = 6;
/** 折叠时前后各留几行上下文 */
const CONTEXT_KEEP = 2;

/**
 * 左右两列 + 中间一条道的差异视图（照 IDEA 的 diff 做的）：
 * 两边同高度的表格行，中间那条道上画行号和改动块的箭头（顶部 »、底部 «），
 * 连起来的竖线把一次改动圈成一团；没动的地方压暗、长了可以折叠。
 */
export function DiffView({ left, right, leftLabel, rightLabel, onCopy, copied = false }: DiffViewProps) {
  const rows = useMemo(() => diffLines(left, right), [left, right]);
  const segments = useMemo(() => segmentDiff(rows), [rows]);
  const stats = diffStats(rows);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  return (
    <div className="diff">
      <div className="diff__head">
        <span className="diff__head-cell">{leftLabel}</span>
        <span className="diff__head-gutter" />
        <span className="diff__head-cell diff__head-cell--right">
          {rightLabel}
          {onCopy && (
            <button type="button" className="diff__copy" onClick={onCopy}>
              {copied ? '已复制' : '复制新代码'}
            </button>
          )}
        </span>
      </div>

      <div className="diff__body">
        {segments.map((segment, index) => {
          if (segment.kind === 'hunk') {
            return (
              <div className="diff__hunk" key={index}>
                <div className="diff__row diff__row--fence">
                  <span className="diff__cell diff__cell--blank" />
                  <span className="diff__gutter diff__gutter--start">»</span>
                  <span className="diff__cell diff__cell--blank" />
                </div>
                {segment.rows.map((row, position) => (
                  <DiffRowView
                    key={position}
                    row={row}
                    capTop={position === 0}
                    capBottom={position === segment.rows.length - 1}
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

          const long = segment.rows.length > COLLAPSE_AFTER && !expanded[index];
          const head = long ? segment.rows.slice(0, CONTEXT_KEEP) : segment.rows;
          const tail = long ? segment.rows.slice(-CONTEXT_KEEP) : [];
          const hidden = segment.rows.length - head.length - tail.length;

          return (
            <div className="diff__context" key={index}>
              {head.map((row, position) => (
                <DiffRowView key={position} row={row} />
              ))}
              {long && (
                <>
                  <button
                    type="button"
                    className="diff__more"
                    onClick={() => setExpanded((prev) => ({ ...prev, [index]: true }))}
                  >
                    ⋯ 还有 {hidden} 行没改动，点开
                  </button>
                  {tail.map((row, position) => (
                    <DiffRowView key={`t${position}`} row={row} />
                  ))}
                </>
              )}
            </div>
          );
        })}
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
