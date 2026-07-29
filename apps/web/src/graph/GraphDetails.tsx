import { useEffect, useMemo, useRef } from 'react';
import type { GraphSourceRef, WorldGraphSnapshot, WorldNode } from '@writing-studio/contract';
import type { DisplayGraph } from './derive.js';

interface GraphDetailsProps {
  graph: DisplayGraph;
  snapshot: WorldGraphSnapshot;
  node: WorldNode | null;
  onSelectNode(id: string): void;
  onOpenSource(source: GraphSourceRef): void;
}

function timeLabel(time: WorldNode['activeFrom']): string {
  if (time === '@start') return '故事开始前';
  return time?.label ?? '时间未知';
}

export function GraphDetails({
  graph,
  snapshot,
  node,
  onSelectNode,
  onOpenSource,
}: GraphDetailsProps): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const nodeById = useMemo(() => new Map(graph.nodes.map((item) => [item.id, item])), [graph.nodes]);
  const relationById = useMemo(
    () => new Map(snapshot.relationTypes.map((item) => [item.id, item])),
    [snapshot.relationTypes],
  );
  const connected = useMemo(
    () => node ? graph.edges.filter((edge) => edge.sourceId === node.id || edge.targetId === node.id) : [],
    [graph.edges, node],
  );

  useEffect(() => {
    if (node) headingRef.current?.focus({ preventScroll: true });
  }, [node]);

  if (!node) {
    return (
      <aside className="graph-details graph-details-empty">
        <p>选择一个实体查看关系、时间和出处。</p>
      </aside>
    );
  }

  return (
    <aside className="graph-details" aria-label="实体详情">
      <h2 ref={headingRef} tabIndex={-1}>{node.name}</h2>
      <div className="graph-detail-meta">
        <span>{node.typeId}</span>
        <span>{node.visibility}</span>
        <span>{node.confidence}</span>
        {node.implicit && <span>隐式节点</span>}
      </div>
      {node.aliases.length > 0 && <p className="graph-detail-aliases">别名：{node.aliases.join('、')}</p>}
      <dl className="graph-detail-times">
        <div><dt>生效</dt><dd>{timeLabel(node.activeFrom)}</dd></div>
        <div><dt>揭示</dt><dd>{timeLabel(node.revealedAt)}</dd></div>
        <div><dt>失效</dt><dd>{node.inactiveFrom ? timeLabel(node.inactiveFrom) : '未记录'}</dd></div>
      </dl>
      {node.sources.length > 0 && (
        <div className="graph-detail-sources">
          <h3>出处</h3>
          {node.sources.map((source) => (
            <button key={`${source.docId}#${source.heading ?? ''}`} onClick={() => onOpenSource(source)}>
              {source.docId}{source.heading ? ` · ${source.heading}` : ''}
            </button>
          ))}
        </div>
      )}
      <h3>关系 · {connected.length}</h3>
      <div className="graph-detail-relations">
        {connected.map((edge) => {
          const outgoing = edge.sourceId === node.id;
          const otherId = outgoing ? edge.targetId : edge.sourceId;
          const other = nodeById.get(otherId);
          const relation = relationById.get(edge.relationTypeId);
          const label = outgoing
            ? relation?.name
            : relation?.reverseName || relation?.name;
          return (
            <div className="graph-detail-relation" key={edge.id}>
              <button onClick={() => onSelectNode(otherId)}>{other?.name ?? otherId}</button>
              <span>{label ?? edge.relationTypeId}{relation?.directed ? (outgoing ? ' →' : ' ←') : ' ↔'}</span>
              <small>{edge.confidence}</small>
              {edge.sources[0] && (
                <button className="graph-source-link" onClick={() => onOpenSource(edge.sources[0]!)}>出处</button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
