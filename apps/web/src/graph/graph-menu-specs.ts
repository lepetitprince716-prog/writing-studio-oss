import type {
  GraphSourceRef,
  RelationTypeDefinition,
  WorldEdge,
  WorldNode,
} from '@writing-studio/contract';
import { withDisabledReason, type ContextMenuSpec } from '../components/ContextMenu.js';

interface EntityMenuActions {
  select(id: string): void;
  openSource(source: GraphSourceRef): void;
  copyName(name: string): void | Promise<void>;
}

interface RelationMenuActions {
  copyRelation(text: string): void | Promise<void>;
  openSource(source: GraphSourceRef): void;
  select(id: string): void;
}

export function relationText(
  edge: WorldEdge,
  source: WorldNode | undefined,
  target: WorldNode | undefined,
  relation: RelationTypeDefinition | undefined,
): string {
  return `${source?.name ?? edge.sourceId} ${relation?.name ?? edge.relationTypeId} ${target?.name ?? edge.targetId}`;
}

export function createGraphEntityMenuSpec(
  node: WorldNode,
  selectedNodeId: string | null,
  actions: EntityMenuActions,
): ContextMenuSpec {
  const source = node.sources[0];
  return {
    label: `${node.name} · 操作`,
    items: [
      withDisabledReason({
        id: 'select-graph-entity',
        label: '选中该实体',
        onSelect: () => actions.select(node.id),
      }, node.id === selectedNodeId ? '该实体已选中' : undefined),
      withDisabledReason({
        id: 'open-graph-entity-source',
        label: '打开出处',
        onSelect: () => {
          if (source) actions.openSource(source);
        },
      }, source === undefined ? '该实体没有出处' : undefined),
      { id: 'graph-entity-copy-separator', separator: true },
      {
        id: 'copy-graph-entity-name',
        label: '复制实体名',
        onSelect: () => actions.copyName(node.name),
      },
    ],
  };
}

export function createGraphRelationMenuSpec(
  edge: WorldEdge,
  source: WorldNode | undefined,
  target: WorldNode | undefined,
  relation: RelationTypeDefinition | undefined,
  selectedNodeId: string | null,
  actions: RelationMenuActions,
): ContextMenuSpec {
  const sourceRef = edge.sources[0];
  const text = relationText(edge, source, target, relation);
  return {
    label: `${text} · 操作`,
    items: [
      {
        id: 'copy-graph-relation',
        label: '复制关系',
        onSelect: () => actions.copyRelation(text),
      },
      withDisabledReason({
        id: 'open-graph-relation-source',
        label: '打开出处',
        onSelect: () => {
          if (sourceRef) actions.openSource(sourceRef);
        },
      }, sourceRef === undefined ? '该关系没有出处' : undefined),
      withDisabledReason({
        id: 'select-graph-relation-source',
        label: '选中源实体',
        onSelect: () => actions.select(edge.sourceId),
      }, edge.sourceId === selectedNodeId ? '源实体已选中' : undefined),
      withDisabledReason({
        id: 'select-graph-relation-target',
        label: '选中目标实体',
        onSelect: () => actions.select(edge.targetId),
      }, edge.targetId === selectedNodeId ? '目标实体已选中' : undefined),
    ],
  };
}
