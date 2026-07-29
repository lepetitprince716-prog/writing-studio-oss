import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from './store.js';
import { connectWs } from './ws.js';
import { TreePanel } from './components/TreePanel.js';
import { EditorPane } from './components/EditorPane.js';
import { GenerateWorkspace } from './components/GenerateWorkspace.js';
import { RightPane } from './components/RightPane.js';
import { PaneDivider } from './components/PaneDivider.js';
import { ToastHost } from './components/Toast.js';
import { ConfirmModal } from './components/ConfirmModal.js';
import { FeatureErrorBoundary } from './components/FeatureErrorBoundary.js';
import {
  GitBranchIcon,
  MaximizeIcon,
  MinimizeIcon,
  MonitorIcon,
  MoonIcon,
  NetworkIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SunIcon,
} from './components/icons.js';
import { LEFT_MAX, LEFT_MIN, NARROW_VIEWPORT, RIGHT_MAX, RIGHT_MIN } from './store.js';

const THEME_LABEL = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' } as const;
const loadGraphView = async () => {
  const module = await import('./graph/GraphViewShell.js');
  return { default: module.GraphViewShell };
};
const loadRewriteReview = async () => {
  const module = await import('./components/RewriteReview.js');
  return { default: module.RewriteReview };
};
const loadRevisionHistory = async () => {
  const module = await import('./components/RevisionHistory.js');
  return { default: module.RevisionHistory };
};

export function App(): React.JSX.Element {
  const projects = useStudio((s) => s.projects);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const appMode = useStudio((s) => s.appMode);
  const setAppMode = useStudio((s) => s.setAppMode);
  const git = useStudio((s) => s.git);
  const theme = useStudio((s) => s.theme);
  const leftCollapsed = useStudio((s) => s.leftCollapsed);
  const rightCollapsed = useStudio((s) => s.rightCollapsed);
  const leftWidth = useStudio((s) => s.leftWidth);
  const rightWidth = useStudio((s) => s.rightWidth);
  const focusMode = useStudio((s) => s.focusMode);
  const editorDirty = useStudio((s) => s.editorDirty);
  const rewriteReviewOpen = useStudio((s) => s.rewriteReview !== null);
  const revisionHistoryOpen = useStudio((s) => s.revisionHistoryOpen);
  const loadProjects = useStudio((s) => s.loadProjects);
  const loadAgents = useStudio((s) => s.loadAgents);
  const selectProject = useStudio((s) => s.selectProject);
  const cycleTheme = useStudio((s) => s.cycleTheme);
  const toggleLeft = useStudio((s) => s.toggleLeft);
  const toggleRight = useStudio((s) => s.toggleRight);
  const setLeftWidth = useStudio((s) => s.setLeftWidth);
  const setRightWidth = useStudio((s) => s.setRightWidth);
  const toggleFocus = useStudio((s) => s.toggleFocus);
  const closeDrawers = useStudio((s) => s.closeDrawers);
  const activeProject = projects.find((project) => project.config.id === activeProjectId);

  const [resizing, setResizing] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [graphLoadAttempt, setGraphLoadAttempt] = useState(0);
  const [rewriteLoadAttempt, setRewriteLoadAttempt] = useState(0);
  const [revisionLoadAttempt, setRevisionLoadAttempt] = useState(0);
  // React.lazy caches a rejected import promise. Recreating the wrapper lets
  // the retry button (and a later reopen) make a real new import attempt.
  const LazyGraphView = useMemo(() => lazy(loadGraphView), [graphLoadAttempt]);
  const LazyRewriteReview = useMemo(() => lazy(loadRewriteReview), [rewriteLoadAttempt]);
  const LazyRevisionHistory = useMemo(() => lazy(loadRevisionHistory), [revisionLoadAttempt]);
  const leftPaneRef = useRef<HTMLElement>(null);
  const rightPaneRef = useRef<HTMLElement>(null);
  const editorWorkspaceRef = useRef<HTMLDivElement>(null);
  const graphButtonRef = useRef<HTMLButtonElement>(null);
  const leftToggleRef = useRef<HTMLButtonElement>(null);
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const drawerOpenerRef = useRef<HTMLButtonElement | null>(null);

  const closeGraph = useCallback(() => {
    setGraphOpen(false);
    setGraphLoadAttempt((attempt) => attempt + 1);
    requestAnimationFrame(() => graphButtonRef.current?.focus());
  }, []);

  const retryGraph = useCallback(() => {
    setGraphLoadAttempt((attempt) => attempt + 1);
  }, []);

  const retryRewriteReview = useCallback(() => {
    setRewriteLoadAttempt((attempt) => attempt + 1);
  }, []);

  const closeRewriteReviewAfterError = useCallback(() => {
    setRewriteLoadAttempt((attempt) => attempt + 1);
    useStudio.getState().closeRewriteReview();
  }, []);

  const retryRevisionHistory = useCallback(() => {
    setRevisionLoadAttempt((attempt) => attempt + 1);
  }, []);

  const closeRevisionHistoryAfterError = useCallback(() => {
    setRevisionLoadAttempt((attempt) => attempt + 1);
    useStudio.getState().setRevisionHistoryOpen(false);
  }, []);

  const closeDrawersAndRestoreFocus = useCallback(() => {
    const opener = drawerOpenerRef.current;
    closeDrawers();
    drawerOpenerRef.current = null;
    requestAnimationFrame(() => opener?.focus());
  }, [closeDrawers]);

  const toggleLeftPane = useCallback(() => {
    const state = useStudio.getState();
    if (state.isNarrow && state.leftCollapsed) drawerOpenerRef.current = leftToggleRef.current;
    toggleLeft();
  }, [toggleLeft]);

  const toggleRightPane = useCallback(() => {
    const state = useStudio.getState();
    if (state.isNarrow && state.rightCollapsed) drawerOpenerRef.current = rightToggleRef.current;
    toggleRight();
  }, [toggleRight]);

  useEffect(() => {
    void Promise.all([loadProjects(), loadAgents()]);
  }, [loadAgents, loadProjects]);

  useEffect(() => {
    if (!activeProjectId) return undefined;
    return connectWs(activeProjectId);
  }, [activeProjectId]);

  // Cross the narrow breakpoint → panes flip between desktop columns and mobile
  // overlay drawers. Without this, a desktop→mobile resize leaves both panes
  // "shown" as fixed overlays stacked over the editor.
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${NARROW_VIEWPORT}px)`);
    const onChange = (): void => useStudio.getState().syncViewport(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        useStudio.getState().toggleFocus();
      } else if (e.key === 'Escape') {
        // Modal owns Escape first. On narrow screens the visible drawer is the
        // topmost dismissible layer, then the graph workspace, then focus mode.
        if (document.querySelector('[aria-modal="true"]')) return;
        const state = useStudio.getState();
        if (state.isNarrow && (!state.leftCollapsed || !state.rightCollapsed)) {
          e.preventDefault();
          closeDrawersAndRestoreFocus();
        } else if (graphOpen) {
          e.preventDefault();
          closeGraph();
        } else if (state.focusMode) {
          state.toggleFocus();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeDrawersAndRestoreFocus, closeGraph, graphOpen]);

  useEffect(() => {
    if (!activeProject?.config.graph && graphOpen) {
      setGraphOpen(false);
      setGraphLoadAttempt((attempt) => attempt + 1);
    }
  }, [activeProject?.config.graph, graphOpen]);

  // A rejected lazy wrapper stays rejected even after its feature is closed.
  // Reset the wrapper whenever a modal feature is dismissed through its own
  // store action, so a later open starts with a fresh import attempt.
  useEffect(() => {
    if (!rewriteReviewOpen) setRewriteLoadAttempt((attempt) => attempt + 1);
  }, [rewriteReviewOpen]);
  useEffect(() => {
    if (!revisionHistoryOpen) setRevisionLoadAttempt((attempt) => attempt + 1);
  }, [revisionHistoryOpen]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (!editorDirty) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editorDirty]);

  const ThemeIcon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon;
  const showLeft = !leftCollapsed && !focusMode;
  const showRight = !rightCollapsed && !focusMode;

  // `inert` removes a hidden pane's controls from the tab order and a11y tree
  // (aria-hidden alone leaves them keyboard-focusable).
  useEffect(() => {
    if (leftPaneRef.current) leftPaneRef.current.inert = !showLeft;
  }, [showLeft]);
  useEffect(() => {
    if (rightPaneRef.current) rightPaneRef.current.inert = !showRight;
  }, [showRight]);
  useEffect(() => {
    if (editorWorkspaceRef.current) editorWorkspaceRef.current.inert = graphOpen;
  }, [graphOpen]);

  const appClass = ['app', focusMode ? 'focus' : '', resizing ? 'resizing' : ''].filter(Boolean).join(' ');

  return (
    <div className={appClass}>
      <header className="topbar">
        <span className="brand">writing-studio</span>
        <select
          className="project-select"
          value={activeProjectId ?? ''}
          disabled={projects.length === 0}
          onChange={(e) => void selectProject(e.target.value)}
        >
          {projects.length === 0 && <option value="">无可用项目</option>}
          {projects.map((p) => (
            <option key={p.config.id} value={p.config.id}>
              {p.config.displayName}
            </option>
          ))}
        </select>
        <div className="mode-switch" role="tablist" aria-label="工作模式">
          <button
            role="tab"
            className={appMode === 'writing' ? 'mode-btn active' : 'mode-btn'}
            aria-selected={appMode === 'writing'}
            onClick={() => setAppMode('writing')}
          >
            写作
          </button>
          <button
            role="tab"
            className={appMode === 'generate' ? 'mode-btn active' : 'mode-btn'}
            aria-selected={appMode === 'generate'}
            onClick={() => setAppMode('generate')}
          >
            生成
          </button>
        </div>
        <span className="topbar-spacer" />
        {git && (
          <span
            className={git.dirty.length > 0 ? 'git-badge dirty' : 'git-badge'}
            title={
              git.dirty.length > 0
                ? git.dirty.map((d) => `${d.status} ${d.path}`).join('\n')
                : '工作区干净'
            }
          >
            <GitBranchIcon size={14} />
            <span className="git-badge-count">
              {git.branch}
              {git.dirty.length > 0 ? ` · ${git.dirty.length}` : ''}
            </span>
          </span>
        )}
        <div className="topbar-tools">
          {activeProject?.config.graph && (
            <button
              ref={graphButtonRef}
              className={graphOpen ? 'btn-icon active' : 'btn-icon'}
              title="打开关系图"
              aria-label="打开关系图"
              aria-pressed={graphOpen}
              onClick={() => setGraphOpen((value) => !value)}
            >
              <NetworkIcon />
            </button>
          )}
          <button
            ref={leftToggleRef}
            className={leftCollapsed ? 'btn-icon' : 'btn-icon active'}
            title={leftCollapsed ? '展开正文栏' : '收起正文栏'}
            aria-label="切换正文栏"
            aria-pressed={!leftCollapsed}
            onClick={toggleLeftPane}
          >
            <PanelLeftIcon />
          </button>
          <button
            ref={rightToggleRef}
            className={rightCollapsed ? 'btn-icon' : 'btn-icon active'}
            title={rightCollapsed ? '展开侧栏' : '收起侧栏'}
            aria-label="切换侧栏"
            aria-pressed={!rightCollapsed}
            onClick={toggleRightPane}
          >
            <PanelRightIcon />
          </button>
          <button
            className={focusMode ? 'btn-icon active' : 'btn-icon'}
            title="专注模式（⌘⇧F）"
            aria-label="专注模式"
            aria-pressed={focusMode}
            onClick={() => toggleFocus()}
          >
            {focusMode ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
          <button
            className="btn-icon"
            title={THEME_LABEL[theme]}
            aria-label={THEME_LABEL[theme]}
            onClick={() => cycleTheme()}
          >
            <ThemeIcon />
          </button>
        </div>
      </header>
      <main className="layout">
        <aside
          ref={leftPaneRef}
          className="pane left"
          aria-hidden={!showLeft}
          style={{ width: showLeft ? `${leftWidth}px` : '0px' }}
        >
          <div className="pane-scroll">
            <TreePanel />
          </div>
        </aside>
        {showLeft && (
          <PaneDivider
            side="left"
            width={leftWidth}
            min={LEFT_MIN}
            max={LEFT_MAX}
            onResize={setLeftWidth}
            onActive={setResizing}
          />
        )}
        <section className={graphOpen ? 'center graph-active' : 'center'}>
          {appMode === 'generate' && <GenerateWorkspace />}
          <div
            ref={editorWorkspaceRef}
            className="editor-workspace"
            aria-hidden={graphOpen || appMode === 'generate'}
            hidden={appMode === 'generate'}
          >
            <EditorPane />
          </div>
          {graphOpen && (
            <FeatureErrorBoundary
              key={graphLoadAttempt}
              featureName="关系图"
              fallbackClassName="graph-shell-loading"
              onError={() => {
                useStudio.getState().pushToast('danger', '关系图加载失败，可重试或关闭关系图');
              }}
              onRetry={retryGraph}
              onClose={closeGraph}
              closeLabel="关闭关系图"
            >
              <Suspense fallback={<div className="graph-shell-loading">正在打开关系图…</div>}>
                <LazyGraphView onClose={closeGraph} />
              </Suspense>
            </FeatureErrorBoundary>
          )}
        </section>
        {showRight && (
          <PaneDivider
            side="right"
            width={rightWidth}
            min={RIGHT_MIN}
            max={RIGHT_MAX}
            onResize={setRightWidth}
            onActive={setResizing}
          />
        )}
        <aside
          ref={rightPaneRef}
          className="pane right"
          aria-hidden={!showRight}
          style={{ width: showRight ? `${rightWidth}px` : '0px' }}
        >
          <RightPane />
        </aside>
      </main>
      {(showLeft || showRight) && (
        <div className="drawer-backdrop" onClick={closeDrawersAndRestoreFocus} />
      )}
      <ToastHost />
      <ConfirmModal />
      {rewriteReviewOpen && (
        <FeatureErrorBoundary
          key={rewriteLoadAttempt}
          featureName="改写对比"
          fallbackClassName="project-state project-error"
          onError={() => {
            useStudio.getState().pushToast('danger', '改写对比加载失败，可重试或关闭');
          }}
          onRetry={retryRewriteReview}
          onClose={closeRewriteReviewAfterError}
        >
          <Suspense fallback={null}>
            <LazyRewriteReview />
          </Suspense>
        </FeatureErrorBoundary>
      )}
      {revisionHistoryOpen && (
        <FeatureErrorBoundary
          key={revisionLoadAttempt}
          featureName="版本历史"
          fallbackClassName="project-state project-error"
          onError={() => {
            useStudio.getState().pushToast('danger', '版本历史加载失败，可重试或关闭');
          }}
          onRetry={retryRevisionHistory}
          onClose={closeRevisionHistoryAfterError}
        >
          <Suspense fallback={null}>
            <LazyRevisionHistory />
          </Suspense>
        </FeatureErrorBoundary>
      )}
    </div>
  );
}
