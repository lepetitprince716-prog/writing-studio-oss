import { useEffect, useMemo, useState } from 'react';
import type {
  GraphSourceRef,
  WorldGraphSnapshot,
} from '@writing-studio/contract';
import {
  ContextMenu,
  isContextMenuOpenKey,
  useContextMenu,
} from '../components/ContextMenu.js';
import { copyText } from '../lib/clipboard.js';
import type { DisplayGraph } from './derive.js';
import {
  createGraphEntityMenuSpec,
  createGraphRelationMenuSpec,
  relationText,
} from './graph-menu-specs.js';

const PAGE_SIZE = 50;

interface GraphRelationListProps {
  graph: DisplayGraph;
  snapshot: WorldGraphSnapshot;
  selectedNodeId: string | null;
  onSelectNode(id: string): void;
  onOpenSource(source: GraphSourceRef): void;
}

export function GraphRelationList({
  graph,
  snapshot,
  selectedNodeId,
  onSelectNode,
  onOpenSource,
}: GraphRelationListProps): React.JSX.Element {
  const [page, setPage] = useState(0);
  const [nodePage, setNodePage] = useState(0);
  const menu = useContextMenu();
  const nodes = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const relationTypes = useMemo(
    () => new Map(snapshot.relationTypes.map((type) => [type.id, type])),
    [snapshot.relationTypes],
  );
  const pageCount = Math.max(1, Math.ceil(graph.edges.length / PAGE_SIZE));
  const nodePageCount = Math.max(1, Math.ceil(graph.nodes.length / PAGE_SIZE));
  useEffect(() => {
    setPage(0);
    setNodePage(0);
    menu.close();
  }, [graph]);
  useEffect(() => setPage((value) => Math.min(value, pageCount - 1)), [pageCount]);
  useEffect(() => setNodePage((value) => Math.min(value, nodePageCount - 1)), [nodePageCount]);
  const visible = graph.edges.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const visibleNodes = graph.nodes.slice(nodePage * PAGE_SIZE, (nodePage + 1) * PAGE_SIZE);

  const menuActions = {
    select: onSelectNode,
    openSource: onOpenSource,
  };
  const entityMenuActions = {
    ...menuActions,
    copyName: async (name: string) => {
      await copyText(name, '实体名已复制');
    },
  };

  if (graph.nodes.length === 0) {
    return <div className="graph-list-empty">当前筛选没有可显示的实体。</div>;
  }

  return (
    <div className="graph-list-view">
      <div className="graph-list-nodes" aria-label="实体列表">
        {visibleNodes.map((node) => (
          <button
            key={node.id}
            className={node.id === selectedNodeId ? 'graph-list-node active' : 'graph-list-node'}
            onClick={() => onSelectNode(node.id)}
            onContextMenu={(event) => menu.openFromEvent(
              event,
              createGraphEntityMenuSpec(node, selectedNodeId, entityMenuActions),
            )}
            onKeyDown={(event) => {
              if (!isContextMenuOpenKey(event)) return;
              menu.openFromKeyboard(
                event,
                createGraphEntityMenuSpec(node, selectedNodeId, entityMenuActions),
              );
            }}
          >
            <span>{node.name}</span>
            <small>{node.typeId}</small>
          </button>
        ))}
        {nodePageCount > 1 && (
          <span className="graph-node-pagination">
            <button aria-label="上一页实体" disabled={nodePage === 0} onClick={() => setNodePage((value) => value - 1)}>‹</button>
            <small>{nodePage + 1}/{nodePageCount}</small>
            <button aria-label="下一页实体" disabled={nodePage + 1 >= nodePageCount} onClick={() => setNodePage((value) => value + 1)}>›</button>
          </span>
        )}
      </div>
      <div className="graph-list-relations" role="list" aria-label="关系列表">
        {visible.map((edge) => {
          const source = nodes.get(edge.sourceId);
          const target = nodes.get(edge.targetId);
          const relation = relationTypes.get(edge.relationTypeId);
          const text = relationText(edge, source, target, relation);
          const relationSpec = createGraphRelationMenuSpec(
            edge,
            source,
            target,
            relation,
            selectedNodeId,
            {
              ...menuActions,
              copyRelation: async (value) => {
                await copyText(value, '关系已复制');
              },
            },
          );
          return (
            <article
              className="graph-list-relation"
              role="listitem"
              tabIndex={0}
              key={edge.id}
              onContextMenu={(event) => menu.openFromEvent(event, relationSpec)}
              onKeyDown={(event) => menu.openFromKeyboard(event, relationSpec)}
            >
              <button onClick={() => onSelectNode(edge.sourceId)}>{source?.name ?? edge.sourceId}</button>
              <span className="graph-list-relation-label">
                {relation?.name ?? edge.relationTypeId}
                {!relation?.directed && ' · 无向'}
                <small>{edge.confidence}</small>
              </span>
              <button onClick={() => onSelectNode(edge.targetId)}>{target?.name ?? edge.targetId}</button>
              {edge.sources[0] && (
                <button className="graph-source-link" onClick={() => onOpenSource(edge.sources[0]!)}>
                  查看出处
                </button>
              )}
              <button
                className="graph-copy-relation"
                aria-label={`复制关系：${text}`}
                onClick={() => void copyText(text, '关系已复制')}
              >
                复制
              </button>
            </article>
          );
        })}
        {graph.edges.length === 0 && <div className="graph-list-empty">当前筛选没有关系。</div>}
      </div>
      {pageCount > 1 && (
        <nav className="graph-pagination" aria-label="关系列表分页">
          <button disabled={page === 0} onClick={() => setPage((value) => value - 1)}>上一页</button>
          <span>{page + 1} / {pageCount}</span>
          <button disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>下一页</button>
        </nav>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
