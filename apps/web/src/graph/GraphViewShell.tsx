import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  GraphConfidence,
  GraphSourceExcerpt,
  GraphSourceRef,
  GraphView,
  GraphVisibility,
  ChapterTreeNode,
  WorldNode,
} from '@writing-studio/contract';
import { WORLD_GRAPH_RENDER_BUDGET } from '@writing-studio/contract';
import { XIcon } from '../components/icons.js';
import { api } from '../api.js';
import { useStudio } from '../store.js';
import '../styles/graph.css';
import { supportsWebGl2, prefersReducedMotion } from './capabilities.js';
import {
  currentDocumentSeeds,
  filterGraph,
  localGraph,
  matchingNodes,
  sampleGlobalGraph,
} from './derive.js';
import type { GraphFilters } from './derive.js';
import { GraphDetails } from './GraphDetails.js';
import { GraphRelationList } from './GraphRelationList.js';
import type { GraphForces, GraphVisualMode } from './GraphCanvas.js';
import { edgeColor, nodeColor } from './palette.js';
import { StopPointUnsetNotice } from './StopPointUnsetNotice.js';
import { useWorldGraph } from './useWorldGraph.js';

const LazyGraphCanvas = lazy(async () => {
  const module = await import('./GraphCanvas.js');
  return { default: module.GraphCanvas };
});

type WorkspaceMode = GraphVisualMode | 'list';

const DEFAULT_FORCES: GraphForces = {
  center: 0.75,
  charge: -70,
  link: 0.62,
  distance: 48,
};

interface GraphViewShellProps {
  onClose(): void;
}

interface CanvasBoundaryProps {
  onError(): void;
  children: React.ReactNode;
}

interface SourceDrawerState {
  requestKey: string;
  excerpt: GraphSourceExcerpt | null;
  loading: boolean;
  error: string | null;
}

class CanvasBoundary extends Component<CanvasBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    this.props.onError();
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function toggleValue<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function GraphViewShell({ onClose }: GraphViewShellProps): React.JSX.Element {
  const activeProjectId = useStudio((state) => state.activeProjectId);
  const project = useStudio((state) => state.projects.find((item) => item.config.id === state.activeProjectId));
  const tree = useStudio((state) => state.tree);
  const doc = useStudio((state) => state.doc);
  const editorContent = useStudio((state) => state.editorContent);
  const openDocument = useStudio((state) => state.openDocument);
  const pushToast = useStudio((state) => state.pushToast);
  const graphConfig = project?.config.graph;
  const projectId = activeProjectId ?? '';
  const [view, setView] = useState<GraphView>('planner');
  const [mode, setMode] = useState<WorkspaceMode>(() => supportsWebGl2() ? 'local2d' : 'list');
  const lastSpatialMode = useRef<GraphVisualMode>('local2d');
  const [depth, setDepth] = useState(1);
  const [query, setQuery] = useState('');
  const [manualSeed, setManualSeed] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; token: number } | null>(null);
  const [excludedNodeTypes, setExcludedNodeTypes] = useState<string[]>([]);
  const [excludedRelationTypes, setExcludedRelationTypes] = useState<string[]>([]);
  const [confidences, setConfidences] = useState<GraphConfidence[]>(['confirmed', 'inferred', 'question']);
  const [visibilities, setVisibilities] = useState<GraphVisibility[]>(['public', 'authorOnly']);
  // Planner-derived sidebar entities intentionally have unknown story time
  // until the author confirms them in the canonical relationship file. Keep
  // them discoverable by default; the server still excludes unknown time from
  // the writer projection.
  const [showUnknownTime, setShowUnknownTime] = useState(true);
  const [showIsolated, setShowIsolated] = useState(true);
  const [throughOrder, setThroughOrder] = useState<number | null>(null);
  const [forces, setForces] = useState(DEFAULT_FORCES);
  const [draftForces, setDraftForces] = useState(DEFAULT_FORCES);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const sourceRequestKey = `${projectId}\u0000${view}`;
  const sourceAbortRef = useRef<AbortController | null>(null);
  const [sourceState, setSourceState] = useState<SourceDrawerState>({
    requestKey: '',
    excerpt: null,
    loading: false,
    error: null,
  });
  const currentSourceState = sourceState.requestKey === sourceRequestKey
    ? sourceState
    : { requestKey: sourceRequestKey, excerpt: null, loading: false, error: null };
  const sourceExcerpt = currentSourceState.excerpt;
  const sourceLoading = currentSourceState.loading;
  const sourceError = currentSourceState.error;
  const reducedMotion = useMemo(prefersReducedMotion, []);
  const { snapshot, loading, error, refresh } = useWorldGraph(projectId, view);
  const writerStopUnset = view === 'writer' && snapshot?.stopState === 'unset';

  useEffect(() => {
    const timer = window.setTimeout(() => setForces(draftForces), 150);
    return () => clearTimeout(timer);
  }, [draftForces]);

  useEffect(() => {
    sourceAbortRef.current?.abort();
    sourceAbortRef.current = null;
    setSourceState({
      requestKey: sourceRequestKey,
      excerpt: null,
      loading: false,
      error: null,
    });
    return () => sourceAbortRef.current?.abort();
  }, [sourceRequestKey]);

  useEffect(() => {
    if (!snapshot) return;
    const min = snapshot.storyPoints[0]?.order ?? 0;
    const max = snapshot.storyPoints.at(-1)?.order ?? 0;
    const preferred = snapshot.stopPoint?.order ?? max;
    setThroughOrder((value) => value === null ? preferred : Math.min(Math.max(min, value), max));
  }, [snapshot]);

  const filters = useMemo<GraphFilters>(() => ({
    nodeTypeIds: new Set(snapshot?.nodeTypes.filter((item) => !excludedNodeTypes.includes(item.id)).map((item) => item.id)),
    relationTypeIds: new Set(snapshot?.relationTypes
      .filter((item) => !excludedRelationTypes.includes(item.id)).map((item) => item.id)),
    confidences: new Set(confidences),
    visibilities: new Set(visibilities),
    throughOrder,
    showUnknownTime,
    showIsolated,
  }), [
    confidences,
    excludedNodeTypes,
    excludedRelationTypes,
    showIsolated,
    showUnknownTime,
    snapshot,
    throughOrder,
    visibilities,
  ]);
  const filtered = useMemo(
    () => snapshot ? filterGraph(snapshot, filters) : { nodes: [], edges: [] },
    [filters, snapshot],
  );
  const automaticSeeds = useMemo(
    () => currentDocumentSeeds(filtered, doc?.docId ?? null, editorContent),
    [doc?.docId, editorContent, filtered],
  );
  const seeds = manualSeed ? [manualSeed] : automaticSeeds;
  const local = useMemo(() => localGraph(filtered, seeds, depth), [depth, filtered, seeds]);
  const pinnedGlobalIds = useMemo(
    () => [manualSeed, selectedNodeId].filter((id): id is string => id !== null),
    [manualSeed, selectedNodeId],
  );
  const sampledGlobal = useMemo(
    () => sampleGlobalGraph(
      filtered,
      WORLD_GRAPH_RENDER_BUDGET.nodes,
      WORLD_GRAPH_RENDER_BUDGET.edges,
      pinnedGlobalIds,
    ),
    [filtered, pinnedGlobalIds],
  );
  if (mode !== 'list') lastSpatialMode.current = mode;
  const spatialMode = mode === 'list' ? lastSpatialMode.current : mode;
  const spatialDisplay = spatialMode === 'local2d' ? local : sampledGlobal.graph;
  // The DOM fallback is paginated, so the global list can retain the complete
  // filtered snapshot even when the 3D renderer must sample it.
  const display = mode === 'list' && spatialMode === 'global3d' ? filtered : spatialDisplay;
  const nodeTypeNames = useMemo(
    () => new Map(snapshot?.nodeTypes.map((type) => [type.id, type.name])),
    [snapshot?.nodeTypes],
  );
  const searchResults = useMemo(
    () => matchingNodes(filtered, query, nodeTypeNames).slice(0, 20),
    [filtered, nodeTypeNames, query],
  );
  const selectedNode = useMemo<WorldNode | null>(
    () => display.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [display.nodes, selectedNodeId],
  );

  useEffect(() => {
    if (selectedNodeId && !display.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [display.nodes, selectedNodeId]);

  const setWorkspaceMode = (next: WorkspaceMode): void => {
    if (next !== 'list' && !supportsWebGl2()) {
      setMode('list');
      pushToast('warning', '当前环境没有可用的 WebGL2，已切换到关系列表');
      return;
    }
    if (next !== 'list') lastSpatialMode.current = next;
    setMode(next);
  };
  const focusNode = (id: string): void => {
    setSelectedNodeId(id);
    setFocusRequest((current) => ({ id, token: (current?.token ?? 0) + 1 }));
  };
  const chooseSearchResult = (node: WorldNode): void => {
    setManualSeed(node.id);
    setSelectedNodeId(node.id);
    setQuery(node.name);
    if (mode !== 'list') setFocusRequest((current) => ({ id: node.id, token: (current?.token ?? 0) + 1 }));
  };

  const chapterIds = useMemo(() => {
    const ids = new Set<string>();
    const visit = (node: ChapterTreeNode): void => {
      node.chapters.forEach((chapter) => ids.add(chapter.docId));
      node.children.forEach(visit);
    };
    if (tree) visit(tree.root);
    return ids;
  }, [tree]);
  const isEditableDocument = useCallback((docId: string): boolean => (
    docId === graphConfig?.relationsFile
    || project?.config.sidebarSources.some((source) => source.file === docId) === true
    || chapterIds.has(docId)
  ), [chapterIds, graphConfig?.relationsFile, project?.config.sidebarSources]);

  const openSource = useCallback(async (source: GraphSourceRef): Promise<void> => {
    if (!projectId) return;
    sourceAbortRef.current?.abort();
    sourceAbortRef.current = null;
    setSourceState({ requestKey: sourceRequestKey, excerpt: null, loading: false, error: null });
    if (isEditableDocument(source.docId)) {
      try {
        const opened = await openDocument(source.docId, source.heading);
        if (opened) onClose();
        return;
      } catch (reason) {
        setSourceState({
          requestKey: sourceRequestKey,
          excerpt: null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }
    const controller = new AbortController();
    sourceAbortRef.current = controller;
    setSourceState({ requestKey: sourceRequestKey, excerpt: null, loading: true, error: null });
    try {
      const excerpt = await api.getGraphSource(projectId, source.docId, source.heading, view, controller.signal);
      if (!controller.signal.aborted) {
        setSourceState({ requestKey: sourceRequestKey, excerpt, loading: false, error: null });
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setSourceState({
          requestKey: sourceRequestKey,
          excerpt: null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    } finally {
      if (sourceAbortRef.current === controller) sourceAbortRef.current = null;
    }
  }, [isEditableDocument, onClose, openDocument, projectId, sourceRequestKey, view]);

  if (!graphConfig || !projectId) {
    return (
      <section className="graph-workspace graph-state" aria-label="世界关系图">
        <p>当前项目未配置关系图。</p>
        <button onClick={onClose}>返回编辑器</button>
      </section>
    );
  }

  const minOrder = snapshot?.storyPoints[0]?.order ?? 0;
  const maxOrder = snapshot?.storyPoints.at(-1)?.order ?? minOrder;
  const currentPoint = snapshot?.storyPoints.find((point) => point.order === throughOrder);

  return (
    <section className="graph-workspace" aria-label="世界关系图工作区">
      <header className="graph-header">
        <div>
          <strong>关系图</strong>
          <span>{view === 'planner' ? '作者全图' : 'writer-safe 投影预览'}</span>
        </div>
        <div className="graph-header-actions">
          <button
            onClick={() => void openDocument(graphConfig.relationsFile).then((opened) => {
              if (opened) onClose();
            }).catch((reason) => pushToast('danger', `无法打开关系数据：${reason instanceof Error ? reason.message : String(reason)}`))}
          >
            编辑关系数据
          </button>
          {/* The icon close button the modal and the toast already use. No
              .btn-icon class: that carries theme panel colours, and inside
              .graph-workspace the plain button already inherits --graph-text. */}
          <button onClick={onClose} aria-label="关闭"><XIcon size={14} /></button>
        </div>
      </header>

      <div className="graph-toolbar">
        {/* A mutually exclusive group, so it is a tablist like the app's three
            other mode switches — not aria-pressed, which is for independent
            toggles and would claim all three can be on at once. */}
        <div className="graph-mode-switch" role="tablist" aria-label="视图模式">
          <button role="tab" aria-selected={mode === 'local2d'} className={mode === 'local2d' ? 'active' : ''} onClick={() => setWorkspaceMode('local2d')}>局部 2D</button>
          <button role="tab" aria-selected={mode === 'global3d'} className={mode === 'global3d' ? 'active' : ''} onClick={() => setWorkspaceMode('global3d')}>全局 3D</button>
          <button role="tab" aria-selected={mode === 'list'} className={mode === 'list' ? 'active' : ''} onClick={() => setWorkspaceMode('list')}>关系列表</button>
        </div>
        <label className="graph-search">
          <span>搜索</span>
          <input
            autoFocus
            value={query}
            placeholder="名称、别名或类型"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.trim() && searchResults.length > 0 && (
            <div className="graph-search-results">
              {searchResults.map((node) => (
                <button key={node.id} onClick={() => chooseSearchResult(node)}>
                  <span>{node.name}</span><small>{node.typeId}</small>
                </button>
              ))}
            </div>
          )}
        </label>
        {spatialMode === 'local2d' && (
          <label className="graph-depth">
            <span>邻接深度 {depth}</span>
            <input
              type="range"
              min="1"
              max="3"
              value={depth}
              aria-valuetext={`${depth} 层邻接`}
              onChange={(event) => setDepth(Number(event.target.value))}
            />
          </label>
        )}
        <label className="graph-safe-toggle">
          <input
            type="checkbox"
            checked={view === 'writer'}
            onChange={(event) => setView(event.target.checked ? 'writer' : 'planner')}
          />
          writer-safe 预览
        </label>
        <button
          className={diagnosticsOpen ? 'active' : ''}
          aria-pressed={diagnosticsOpen}
          onClick={() => setDiagnosticsOpen((value) => !value)}
        >
          图体检 {snapshot?.diagnosticCount ?? 0}
        </button>
      </div>

      {snapshot && !writerStopUnset && (
        <div className="graph-controls">
          <label className="graph-time">
            <span>{currentPoint?.label ?? '时间切片'}</span>
            <input
              type="range"
              min={minOrder}
              max={maxOrder}
              value={throughOrder ?? maxOrder}
              aria-valuetext={currentPoint ? `截至${currentPoint.label}` : '时间未知'}
              onChange={(event) => setThroughOrder(Number(event.target.value))}
            />
          </label>
          <details>
            <summary>筛选</summary>
            <div className="graph-filter-menu">
              <fieldset>
                <legend>实体类型</legend>
                {snapshot.nodeTypes.map((type) => (
                  <label key={type.id}>
                    <input
                      type="checkbox"
                      checked={!excludedNodeTypes.includes(type.id)}
                      onChange={() => setExcludedNodeTypes(toggleValue(excludedNodeTypes, type.id))}
                    />
                    <span className="graph-legend-dot" style={{ backgroundColor: nodeColor(type.visualFamily) }} aria-hidden="true" />
                    {type.name}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>关系类型</legend>
                {snapshot.relationTypes.map((type) => (
                  <label key={type.id}>
                    <input
                      type="checkbox"
                      checked={!excludedRelationTypes.includes(type.id)}
                      onChange={() => setExcludedRelationTypes(toggleValue(excludedRelationTypes, type.id))}
                    />
                    <span className="graph-legend-line" style={{ borderColor: edgeColor(type.visualFamily) }} aria-hidden="true" />
                    {type.name}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>置信与可见性</legend>
                {(['confirmed', 'inferred', 'question'] as const).map((item) => (
                  <label key={item}><input type="checkbox" checked={confidences.includes(item)} onChange={() => setConfidences(toggleValue(confidences, item))} />{item}</label>
                ))}
                {(['public', 'authorOnly'] as const).map((item) => (
                  <label key={item}><input type="checkbox" checked={visibilities.includes(item)} onChange={() => setVisibilities(toggleValue(visibilities, item))} />{item}</label>
                ))}
                <label><input type="checkbox" checked={showUnknownTime} onChange={(event) => setShowUnknownTime(event.target.checked)} />显示时间未知项</label>
                <label><input type="checkbox" checked={showIsolated} onChange={(event) => setShowIsolated(event.target.checked)} />显示孤立节点</label>
              </fieldset>
            </div>
          </details>
          <details>
            <summary>布局</summary>
            <div className="graph-layout-menu">
              <label>中心力<input type="range" min="0" max="1" step="0.05" value={draftForces.center} onChange={(event) => setDraftForces({ ...draftForces, center: Number(event.target.value) })} /></label>
              <label>斥力<input type="range" min="-180" max="-20" step="5" value={draftForces.charge} onChange={(event) => setDraftForces({ ...draftForces, charge: Number(event.target.value) })} /></label>
              <label>连接力<input type="range" min="0.1" max="1" step="0.05" value={draftForces.link} onChange={(event) => setDraftForces({ ...draftForces, link: Number(event.target.value) })} /></label>
              <label>连接距离<input type="range" min="20" max="120" step="2" value={draftForces.distance} onChange={(event) => setDraftForces({ ...draftForces, distance: Number(event.target.value) })} /></label>
              <button onClick={() => { setDraftForces(DEFAULT_FORCES); setForces(DEFAULT_FORCES); }}>恢复默认</button>
            </div>
          </details>
          <span className="graph-counts" aria-live="polite">
            {display.nodes.length} 实体 · {display.edges.length} 关系
          </span>
          {sampledGlobal.sampled && spatialMode === 'global3d' && (
            <span className="graph-sampling-note">全图超出 1000/3000 渲染预算，当前为确定性抽样；局部图仍使用完整快照。</span>
          )}
        </div>
      )}

      <div className={`graph-body${writerStopUnset ? ' graph-body-unset' : ''}`}>
        <div className="graph-main">
          {/* These keep the graph's own markup rather than the shared Empty/
              ErrorState: those are styled against the theme-aware panel
              surface, and this canvas is dark in both themes. Only the missing
              announcements are added. */}
          {loading && <div className="graph-state" role="status">正在读取关系图…</div>}
          {!loading && error && (
            <div className="graph-state graph-error" role="alert">
              <p>{error}</p>
              <button onClick={refresh}>重试</button>
            </div>
          )}
          {!loading && snapshot?.stopState === 'unset' && view === 'planner' && (
            <StopPointUnsetNotice view="planner" />
          )}
          {!loading && snapshot && writerStopUnset && (
            <StopPointUnsetNotice view="writer" onReturnToPlanner={() => setView('planner')} />
          )}
          {!loading && snapshot && !writerStopUnset && spatialMode === 'local2d' && seeds.length === 0 && (
            <div className="graph-state">
              <p>当前文档没有命中实体。搜索一个人物或设定词条作为中心。</p>
            </div>
          )}
          {!loading && snapshot && !writerStopUnset && mode === 'list' && (
            <GraphRelationList
              graph={display}
              snapshot={snapshot}
              selectedNodeId={selectedNodeId}
              onSelectNode={setSelectedNodeId}
              onOpenSource={(source) => void openSource(source)}
            />
          )}
          {!loading && snapshot && !writerStopUnset && mode !== 'list' && display.nodes.length > 0 && (
            <CanvasBoundary key={snapshot.version} onError={() => setMode('list')}>
              <Suspense fallback={<div className="graph-state" role="status">正在加载图形渲染器…</div>}>
                <LazyGraphCanvas
                  graph={display}
                  snapshot={snapshot}
                  mode={mode}
                  selectedNodeId={selectedNodeId}
                  focusRequest={focusRequest}
                  forces={forces}
                  reducedMotion={reducedMotion}
                  bloom={!reducedMotion && display.nodes.length <= 600}
                  onSelectNode={setSelectedNodeId}
                  onFocusNode={focusNode}
                  onUnavailable={() => setMode('list')}
                />
              </Suspense>
            </CanvasBoundary>
          )}
        </div>
        {snapshot && !writerStopUnset && (
          <GraphDetails
            graph={display}
            snapshot={snapshot}
            node={selectedNode}
            onSelectNode={focusNode}
            onOpenSource={(source) => void openSource(source)}
          />
        )}
      </div>

      {diagnosticsOpen && snapshot && (
        <aside className="graph-diagnostics" aria-label="关系图诊断">
          <header>
            <strong>图体检</strong>
            <button onClick={() => setDiagnosticsOpen(false)} aria-label="关闭"><XIcon size={14} /></button>
          </header>
          {snapshot.diagnostics.length === 0 ? <p>没有诊断项。</p> : snapshot.diagnostics.map((diagnostic, index) => (
            <button
              key={`${diagnostic.code}-${diagnostic.file}-${diagnostic.line ?? index}`}
              className={`graph-diagnostic ${diagnostic.severity}`}
              onClick={() => void openSource({ docId: diagnostic.file, heading: null, label: null })}
            >
              <span>{diagnostic.code}</span>
              <strong>{diagnostic.message}</strong>
              <small>{diagnostic.file}{diagnostic.line ? `:${diagnostic.line}` : ''}</small>
            </button>
          ))}
          {snapshot.diagnosticCount > snapshot.diagnostics.length && <p>仅显示前 {snapshot.diagnostics.length} 条，共 {snapshot.diagnosticCount} 条。</p>}
        </aside>
      )}

      {(sourceExcerpt || sourceLoading || sourceError) && (
        <aside className="graph-source-drawer" aria-label="只读出处摘录">
          <header>
            <strong>{sourceExcerpt?.source.label ?? sourceExcerpt?.source.docId ?? '出处'}</strong>
            <button
              aria-label="关闭"
              onClick={() => {
                sourceAbortRef.current?.abort();
                sourceAbortRef.current = null;
                setSourceState({ requestKey: sourceRequestKey, excerpt: null, loading: false, error: null });
              }}
            >
              <XIcon size={14} />
            </button>
          </header>
          {sourceLoading && <p role="status">正在读取有界摘录…</p>}
          {sourceError && <p className="graph-error" role="alert">{sourceError}</p>}
          {sourceExcerpt && (
            <>
              <pre>{sourceExcerpt.markdown}</pre>
              {sourceExcerpt.truncated && <p>摘录已按安全上限截断。</p>}
            </>
          )}
        </aside>
      )}
    </section>
  );
}
