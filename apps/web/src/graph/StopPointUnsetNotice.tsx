import type { GraphView } from '@writing-studio/contract';

export const STOP_POINT_UNSET_MESSAGE =
  '尚无停点：在写作状态的停点段填入章节引用后，writer 投影才可用。';

export function StopPointUnsetNotice({
  view,
  onReturnToPlanner,
}: {
  view: GraphView;
  onReturnToPlanner?: () => void;
}): React.JSX.Element {
  if (view === 'writer') {
    return (
      <div className="graph-state graph-unset-empty" role="status">
        <p>{STOP_POINT_UNSET_MESSAGE}</p>
        <button onClick={onReturnToPlanner}>返回作者全图</button>
      </div>
    );
  }
  return (
    <div className="graph-unset-notice" role="status">
      {STOP_POINT_UNSET_MESSAGE}
    </div>
  );
}
