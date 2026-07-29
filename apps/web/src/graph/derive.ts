import type {
  GraphConfidence,
  GraphStoryTime,
  GraphVisibility,
  WorldEdge,
  WorldGraphSnapshot,
  WorldNode,
} from '@writing-studio/contract';

export interface GraphFilters {
  nodeTypeIds: ReadonlySet<string>;
  relationTypeIds: ReadonlySet<string>;
  confidences: ReadonlySet<GraphConfidence>;
  visibilities: ReadonlySet<GraphVisibility>;
  throughOrder: number | null;
  showUnknownTime: boolean;
  showIsolated: boolean;
}

export interface DisplayGraph {
  nodes: WorldNode[];
  edges: WorldEdge[];
}

function storyOrder(time: GraphStoryTime): number | null {
  if (time === '@start') return Number.NEGATIVE_INFINITY;
  return time?.order ?? null;
}

function existsAt(
  activeFrom: GraphStoryTime,
  revealedAt: GraphStoryTime,
  inactiveFrom: GraphStoryTime,
  throughOrder: number | null,
  showUnknownTime: boolean,
): boolean {
  if (throughOrder === null) return showUnknownTime || (activeFrom !== null && revealedAt !== null);
  const active = storyOrder(activeFrom);
  const revealed = storyOrder(revealedAt);
  const inactive = storyOrder(inactiveFrom);
  if ((active === null || revealed === null) && !showUnknownTime) return false;
  if (active !== null && active > throughOrder) return false;
  if (revealed !== null && revealed > throughOrder) return false;
  // inactiveFrom is exclusive: the entity/edge is absent starting at this point.
  if (inactive !== null && throughOrder >= inactive) return false;
  return true;
}

export function filterGraph(snapshot: WorldGraphSnapshot, filters: GraphFilters): DisplayGraph {
  const nodes = snapshot.nodes.filter((node) => (
    filters.nodeTypeIds.has(node.typeId)
    && filters.confidences.has(node.confidence)
    && filters.visibilities.has(node.visibility)
    && existsAt(
      node.activeFrom,
      node.revealedAt,
      node.inactiveFrom,
      filters.throughOrder,
      filters.showUnknownTime,
    )
  ));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges.filter((edge) => (
    nodeIds.has(edge.sourceId)
    && nodeIds.has(edge.targetId)
    && filters.relationTypeIds.has(edge.relationTypeId)
    && filters.confidences.has(edge.confidence)
    && filters.visibilities.has(edge.visibility)
    && existsAt(
      edge.activeFrom,
      edge.revealedAt,
      edge.inactiveFrom,
      filters.throughOrder,
      filters.showUnknownTime,
    )
  ));
  if (filters.showIsolated) return { nodes, edges };
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.sourceId);
    connected.add(edge.targetId);
  }
  return { nodes: nodes.filter((node) => connected.has(node.id)), edges };
}

export function localGraph(graph: DisplayGraph, seedIds: readonly string[], depth: number): DisplayGraph {
  const available = new Set(graph.nodes.map((node) => node.id));
  let frontier = new Set(seedIds.filter((id) => available.has(id)));
  const included = new Set(frontier);
  const maxDepth = Math.max(0, Math.min(3, Math.floor(depth)));
  for (let step = 0; step < maxDepth && frontier.size > 0; step += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.sourceId) && !included.has(edge.targetId)) next.add(edge.targetId);
      if (frontier.has(edge.targetId) && !included.has(edge.sourceId)) next.add(edge.sourceId);
    }
    for (const id of next) included.add(id);
    frontier = next;
  }
  return {
    nodes: graph.nodes.filter((node) => included.has(node.id)),
    edges: graph.edges.filter((edge) => included.has(edge.sourceId) && included.has(edge.targetId)),
  };
}

export function currentDocumentSeeds(
  graph: DisplayGraph,
  docId: string | null,
  content: string,
): string[] {
  if (!docId && !content) return [];
  const normalizedContent = content.normalize('NFKC').toLocaleLowerCase();
  return graph.nodes
    .filter((node) => (
      (docId !== null && node.sources.some((source) => source.docId === docId))
      || [node.name, ...node.aliases].some((name) => {
        const candidate = name.normalize('NFKC').trim().toLocaleLowerCase();
        return candidate.length > 0 && normalizedContent.includes(candidate);
      })
    ))
    .map((node) => node.id)
    .sort();
}

export function matchingNodes(
  graph: DisplayGraph,
  query: string,
  typeNames: ReadonlyMap<string, string> = new Map(),
): WorldNode[] {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase();
  if (!needle) return [];
  return graph.nodes
    .filter((node) => [node.id, node.name, node.typeId, typeNames.get(node.typeId) ?? '', ...node.aliases]
      .some((value) => value.normalize('NFKC').toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.id.localeCompare(b.id));
}

export function degrees(graph: DisplayGraph): Map<string, number> {
  const result = new Map<string, number>();
  for (const node of graph.nodes) result.set(node.id, 0);
  for (const edge of graph.edges) {
    result.set(edge.sourceId, (result.get(edge.sourceId) ?? 0) + 1);
    result.set(edge.targetId, (result.get(edge.targetId) ?? 0) + 1);
  }
  return result;
}

export function nodeSize(node: WorldNode, degree: number, visualFamily: string): number {
  const base = visualFamily === 'character' ? 8 : visualFamily === 'faction' || visualFamily === 'place' ? 6 : 4;
  return base + Math.min(degree * 0.4, 8) + (node.implicit ? -1 : 0);
}

export function sampleGlobalGraph(
  graph: DisplayGraph,
  nodeBudget: number,
  edgeBudget: number,
  pinnedIds: readonly string[] = [],
): { graph: DisplayGraph; sampled: boolean } {
  if (graph.nodes.length <= nodeBudget && graph.edges.length <= edgeBudget) {
    return { graph, sampled: false };
  }
  const degree = degrees(graph);
  const availableIds = new Set(graph.nodes.map((node) => node.id));
  const selectedIds = new Set(
    [...new Set(pinnedIds.filter((id) => availableIds.has(id)))].sort().slice(0, nodeBudget),
  );
  const ranked = [...graph.nodes].sort((a, b) => (
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
    || Number(a.implicit) - Number(b.implicit)
    || a.id.localeCompare(b.id)
  ));
  for (const node of ranked) {
    if (selectedIds.size >= nodeBudget) break;
    selectedIds.add(node.id);
  }
  const nodes = graph.nodes.filter((node) => selectedIds.has(node.id));
  const edges = graph.edges
    .filter((edge) => selectedIds.has(edge.sourceId) && selectedIds.has(edge.targetId))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, edgeBudget);
  return { graph: { nodes, edges }, sampled: true };
}
