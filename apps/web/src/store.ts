/**
 * App state (zustand). One store, small slices: project, document, sidebar,
 * thread. Streaming deltas from the WS land in `streamingText`.
 */

import { create } from 'zustand';
import type {
  AgentAvailability,
  AgentId,
  AgentModelOption,
  Anchor,
  CanonEvidence,
  CanonSectionRef,
  GitStatus,
  ChapterTree,
  ContextManifest,
  DocumentMeta,
  Message,
  Project,
  ProjectListItem,
  RewriteResponse,
  SidebarPayload,
  Thread,
  TrashEntry,
} from '@writing-studio/contract';
import { api, ApiError } from './api.js';
import {
  initialPaneState,
  LatestRequestGate,
  pickPreferredAgent,
  saveDirtyEditorBeforeThreadAction,
  togglePane,
  transitionViewport,
} from './store-logic.js';
import {
  buildBeatPrompt,
  buildBeatRewritePrompt,
  composeBeatTexts,
  parseOutlineBeats,
} from './lib/generation-beats.js';

export interface SelectionInfo {
  start: number;
  end: number;
  prefix: string;
  exact: string;
  suffix: string;
}

export interface RewriteReview {
  messageId: string;
  projectId: string;
  docId: string;
  threadId: string;
  preferredStart: number;
  prefix: string;
  originalText: string;
  suffix: string;
  rewrittenText: string;
  notes: string | null;
  rawFallback: boolean;
  /**
   * True for a document-level thread (anchor=null): the candidate replaces the
   * whole document, so apply skips fuzzy range location entirely.
   */
  wholeDoc: boolean;
  /** Immutable saved document identity supplied to the whole-document run. */
  wholeDocBaseSha: string | null;
  /** Canon candidates are saved immediately through the guarded PUT path. */
  canon: boolean;
}

export interface WholeDocBaseline {
  projectId: string;
  docId: string;
  baseSha: string;
  content: string;
}

/** Right-pane tab: canon reference material vs AI threads. */
export type RightPaneTab = 'canon' | 'ai';

/** Top-level workspace mode: normal editing vs chapter generation. */
export type AppMode = 'writing' | 'generate';

export type BeatPhase = 'writing' | 'awaiting-confirm' | 'done';

export interface RevisionRestoreRequest {
  projectId: string;
  docId: string;
  revisionId: string;
  content: string;
}

/** Theme preference. "auto" follows the OS via prefers-color-scheme. */
export type ThemeMode = 'auto' | 'light' | 'dark';

export type ToastKind = 'success' | 'warning' | 'danger' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

export interface ConfirmDialog {
  title: string;
  message: string;
  confirmText: string;
}

let toastSeq = 0;
let projectRequestSeq = 0;
let documentRequestSeq = 0;
let threadRequestSeq = 0;
let confirmResolver: ((confirmed: boolean) => void) | null = null;
// Orders project-level fetches shared by selectProject / refresh / recovery.
// A late payload is discarded only after a newer successful payload was
// applied; a failed or abandoned request cannot erase the last usable result.
const treeRequestGate = new LatestRequestGate();
const draftsRequestGate = new LatestRequestGate();
const trashRequestGate = new LatestRequestGate();
const gitRequestGate = new LatestRequestGate();
const sidebarRequestGate = new LatestRequestGate();

const THEME_KEY = 'ws-theme';

function readTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}

const MODEL_PREFS_KEY = 'ws-model-prefs';
/** Matches the normal full-document context window; the server remains authoritative. */
export const WHOLE_DOC_FRIENDLY_CHAR_LIMIT = 16_000;

/**
 * Return the catalog's sole declared default. A malformed catalog with zero
 * or multiple defaults is treated as having no implicit selection; the server
 * validator normally prevents the latter, but keeping this guard makes the
 * web transport fail closed if an old/runtime payload slips through.
 */
export function findCatalogDefault(models: AgentModelOption[] | undefined): AgentModelOption | undefined {
  if (models === undefined) return undefined;
  const defaults = models.filter((model) => model.isDefault === true);
  return defaults.length === 1 ? defaults[0] : undefined;
}

export function formatRunError(
  code: string | null | undefined,
  message?: string | null,
  detail?: string | null,
): string {
  const fallbackByCode: Record<string, string> = {
    process_error: 'agent CLI exited unexpectedly',
    network_error: 'agent CLI network request failed',
    timeout: 'agent CLI timed out',
    cancelled: 'agent run was cancelled',
  };
  const base = code === 'cli_not_authenticated'
    ? '该 CLI 未登录或凭据过期，请在系统终端重新登录后重试'
    : message?.trim() || (code ? fallbackByCode[code] ?? code : '未知错误');
  const diagnostic = detail?.trim();
  return diagnostic ? `${base}\n${diagnostic}` : base;
}

function readModelPrefs(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MODEL_PREFS_KEY) ?? '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

/** Live tool call surfaced from the agent event stream. */
export interface RunToolActivity {
  tool: string;
  status: string;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Reflect the theme preference onto <html data-theme> and persist it. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(THEME_KEY, mode);
}

/** Pane width bounds (px). */
export const LEFT_MIN = 160;
export const LEFT_MAX = 320;
export const RIGHT_MIN = 240;
export const RIGHT_MAX = 480;

/** Editor font-size bounds (px). */
export const EDITOR_FS_MIN = 15;
export const EDITOR_FS_MAX = 21;
const EDITOR_FS_DEFAULT = 17;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function readNumber(key: string, fallback: number, lo: number, hi: number): number {
  const raw = localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function readBool(key: string): boolean {
  return localStorage.getItem(key) === '1';
}

/** Narrow viewport below which side panes default to collapsed (overlay drawers). */
export const NARROW_VIEWPORT = 720;

/** Persisted desktop preference. Narrow drawers always start closed. */
function readDesktopCollapsed(key: string): boolean {
  const stored = localStorage.getItem(key);
  if (stored === '1') return true;
  if (stored === '0') return false;
  return false;
}

const initialLayout = initialPaneState(window.innerWidth <= NARROW_VIEWPORT, {
  leftCollapsed: readDesktopCollapsed('ws-left-collapsed'),
  rightCollapsed: readDesktopCollapsed('ws-right-collapsed'),
});

interface StudioState {
  /** Display-layer preference (does not touch data flow). */
  theme: ThemeMode;
  setTheme(mode: ThemeMode): void;
  cycleTheme(): void;

  /** Layout display state (persisted under ws-* keys). */
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftWidth: number;
  rightWidth: number;
  focusMode: boolean;
  /** True while the viewport is narrow enough that side panes act as overlay drawers. */
  isNarrow: boolean;
  toggleLeft(): void;
  toggleRight(): void;
  setLeftWidth(px: number): void;
  setRightWidth(px: number): void;
  toggleFocus(): void;
  /** React to crossing the narrow breakpoint (driven by a matchMedia listener). */
  syncViewport(narrow: boolean): void;
  /** Dismiss any open overlay drawer (mobile backdrop / Esc). */
  closeDrawers(): void;

  /** Transient toast queue (display-only). */
  toasts: Toast[];
  pushToast(kind: ToastKind, text: string): void;
  dismissToast(id: number): void;
  confirmDialog: ConfirmDialog | null;
  requestConfirm(dialog: ConfirmDialog): Promise<boolean>;
  resolveConfirm(confirmed: boolean): void;

  /** Editor display preferences (persisted). */
  editorFontSize: number;
  typewriterMode: boolean;
  setEditorFontSize(px: number): void;
  toggleTypewriter(): void;

  projectItems: ProjectListItem[];
  projects: Project[];
  projectsLoaded: boolean;
  projectDataLoading: boolean;
  projectsError: string | null;
  activeProjectId: string | null;
  tree: ChapterTree | null;
  drafts: DocumentMeta[];
  draftsLoading: boolean;
  draftsError: string | null;
  trash: TrashEntry[];
  trashLoading: boolean;
  trashError: string | null;
  trashRestoringDocId: string | null;
  git: GitStatus | null;
  sidebar: SidebarPayload[];
  activeSidebarId: string | null;

  doc: DocumentMeta | null;
  docContent: string;
  /** Increments on every explicit document load, even when content is identical. */
  editorLoadVersion: number;
  /** Latest CodeMirror buffer, including unsaved edits. */
  editorContent: string;
  /** sha the current editor buffer is based on (optimistic lock token). */
  baseSha: string;
  editorDirty: boolean;
  /** One-shot heading reveal requested by a graph evidence link. */
  pendingRevealHeading: string | null;
  /** One-shot exact text quote reveal requested by a conflict finding. */
  pendingRevealQuote: string | null;

  selection: SelectionInfo | null;

  threads: Thread[];
  /** Project-level roleplay threads (kind=chat), loaded lazily by the AI tab. */
  chatThreads: Thread[];
  activeThread: Thread | null;
  messages: Message[];
  streamingText: string;
  running: boolean;
  conflictCheckStarting: boolean;
  activeRunId: string | null;
  runGeneration: number;
  agents: AgentAvailability[];
  agentsLoaded: boolean;
  /** Tool activity of the current run; cleared when a run starts or ends. */
  runTools: RunToolActivity[];
  /** Merged usage of the latest run; kept after completion until the next run. */
  runUsage: RunUsage | null;
  /** Sources actually injected for the latest accepted run; retained after it ends. */
  runManifest: ContextManifest | null;
  /** Last failure for the active thread, shown inline until the next run/thread. */
  runError: string | null;
  /** Per-agent preferred model id. Sent only when the agent advertises models. */
  modelPrefs: Record<string, string>;
  /** Bumped to ask the thread composer to grab keyboard focus. */
  composerFocusNonce: number;
  /** Which right-pane tab is visible. Thread-creating actions switch to 'ai'. */
  rightPaneTab: RightPaneTab;
  /** Top-level mode. 'generate' swaps the center area for the GenerateWorkspace. */
  appMode: AppMode;
  /** Target document of the current generation session (null = setup form). */
  generateDoc: DocumentMeta | null;
  /** Parsed chapter-outline beats. Empty until the first generation request. */
  beats: string[];
  /** Current zero-based beat cursor. */
  beatIndex: number;
  /** Accepted candidate for each completed beat. */
  beatTexts: string[];
  beatPhase: BeatPhase;
  /** Distinguishes an in-flight rewrite from a first pass in progress labels. */
  beatRewriting: boolean;
  pendingStructured: RewriteResponse | null;
  rewriteReview: RewriteReview | null;
  rewriteApplyRequest: RewriteReview | null;
  /** Creation baseline for each explicit “对整章提意见” thread. */
  wholeDocThreadBaselines: Record<string, WholeDocBaseline>;
  /** Exact run baseline, attached to its durable assistant response. */
  wholeDocMessageBaselines: Record<string, WholeDocBaseline>;
  pendingWholeDocRunBaseline: (WholeDocBaseline & { threadId: string; generation: number }) | null;
  revisionHistoryOpen: boolean;
  revisionRestoreRequest: RevisionRestoreRequest | null;
  lastAppliedRewriteThreadId: string | null;

  loadProjects(): Promise<void>;
  loadAgents(): Promise<void>;
  selectProject(pid: string): Promise<void>;
  /** Resolves false only when a current (non-superseded) failure was surfaced. */
  refreshTree(): Promise<boolean>;
  /** Resolves false only when a current (non-superseded) failure was surfaced. */
  refreshSidebar(): Promise<boolean>;
  refreshDrafts(): Promise<void>;
  listTrash(): Promise<void>;
  restoreDraft(trashedDocId: string): Promise<boolean>;
  deleteDraft(docId: string): Promise<boolean>;
  renameChapterTitle(chapter: DocumentMeta, title: string): Promise<boolean>;
  recoverConnection(): Promise<void>;
  openDocument(docId: string, heading?: string | null): Promise<boolean>;
  /** Open a document and only then perform a document-scoped follow-up action. */
  openDocumentThen(docId: string, then: 'revisions' | 'wholeDocThread'): Promise<boolean>;
  clearRevealHeading(): void;
  revealTextQuote(quote: string): void;
  clearRevealQuote(): void;
  markDirty(content: string): void;
  saveDocument(content: string): Promise<'saved' | 'saved-with-new-edits' | 'conflict'>;
  setSelection(sel: SelectionInfo | null): void;

  setRightPaneTab(tab: RightPaneTab): void;
  setAppMode(mode: AppMode): void;
  loadChatThreads(): Promise<void>;
  /** Start (or resume creating) a roleplay chat with a writer-visible character. */
  startCharacterChat(characterName: string, memoryCutoffChapter?: number): Promise<void>;
  /** Create the target document + its generation thread, then stay in generate mode. */
  startChapterGeneration(input: { title: string; target: 'chapter' | 'draft' }): Promise<void>;
  /** Parse an outline and start its first beat (or the legacy single turn). */
  startGenerationBeats(outline: string): Promise<boolean>;
  /** Confirm the current beat and start the next one. */
  continueGenerationBeat(): Promise<boolean>;
  /** Restart a stopped/failed first pass for the current beat. */
  retryGenerationBeat(): Promise<boolean>;
  /** Regenerate the current beat with author feedback. */
  rewriteGenerationBeat(feedback: string): Promise<boolean>;
  /** Write an accepted candidate into the target document and open it for editing. */
  adoptGeneratedChapter(messageId?: string): Promise<void>;
  openThread(tid: string): Promise<void>;
  /** Rename a thread optimistically across every local projection. */
  renameThread(tid: string, title: string): Promise<boolean>;
  createThreadFromSelection(kind: 'ask' | 'rewrite'): Promise<void>;
  /** Document-level feedback thread (rewrite with no anchor): AI 整章修改稿. */
  createWholeDocRewriteThread(): Promise<void>;
  runConflictCheck(): Promise<void>;
  openCanonSource(docId: string, heading: string): void;
  startCanonRewrite(
    docId: string,
    section: CanonSectionRef,
    evidence?: CanonEvidence,
  ): Promise<void>;
  startCanonRewriteFromFinding(
    docId: string,
    heading: string,
    textQuote: string,
  ): Promise<void>;
  setThreadAgent(agentId: AgentId): Promise<void>;
  setAgentModel(agentId: AgentId, model: string | null): void;
  sendMessage(content: string, wantRewrite: boolean): Promise<boolean>;
  stopRun(): Promise<void>;
  openRewriteReview(messageId: string): void;
  setRewriteReviewText(text: string): void;
  closeRewriteReview(): void;
  requestRewriteApply(rewrittenText?: string): void;
  clearRewriteApplyRequest(): void;
  setRevisionHistoryOpen(open: boolean): void;
  requestRevisionRestore(request: RevisionRestoreRequest): void;
  clearRevisionRestoreRequest(): void;
  setAppliedRewriteSource(threadId: string | null): void;
  applyAgentEvent(
    runId: string,
    threadId: string,
    event: { type: string; [k: string]: unknown },
    manifest?: ContextManifest,
  ): void;
}

function settleGenerationBeat(
  state: StudioState,
  assistant: Message | undefined,
  completed: boolean,
  previousAssistantId: string | undefined,
): Partial<StudioState> {
  if (state.beats.length === 0 || state.beatPhase !== 'writing') return {};
  if (!completed) return { beatPhase: 'writing', beatRewriting: false };
  if (!assistant || assistant.id === previousAssistantId) {
    return { beatPhase: 'writing', beatRewriting: false };
  }
  const text = assistant?.structured && 'rewritten_text' in assistant.structured
    ? assistant.structured.rewritten_text
    : assistant?.content ?? '';
  if (!text.trim()) return { beatPhase: 'writing', beatRewriting: false };
  const beatTexts = [...state.beatTexts];
  beatTexts[state.beatIndex] = text;
  return {
    beatTexts,
    beatPhase: state.beatIndex === state.beats.length - 1 ? 'done' : 'awaiting-confirm',
    beatRewriting: false,
  };
}

export const useStudio = create<StudioState>((set, get) => ({
  theme: readTheme(),
  setTheme(mode) {
    applyTheme(mode);
    set({ theme: mode });
  },
  cycleTheme() {
    const order: ThemeMode[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(get().theme) + 1) % order.length] ?? 'auto';
    applyTheme(next);
    set({ theme: next });
  },

  leftCollapsed: initialLayout.leftCollapsed,
  rightCollapsed: initialLayout.rightCollapsed,
  leftWidth: readNumber('ws-left-width', 220, LEFT_MIN, LEFT_MAX),
  rightWidth: readNumber('ws-right-width', 340, RIGHT_MIN, RIGHT_MAX),
  focusMode: false,
  isNarrow: initialLayout.isNarrow,
  toggleLeft() {
    if (get().isNarrow) {
      // Overlay drawer: open exclusively (close the other so a 300px + 330px
      // pair can't cover the editor) and don't persist the transient state.
      set(togglePane(get(), 'left'));
      return;
    }
    const next = togglePane(get(), 'left').leftCollapsed;
    localStorage.setItem('ws-left-collapsed', next ? '1' : '0');
    set({ leftCollapsed: next });
  },
  toggleRight() {
    if (get().isNarrow) {
      set(togglePane(get(), 'right'));
      return;
    }
    const next = togglePane(get(), 'right').rightCollapsed;
    localStorage.setItem('ws-right-collapsed', next ? '1' : '0');
    set({ rightCollapsed: next });
  },
  setLeftWidth(px) {
    const w = clamp(px, LEFT_MIN, LEFT_MAX);
    localStorage.setItem('ws-left-width', String(w));
    set({ leftWidth: w });
  },
  setRightWidth(px) {
    const w = clamp(px, RIGHT_MIN, RIGHT_MAX);
    localStorage.setItem('ws-right-width', String(w));
    set({ rightWidth: w });
  },
  toggleFocus() {
    set({ focusMode: !get().focusMode });
  },
  syncViewport(narrow) {
    const next = transitionViewport(get(), narrow, {
      leftCollapsed: readDesktopCollapsed('ws-left-collapsed'),
      rightCollapsed: readDesktopCollapsed('ws-right-collapsed'),
    });
    if (next) set(next);
  },
  closeDrawers() {
    set({ leftCollapsed: true, rightCollapsed: true });
  },

  toasts: [],
  pushToast(kind, text) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  confirmDialog: null,
  requestConfirm(dialog) {
    confirmResolver?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
      set({ confirmDialog: dialog });
    });
  },
  resolveConfirm(confirmed) {
    const resolve = confirmResolver;
    confirmResolver = null;
    set({ confirmDialog: null });
    resolve?.(confirmed);
  },

  editorFontSize: readNumber('ws-editor-fontsize', EDITOR_FS_DEFAULT, EDITOR_FS_MIN, EDITOR_FS_MAX),
  typewriterMode: readBool('ws-typewriter'),
  setEditorFontSize(px) {
    const size = clamp(px, EDITOR_FS_MIN, EDITOR_FS_MAX);
    localStorage.setItem('ws-editor-fontsize', String(size));
    set({ editorFontSize: size });
  },
  toggleTypewriter() {
    const next = !get().typewriterMode;
    localStorage.setItem('ws-typewriter', next ? '1' : '0');
    set({ typewriterMode: next });
  },

  projectItems: [],
  projects: [],
  projectsLoaded: false,
  projectDataLoading: false,
  projectsError: null,
  activeProjectId: null,
  tree: null,
  drafts: [],
  draftsLoading: false,
  draftsError: null,
  trash: [],
  trashLoading: false,
  trashError: null,
  trashRestoringDocId: null,
  git: null,
  sidebar: [],
  activeSidebarId: null,
  doc: null,
  docContent: '',
  editorLoadVersion: 0,
  editorContent: '',
  baseSha: '',
  editorDirty: false,
  pendingRevealHeading: null,
  pendingRevealQuote: null,
  selection: null,
  threads: [],
  chatThreads: [],
  activeThread: null,
  messages: [],
  streamingText: '',
  running: false,
  conflictCheckStarting: false,
  activeRunId: null,
  runGeneration: 0,
  agents: [],
  agentsLoaded: false,
  runTools: [],
  runUsage: null,
  runManifest: null,
  runError: null,
  modelPrefs: readModelPrefs(),
  composerFocusNonce: 0,
  rightPaneTab: 'canon',
  appMode: 'writing',
  generateDoc: null,
  beats: [],
  beatIndex: 0,
  beatTexts: [],
  beatPhase: 'writing',
  beatRewriting: false,
  pendingStructured: null,
  rewriteReview: null,
  rewriteApplyRequest: null,
  wholeDocThreadBaselines: {},
  wholeDocMessageBaselines: {},
  pendingWholeDocRunBaseline: null,
  revisionHistoryOpen: false,
  revisionRestoreRequest: null,
  lastAppliedRewriteThreadId: null,

  async loadProjects() {
    set({ projectsLoaded: false, projectDataLoading: false, projectsError: null });
    try {
      const items = await api.listProjects();
      const projects = items.flatMap((item) => (item.status === 'ready' ? [item.project] : []));
      set({ projectItems: items, projects, projectsLoaded: true });
      const activeStillReady = projects.some((project) => project.config.id === get().activeProjectId);
      const first = projects[0];
      if (first && !activeStillReady) await get().selectProject(first.config.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        projectItems: [],
        projects: [],
        projectsLoaded: true,
        projectDataLoading: false,
        projectsError: message,
      });
      get().pushToast('danger', `项目列表加载失败：${message}`);
    }
  },

  async loadAgents() {
    try {
      set({ agents: await api.listAgents(), agentsLoaded: true });
    } catch (err) {
      set({ agents: [], agentsLoaded: true });
      get().pushToast('warning', `Agent 可用性检查失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async selectProject(pid) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再切换项目');
      return;
    }
    if (get().editorDirty && !await get().requestConfirm({
      title: '放弃未保存修改？',
      message: '当前文档有未保存修改。确定放弃这些修改并切换项目吗？',
      confirmText: '放弃并切换',
    })) return;
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再切换项目');
      return;
    }
    const requestSeq = ++projectRequestSeq;
    ++documentRequestSeq;
    ++threadRequestSeq;
    // Clear prior-project state up front so a partial load never shows stale data.
    set({
      activeProjectId: pid,
      projectDataLoading: true,
      doc: null,
      docContent: '',
      editorContent: '',
      threads: [],
      chatThreads: [],
      activeThread: null,
      tree: null,
      drafts: [],
      draftsLoading: true,
      draftsError: null,
      trash: [],
      trashLoading: false,
      trashError: null,
      trashRestoringDocId: null,
      git: null,
      sidebar: [],
      activeSidebarId: null,
      projectsError: null,
      running: false,
      activeRunId: null,
      runTools: [],
      runUsage: null,
      runManifest: null,
      runError: null,
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
      wholeDocThreadBaselines: {},
      wholeDocMessageBaselines: {},
      pendingWholeDocRunBaseline: null,
      revisionHistoryOpen: false,
      revisionRestoreRequest: null,
      lastAppliedRewriteThreadId: null,
      pendingRevealHeading: null,
      pendingRevealQuote: null,
      conflictCheckStarting: false,
      generateDoc: null,
      beats: [],
      beatIndex: 0,
      beatTexts: [],
      beatPhase: 'writing',
      beatRewriting: false,
    });
    const treeSeq = treeRequestGate.begin();
    const draftsSeq = draftsRequestGate.begin();
    const gitSeq = gitRequestGate.begin();
    const sidebarSeq = sidebarRequestGate.begin();
    const [treeR, draftsR, gitR, sidebarR] = await Promise.allSettled([
      api.getTree(pid),
      api.listDrafts(pid),
      api.getGitStatus(pid),
      api.getSidebar(pid, 'planner'),
    ]);
    // Ignore results if the user switched projects again mid-flight.
    if (requestSeq !== projectRequestSeq || get().activeProjectId !== pid) return;
    const patch: Partial<StudioState> = {};
    patch.projectDataLoading = false;
    patch.draftsLoading = false;
    if (treeR.status === 'fulfilled' && treeRequestGate.accept(treeSeq)) {
      patch.tree = treeR.value;
    } else {
      if (treeR.status === 'rejected') {
        patch.projectsError = treeR.reason instanceof Error ? treeR.reason.message : String(treeR.reason);
      }
    }
    if (draftsR.status === 'fulfilled' && draftsRequestGate.accept(draftsSeq)) {
      patch.drafts = draftsR.value;
      patch.draftsError = null;
    } else if (draftsR.status === 'rejected') {
      patch.draftsError = draftsR.reason instanceof Error
        ? draftsR.reason.message
        : String(draftsR.reason);
    }
    if (gitR.status === 'fulfilled' && gitRequestGate.accept(gitSeq)) patch.git = gitR.value;
    // A refreshSidebar fired mid-flight would bump the seq; skip the stale write.
    if (sidebarR.status === 'fulfilled' && sidebarRequestGate.accept(sidebarSeq)) {
      patch.sidebar = sidebarR.value;
      patch.activeSidebarId = sidebarR.value[0]?.sourceId ?? null;
    }
    set(patch);
    const failed = [treeR, draftsR, gitR, sidebarR].filter((r) => r.status === 'rejected').length;
    if (failed > 0) get().pushToast('danger', `部分项目数据加载失败（${failed}/4），可稍后重试`);
  },

  async refreshTree() {
    const pid = get().activeProjectId;
    if (!pid) return true;
    const treeSeq = treeRequestGate.begin();
    try {
      const tree = await api.getTree(pid);
      if (get().activeProjectId !== pid || !treeRequestGate.accept(treeSeq)) return true;
      set({ tree });
      return true;
    } catch (error) {
      // A failure that newer applied data already superseded is noise.
      if (get().activeProjectId !== pid || treeRequestGate.isSuperseded(treeSeq)) return true;
      get().pushToast(
        'danger',
        `章节树刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  },

  async refreshSidebar() {
    const pid = get().activeProjectId;
    if (!pid) return true;
    const sidebarSeq = sidebarRequestGate.begin();
    try {
      const sidebar = await api.getSidebar(pid, 'planner');
      if (get().activeProjectId !== pid || !sidebarRequestGate.accept(sidebarSeq)) return true;
      set({ sidebar });
      return true;
    } catch (error) {
      // A failure that newer applied data already superseded is noise.
      if (get().activeProjectId !== pid || sidebarRequestGate.isSuperseded(sidebarSeq)) return true;
      get().pushToast(
        'danger',
        `侧栏刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  },

  async refreshDrafts() {
    const pid = get().activeProjectId;
    if (!pid) return;
    const draftsSeq = draftsRequestGate.begin();
    set({ draftsLoading: true, draftsError: null });
    try {
      const drafts = await api.listDrafts(pid);
      if (get().activeProjectId !== pid || !draftsRequestGate.accept(draftsSeq)) return;
      set({ drafts, draftsLoading: false });
    } catch (error) {
      if (get().activeProjectId !== pid) return;
      set({
        draftsLoading: false,
        draftsError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async listTrash() {
    const pid = get().activeProjectId;
    if (!pid) return;
    const trashSeq = trashRequestGate.begin();
    set({ trashLoading: true, trashError: null });
    try {
      const trash = await api.listTrash(pid);
      if (get().activeProjectId !== pid || !trashRequestGate.accept(trashSeq)) return;
      set({ trash, trashLoading: false });
    } catch (error) {
      if (get().activeProjectId !== pid) return;
      set({
        trashLoading: false,
        trashError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  async restoreDraft(trashedDocId) {
    const pid = get().activeProjectId;
    if (!pid) return false;
    if (get().trashRestoringDocId !== null) return false;
    set({ trashRestoringDocId: trashedDocId });
    try {
      await api.restoreDraft(pid, trashedDocId);
    } catch (error) {
      if (get().activeProjectId === pid) {
        set({ trashRestoringDocId: null });
        if (error instanceof ApiError && error.code === 'CONFLICT') {
          get().pushToast('warning', '草稿区已有同名文件，请先处理现有文件再恢复');
        } else {
          get().pushToast('danger', `恢复草稿失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return false;
    }

    const draftsSeq = draftsRequestGate.begin();
    const trashSeq = trashRequestGate.begin();
    const [draftsResult, trashResult] = await Promise.allSettled([
      api.listDrafts(pid),
      api.listTrash(pid),
    ]);
    if (get().activeProjectId !== pid) return true;
    const refreshPatch: Partial<StudioState> = { trashRestoringDocId: null };
    if (draftsResult.status === 'fulfilled' && draftsRequestGate.accept(draftsSeq)) {
      Object.assign(refreshPatch, {
        drafts: draftsResult.value,
        draftsLoading: false,
        draftsError: null,
      });
    } else if (draftsResult.status === 'rejected') {
      Object.assign(refreshPatch, {
        draftsLoading: false,
        draftsError: draftsResult.reason instanceof Error
          ? draftsResult.reason.message
          : String(draftsResult.reason),
      });
    }
    if (trashResult.status === 'fulfilled' && trashRequestGate.accept(trashSeq)) {
      Object.assign(refreshPatch, {
        trash: trashResult.value,
        trashLoading: false,
        trashError: null,
      });
    } else if (trashResult.status === 'rejected') {
      Object.assign(refreshPatch, {
        trashLoading: false,
        trashError: trashResult.reason instanceof Error
          ? trashResult.reason.message
          : String(trashResult.reason),
      });
    }
    set(refreshPatch);
    const refreshFailed = draftsResult.status === 'rejected' || trashResult.status === 'rejected';
    get().pushToast(
      refreshFailed ? 'warning' : 'success',
      refreshFailed ? '草稿已恢复，但列表刷新不完整；请稍后重试' : '草稿已恢复',
    );
    return true;
  },

  async deleteDraft(docId) {
    const pid = get().activeProjectId;
    if (!pid) return false;
    const before = get();
    const targetActive = before.doc?.docId === docId
      || before.generateDoc?.docId === docId
      || before.activeThread?.docId === docId;
    if (before.running && targetActive) {
      get().pushToast('warning', '请先停止该草稿的 AI 运行再删除');
      return false;
    }
    try {
      await api.deleteDraft(pid, docId);
    } catch (error) {
      get().pushToast('danger', `删除草稿失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    const draftsSeq = draftsRequestGate.begin();
    const treeSeq = treeRequestGate.begin();
    const [draftsResult, treeResult] = await Promise.allSettled([
      api.listDrafts(pid),
      api.getTree(pid),
    ]);
    if (get().activeProjectId !== pid) return true;

    const current = get();
    const clearEditor = current.doc?.docId === docId;
    const clearGeneration = current.generateDoc?.docId === docId;
    const clearThread = current.activeThread?.docId === docId || clearEditor || clearGeneration;
    if (clearEditor) documentRequestSeq += 1;
    if (clearEditor || clearGeneration || clearThread) threadRequestSeq += 1;
    const draftsPatch: Partial<StudioState> = {};
    if (draftsResult.status === 'fulfilled' && draftsRequestGate.accept(draftsSeq)) {
      Object.assign(draftsPatch, {
        drafts: draftsResult.value,
        draftsLoading: false,
        draftsError: null,
      });
    } else if (draftsResult.status === 'rejected') {
      Object.assign(draftsPatch, {
        draftsLoading: false,
        draftsError: draftsResult.reason instanceof Error
          ? draftsResult.reason.message
          : String(draftsResult.reason),
      });
    }
    set((state) => ({
      ...draftsPatch,
      ...(treeResult.status === 'fulfilled' && treeRequestGate.accept(treeSeq)
        ? { tree: treeResult.value }
        : {}),
      ...(clearEditor
        ? {
            doc: null,
            docContent: '',
            editorLoadVersion: state.editorLoadVersion + 1,
            editorContent: '',
            baseSha: '',
            editorDirty: false,
            selection: null,
            pendingRevealHeading: null,
            pendingRevealQuote: null,
            revisionHistoryOpen: false,
            revisionRestoreRequest: null,
            lastAppliedRewriteThreadId: null,
          }
        : {}),
      ...(clearGeneration
        ? {
            appMode: 'writing' as const,
            generateDoc: null,
            beats: [],
            beatIndex: 0,
            beatTexts: [],
            beatPhase: 'writing' as const,
            beatRewriting: false,
          }
        : {}),
      ...(clearThread
        ? {
            threads: clearEditor ? [] : state.threads.filter((thread) => thread.docId !== docId),
            activeThread: null,
            messages: [],
            streamingText: '',
            running: false,
            activeRunId: null,
            runTools: [],
            runUsage: null,
            runManifest: null,
            runError: null,
            pendingStructured: null,
            rewriteReview: null,
            rewriteApplyRequest: null,
            wholeDocThreadBaselines: {},
            wholeDocMessageBaselines: {},
            pendingWholeDocRunBaseline: null,
          }
        : clearEditor ? { threads: [] } : {}),
    }));
    get().pushToast(
      'success',
      targetActive ? '草稿已移至 .trash 文件夹，并已关闭当前工作区' : '草稿已移至 .trash 文件夹',
    );
    if (draftsResult.status === 'rejected' || treeResult.status === 'rejected') {
      get().pushToast('warning', '草稿已删除，但列表刷新不完整；请稍后重试');
    }
    return true;
  },

  async renameChapterTitle(chapter, title) {
    const initial = get();
    const pid = initial.activeProjectId;
    if (!pid || initial.running) return false;
    const activeTarget = initial.doc?.docId === chapter.docId;
    if (activeTarget && initial.editorDirty) return false;
    const expectedLoadVersion = initial.editorLoadVersion;
    const expectedEditorContent = initial.editorContent;
    const baseSha256 = activeTarget && initial.doc ? initial.doc.sha256 : chapter.sha256;
    try {
      const response = await api.renameChapterTitle(pid, chapter.docId, title, baseSha256);
      const treeSeq = treeRequestGate.begin();
      const [treeResult, documentResult] = await Promise.allSettled([
        api.getTree(pid),
        // Always fetched: the renamed content also feeds the revision snapshot.
        api.getDocument(pid, chapter.docId),
      ]);
      if (get().activeProjectId !== pid) return true;
      const patch: Partial<StudioState> = {};
      if (treeResult.status === 'fulfilled' && treeRequestGate.accept(treeSeq)) {
        patch.tree = treeResult.value;
      }
      if (
        documentResult.status === 'fulfilled'
        && documentResult.value
        && get().doc?.docId === chapter.docId
        && !get().editorDirty
        && get().editorLoadVersion === expectedLoadVersion
        && get().editorContent === expectedEditorContent
      ) {
        patch.doc = documentResult.value.doc;
        patch.docContent = documentResult.value.content;
        patch.editorLoadVersion = expectedLoadVersion + 1;
        patch.editorContent = documentResult.value.content;
        patch.baseSha = documentResult.value.doc.sha256;
        patch.editorDirty = false;
      } else if (activeTarget && get().doc?.docId === chapter.docId) {
        // Keep the old buffer/baseSha so a later save fails closed instead of
        // overwriting the renamed title if the readback could not be applied.
        patch.doc = response.doc;
      }
      set(patch);
      if (documentResult.status === 'fulfilled' && documentResult.value) {
        // Renames are vault writes and must leave a rollback point, same as
        // saveDocument. Best-effort: a failed snapshot warns, never blocks.
        await api.createRevision(pid, chapter.docId, {
          kind: 'user_edit',
          content: documentResult.value.content,
          label: '重命名章节',
        }).catch((err: unknown) => {
          get().pushToast(
            'warning',
            `章节标题已更新，但版本快照失败：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      const refreshFailed = treeResult.status === 'rejected'
        || documentResult.status === 'rejected';
      get().pushToast(
        refreshFailed ? 'warning' : 'success',
        refreshFailed ? '章节标题已更新，但界面刷新失败，请重新打开项目' : '章节标题已更新',
      );
      return true;
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as Error & { code: string }).code
        : null;
      get().pushToast(
        'danger',
        code === 'STALE_WRITE'
          ? '重命名失败：章节已在别处修改，请刷新后重试'
          : `重命名失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  },

  async recoverConnection() {
    const { activeProjectId: pid, doc, activeThread, activeRunId } = get();
    if (!pid) return;
    const expectedDocumentSeq = documentRequestSeq;
    const expectedThreadSeq = threadRequestSeq;
    const expectedDocId = doc?.docId ?? null;
    const expectedThreadId = activeThread?.id ?? null;
    const expectedRunGeneration = get().runGeneration;
    const expectedActiveRunId = activeRunId;
    const treeSeq = treeRequestGate.begin();
    const gitSeq = gitRequestGate.begin();
    const sidebarSeq = sidebarRequestGate.begin();
    const [treeR, gitR, sidebarR, threadsR, threadR, runR] = await Promise.allSettled([
      api.getTree(pid),
      api.getGitStatus(pid),
      api.getSidebar(pid, 'planner'),
      doc ? api.listThreads(pid, doc.docId) : Promise.resolve(null),
      activeThread ? api.getThread(activeThread.id) : Promise.resolve(null),
      activeRunId ? api.getRun(activeRunId) : Promise.resolve(null),
    ]);
    if (get().activeProjectId !== pid) return;

    // Project-level recovery is independent of the currently open document,
    // thread, or run. Apply it even if one of those finer-grained contexts
    // changed while the request was in flight.
    const projectPatch: Partial<StudioState> = {};
    if (treeR.status === 'fulfilled' && treeRequestGate.accept(treeSeq)) {
      projectPatch.tree = treeR.value;
    }
    if (gitR.status === 'fulfilled' && gitRequestGate.accept(gitSeq)) {
      projectPatch.git = gitR.value;
    }
    if (sidebarR.status === 'fulfilled' && sidebarRequestGate.accept(sidebarSeq)) {
      projectPatch.sidebar = sidebarR.value;
      const currentId = get().activeSidebarId;
      projectPatch.activeSidebarId = sidebarR.value.some((source) => source.sourceId === currentId)
        ? currentId
        : sidebarR.value[0]?.sourceId ?? null;
    }
    set(projectPatch);

    if (
      documentRequestSeq !== expectedDocumentSeq
      || threadRequestSeq !== expectedThreadSeq
      || (get().doc?.docId ?? null) !== expectedDocId
      || (get().activeThread?.id ?? null) !== expectedThreadId
      || get().runGeneration !== expectedRunGeneration
      || get().activeRunId !== expectedActiveRunId
    ) return;

    const patch: Partial<StudioState> = {};
    if (threadsR.status === 'fulfilled' && threadsR.value) patch.threads = threadsR.value;
    if (threadR.status === 'fulfilled' && threadR.value) {
      patch.activeThread = threadR.value.thread;
      patch.messages = threadR.value.messages;
      patch.streamingText = '';
    }
    if (runR.status === 'fulfilled' && runR.value) {
      const terminal = runR.value.status !== 'running';
      patch.running = !terminal;
      if (terminal) {
        patch.activeRunId = null;
        patch.runError = runR.value.status === 'failed'
          ? formatRunError(runR.value.errorCode, null, runR.value.errorDetail)
          : null;
        const assistant = threadR.status === 'fulfilled' && threadR.value
          ? [...threadR.value.messages].reverse().find((message) => message.role === 'assistant')
          : undefined;
        Object.assign(
          patch,
          settleGenerationBeat(
            get(),
            assistant,
            runR.value.status === 'completed',
            [...get().messages].reverse().find((message) => message.role === 'assistant')?.id,
          ),
        );
      }
    } else if (activeRunId && runR.status === 'rejected') {
      patch.running = false;
      patch.activeRunId = null;
      get().pushToast('warning', '连接恢复后未找到活动运行，已按持久化消息状态恢复');
    }
    set(patch);
  },

  async openDocument(docId, heading = null) {
    const pid = get().activeProjectId;
    if (!pid) return false;
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再切换文档');
      return false;
    }
    if (get().doc?.docId === docId) {
      if (heading) set({ pendingRevealHeading: heading });
      return true;
    }
    if (get().editorDirty && !await get().requestConfirm({
      title: '放弃未保存修改？',
      message: '当前文档有未保存修改。确定放弃这些修改并重新打开章节吗？',
      confirmText: '放弃并打开',
    })) return false;
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再切换文档');
      return false;
    }
    const expectedEditorDocId = get().doc?.docId ?? null;
    const expectedEditorContent = get().editorContent;
    const expectedEditorLoadVersion = get().editorLoadVersion;
    const requestSeq = ++documentRequestSeq;
    ++threadRequestSeq;
    const [res, threads] = await Promise.all([
      api.getDocument(pid, docId),
      api.listThreads(pid, docId),
    ]);
    if (
      requestSeq !== documentRequestSeq
      || get().activeProjectId !== pid
      || get().running
      || res.doc.docId !== docId
    ) return false;
    if (
      (get().doc?.docId ?? null) !== expectedEditorDocId
      || get().editorLoadVersion !== expectedEditorLoadVersion
      || get().editorContent !== expectedEditorContent
    ) {
      get().pushToast('warning', '加载章节期间编辑器内容发生变化，已取消切换以保留新输入');
      return false;
    }
    set((state) => ({
      doc: res.doc,
      docContent: res.content,
      editorLoadVersion: state.editorLoadVersion + 1,
      editorContent: res.content,
      baseSha: res.doc.sha256,
      editorDirty: false,
      selection: null,
      threads,
      activeThread: null,
      messages: [],
      streamingText: '',
      running: false,
      activeRunId: null,
      runTools: [],
      runUsage: null,
      runManifest: null,
      runError: null,
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
      wholeDocThreadBaselines: {},
      wholeDocMessageBaselines: {},
      pendingWholeDocRunBaseline: null,
      revisionHistoryOpen: false,
      revisionRestoreRequest: null,
      lastAppliedRewriteThreadId: null,
      pendingRevealHeading: heading,
      pendingRevealQuote: null,
    }));
    return true;
  },

  async openDocumentThen(docId, then) {
    const opened = await get().openDocument(docId);
    if (!opened) return false;
    if (then === 'revisions') {
      get().setRevisionHistoryOpen(true);
    } else {
      await get().createWholeDocRewriteThread();
    }
    return true;
  },

  clearRevealHeading() {
    set({ pendingRevealHeading: null });
  },

  revealTextQuote(quote) {
    set({ pendingRevealQuote: quote });
  },

  clearRevealQuote() {
    set({ pendingRevealQuote: null });
  },

  markDirty(content) {
    set({ editorDirty: true, editorContent: content });
  },

  async saveDocument(content) {
    const { activeProjectId, doc, baseSha, lastAppliedRewriteThreadId, activeThread } = get();
    if (!activeProjectId || !doc) return 'saved';
    const docId = doc.docId;
    try {
      const canonSourceThreadId = (
        lastAppliedRewriteThreadId
        && activeThread?.id === lastAppliedRewriteThreadId
        && activeThread.origin === 'canon'
      ) ? lastAppliedRewriteThreadId : undefined;
      const meta = await api.putDocument(
        activeProjectId,
        docId,
        content,
        baseSha,
        canonSourceThreadId,
      );
      const stillCurrent = get().activeProjectId === activeProjectId && get().doc?.docId === docId;
      const hasNewEdits = stillCurrent && get().editorContent !== content;
      // Only adopt the response if the user hasn't switched documents mid-save;
      // otherwise doc/baseSha would point at a doc that is no longer in the editor.
      // docContent intentionally not updated here: it would recreate the
      // CodeMirror instance and reset the cursor. baseSha is the lock token.
      if (stillCurrent) {
        set((state) => ({
          doc: meta,
          baseSha: meta.sha256,
          ...(state.editorContent === content
            ? { editorDirty: false, editorContent: content }
            : { editorDirty: true }),
        }));
      }
      const sourceThreadId = lastAppliedRewriteThreadId ?? undefined;
      await api.createRevision(activeProjectId, docId, {
        kind: 'user_edit',
        content,
        label: '保存',
        ...(sourceThreadId ? { sourceThreadId } : {}),
      }).catch((err) => {
        get().pushToast(
          'warning',
          `正文已保存，但版本快照失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (
        get().activeProjectId === activeProjectId
        && get().doc?.docId === docId
        && get().lastAppliedRewriteThreadId === lastAppliedRewriteThreadId
      ) set({ lastAppliedRewriteThreadId: null });
      // A failed git refresh must not report the (successful) save as failed.
      const git = await api.getGitStatus(activeProjectId).catch(() => null);
      if (git && get().activeProjectId === activeProjectId) set({ git });
      if (canonSourceThreadId) {
        // The save itself succeeded either way; only claim a refreshed
        // injection cache when the sidebar readback actually landed.
        const sidebarRefreshed = await get().refreshSidebar();
        get().pushToast('success', sidebarRefreshed ? '设定已更新，注入缓存已刷新' : '设定已保存');
      }
      return hasNewEdits ? 'saved-with-new-edits' : 'saved';
    } catch (err) {
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === 'STALE_WRITE') {
        return 'conflict';
      }
      throw err;
    }
  },

  setSelection(selection) {
    set({ selection });
  },

  setRightPaneTab(tab) {
    set({ rightPaneTab: tab });
  },

  setAppMode(mode) {
    set({ appMode: mode });
  },

  async loadChatThreads() {
    const pid = get().activeProjectId;
    if (!pid) return;
    try {
      const chatThreads = await api.listProjectThreads(pid, 'chat');
      if (get().activeProjectId !== pid) return;
      set({ chatThreads });
    } catch {
      // Chat history is auxiliary; a failed load must not block the AI tab.
    }
  },

  async startCharacterChat(characterName, memoryCutoffChapter) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再发起对话');
      return;
    }
    const pid = get().activeProjectId;
    const project = get().projects.find((candidate) => candidate.config.id === pid);
    if (!pid || !project) return;
    const charactersSource = project.config.sidebarSources.find(
      (source) => source.parser === 'heading-sections' && source.parserConfig.kind === 'characters',
    );
    if (!charactersSource) {
      get().pushToast('warning', '该项目未配置角色卡数据源，无法发起角色对话');
      return;
    }
    // Chat is writer-profile only (server-enforced): pick a writer-capable agent.
    const preferred = pickPreferredAgent(
      get().agents,
      'writer',
      project.config.defaultAgentId,
    );
    if (!preferred) {
      get().pushToast('danger', '没有支持 writer profile 的可用 Agent');
      return;
    }
    // Resume the existing conversation with this character instead of piling
    // up duplicate threads.
    const existing = get().chatThreads.find(
      (thread) =>
        thread.status === 'open'
        && thread.persona?.characterName === characterName
        && thread.persona.memoryCutoffChapter === memoryCutoffChapter,
    );
    if (existing) {
      await get().openThread(existing.id);
      return;
    }
    ++threadRequestSeq;
    let thread: Thread;
    try {
      thread = await api.createThread({
        projectId: pid,
        docId: charactersSource.file,
        kind: 'chat',
        agentId: preferred.agentId,
        persona: {
          characterName,
          ...(memoryCutoffChapter === undefined ? {} : { memoryCutoffChapter }),
        },
      });
    } catch (err) {
      get().pushToast('danger', `发起角色对话失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (get().activeProjectId !== pid) return;
    set((s) => ({
      chatThreads: [...s.chatThreads, thread],
      activeThread: thread,
      messages: [],
      streamingText: '',
      runTools: [],
      runUsage: null,
      runManifest: null,
      runError: null,
      composerFocusNonce: s.composerFocusNonce + 1,
      rightPaneTab: 'ai',
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
    }));
    if (get().focusMode) get().toggleFocus();
    if (get().rightCollapsed) get().toggleRight();
  },

  async startChapterGeneration({ title, target }) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再开始生成');
      return;
    }
    const pid = get().activeProjectId;
    const project = get().projects.find((candidate) => candidate.config.id === pid);
    if (!pid || !project) return;
    // Generation is writer-only by contract: origin='generate' rejects any
    // other profile, so ignore the project default here.
    const profile = 'writer' as const;
    const preferred = pickPreferredAgent(
      get().agents,
      profile,
      project.config.defaultAgentId,
    );
    if (!preferred) {
      get().pushToast('danger', `没有支持 ${profile} profile 的可用 Agent`);
      return;
    }
    let docMeta: DocumentMeta;
    try {
      docMeta = target === 'chapter'
        ? await api.createChapter(pid, title)
        : await api.createDraft(pid, title);
      if (target === 'draft') void get().refreshDrafts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A route the server does not have yet answers with Fastify's plain 404
      // instead of the ApiResult envelope; surface an actionable hint.
      const routeMissing = target === 'chapter' && /not found|Not Found|undefined/i.test(message);
      get().pushToast(
        'danger',
        routeMissing
          ? '正文新章端点不可用，可先选择「生成到草稿」'
          : `创建目标文档失败：${message}`,
      );
      return;
    }
    let thread: Thread;
    try {
      thread = await api.createThread({
        projectId: pid,
        docId: docMeta.docId,
        kind: 'rewrite',
        agentId: preferred.agentId,
        profile,
        origin: 'generate',
      });
    } catch (err) {
      get().pushToast('danger', `创建生成线程失败：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (get().activeProjectId !== pid) return;
    ++threadRequestSeq;
    set((s) => ({
      generateDoc: docMeta,
      beats: [],
      beatIndex: 0,
      beatTexts: [],
      beatPhase: 'writing',
      beatRewriting: false,
      activeThread: thread,
      messages: [],
      streamingText: '',
      runTools: [],
      runUsage: null,
      runManifest: null,
      composerFocusNonce: s.composerFocusNonce + 1,
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
    }));
    // Refresh the tree so the new file is visible immediately.
    const treeSeq = treeRequestGate.begin();
    const tree = await api.getTree(pid).catch(() => null);
    if (tree && get().activeProjectId === pid && treeRequestGate.accept(treeSeq)) {
      set({ tree });
    }
  },

  async startGenerationBeats(outline) {
    const parsed = parseOutlineBeats(outline);
    if (parsed.beats.length === 0) {
      get().pushToast('warning', '章纲只有停点，没有可生成的情节拍');
      return false;
    }
    const content = parsed.gated ? buildBeatPrompt(parsed.beats[0]!, 0) : outline;
    set({
      beats: parsed.beats,
      beatIndex: 0,
      beatTexts: Array.from({ length: parsed.beats.length }, () => ''),
      beatPhase: 'writing',
      beatRewriting: false,
    });
    const sent = await get().sendMessage(content, true);
    if (!sent) {
      set({ beats: [], beatIndex: 0, beatTexts: [], beatPhase: 'writing', beatRewriting: false });
    }
    return sent;
  },

  async continueGenerationBeat() {
    const state = get();
    if (
      state.running
      || state.beatPhase !== 'awaiting-confirm'
      || state.beatIndex >= state.beats.length - 1
    ) return false;
    const nextIndex = state.beatIndex + 1;
    const beat = state.beats[nextIndex];
    if (!beat) return false;
    set({ beatIndex: nextIndex, beatPhase: 'writing', beatRewriting: false });
    const sent = await get().sendMessage(buildBeatPrompt(beat, nextIndex), true);
    if (!sent) set({ beatPhase: 'writing', beatRewriting: false });
    return sent;
  },

  async retryGenerationBeat() {
    const state = get();
    const beat = state.beats[state.beatIndex];
    if (state.running || state.beatPhase !== 'writing' || !beat) return false;
    set({ beatRewriting: false });
    return get().sendMessage(
      state.beats.length === 1 ? beat : buildBeatPrompt(beat, state.beatIndex),
      true,
    );
  },

  async rewriteGenerationBeat(feedback) {
    const state = get();
    const beat = state.beats[state.beatIndex];
    if (state.running || state.beatPhase !== 'awaiting-confirm' || !beat || !feedback.trim()) {
      return false;
    }
    set({ beatPhase: 'writing', beatRewriting: true });
    const sent = await get().sendMessage(
      buildBeatRewritePrompt(beat, state.beatIndex, feedback),
      true,
    );
    if (!sent) set({ beatPhase: 'awaiting-confirm', beatRewriting: false });
    return sent;
  },

  async adoptGeneratedChapter(messageId) {
    const {
      generateDoc,
      activeThread,
      messages,
      activeProjectId,
      beats,
      beatTexts,
      beatPhase,
    } = get();
    if (!generateDoc || !activeThread || !activeProjectId || get().running) return;
    const message = messageId
      ? messages.find((candidate) => candidate.id === messageId)
      : undefined;
    const candidate = beats.length > 0 && beatPhase === 'done'
      ? composeBeatTexts(beatTexts)
      : message?.structured && 'rewritten_text' in message.structured
        ? message.structured.rewritten_text
        : message?.content ?? '';
    if (!candidate.trim()) {
      get().pushToast('warning', '该轮没有可采纳的正文');
      return;
    }
    try {
      // Fresh sha guards against edits made to the skeleton while generating.
      const fresh = await api.getDocument(activeProjectId, generateDoc.docId);
      await api.createRevision(activeProjectId, generateDoc.docId, {
        kind: 'ai_original',
        content: candidate,
        sourceThreadId: activeThread.id,
        label: 'AI 生成章节',
      });
      await api.putDocument(activeProjectId, generateDoc.docId, candidate, fresh.doc.sha256);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : '';
      get().pushToast(
        'danger',
        code === 'STALE_WRITE'
          ? '目标文件在生成期间被外部修改，未写入；请手动合并'
          : `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const docId = generateDoc.docId;
    set({
      appMode: 'writing',
      generateDoc: null,
      beats: [],
      beatIndex: 0,
      beatTexts: [],
      beatPhase: 'writing',
      beatRewriting: false,
    });
    const opened = await get().openDocument(docId);
    if (opened) get().pushToast('success', '已写入正文并打开，可直接修改或对整章提意见');
  },

  async openThread(tid) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再切换线程');
      return;
    }
    const projectId = get().activeProjectId;
    const docId = get().doc?.docId ?? null;
    if (!projectId) return;
    const requestSeq = ++threadRequestSeq;
    const res = await api.getThread(tid);
    if (
      requestSeq !== threadRequestSeq
      || get().activeProjectId !== projectId
      || get().running
      || res.thread.projectId !== projectId
    ) return;
    // Document threads stay bound to the open document; chat threads are
    // project-level and open regardless of the editor state.
    if (res.thread.kind !== 'chat') {
      if (
        docId === null
        || (get().doc?.docId ?? null) !== docId
        || res.thread.docId !== docId
      ) return;
    }
    set((s) => ({
      activeThread: res.thread,
      messages: res.messages,
      streamingText: '',
      runTools: [],
      runUsage: null,
      runManifest: null,
      composerFocusNonce: s.composerFocusNonce + 1,
      rightPaneTab: 'ai',
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
    }));
  },

  async renameThread(tid, title) {
    const nextTitle = title.trim();
    const state = get();
    const existing = state.threads.find((thread) => thread.id === tid)
      ?? state.chatThreads.find((thread) => thread.id === tid)
      ?? (state.activeThread?.id === tid ? state.activeThread : undefined);
    if (!nextTitle) return false;
    if (!existing) {
      get().pushToast('warning', '线程不存在或已不在当前项目，无法重命名');
      return false;
    }
    if (existing.title === nextTitle) return true;
    if (state.running && state.activeThread?.id === tid) {
      get().pushToast('warning', '请先停止当前 AI 运行再重命名此线程');
      return false;
    }

    const previousTitle = existing.title;
    const rename = (thread: Thread): Thread =>
      thread.id === tid ? { ...thread, title: nextTitle } : thread;
    set((current) => ({
      threads: current.threads.map(rename),
      chatThreads: current.chatThreads.map(rename),
      activeThread: current.activeThread ? rename(current.activeThread) : null,
    }));

    try {
      const updated = await api.patchThread(tid, { title: nextTitle });
      // Absorb only the renamed fields: swallowing the whole response could
      // clobber a concurrent local change (e.g. an agent switch) that the
      // server processed after this PATCH was sent.
      const absorb = (thread: Thread): Thread =>
        thread.id === tid ? { ...thread, title: updated.title, updatedAt: updated.updatedAt } : thread;
      set((current) => ({
        threads: current.threads.map(absorb),
        chatThreads: current.chatThreads.map(absorb),
        activeThread: current.activeThread ? absorb(current.activeThread) : current.activeThread,
      }));
      get().pushToast('success', '线程已重命名');
      return true;
    } catch (err) {
      const rollback = (thread: Thread): Thread =>
        thread.id === tid && thread.title === nextTitle
          ? { ...thread, title: previousTitle }
          : thread;
      set((current) => ({
        threads: current.threads.map(rollback),
        chatThreads: current.chatThreads.map(rollback),
        activeThread: current.activeThread ? rollback(current.activeThread) : null,
      }));
      get().pushToast(
        'danger',
        `重命名线程失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  },

  async createThreadFromSelection(kind) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再创建线程');
      return;
    }
    const beforeSave = get();
    if (!beforeSave.activeProjectId || !beforeSave.doc || !beforeSave.selection) return;
    if (
      await saveDirtyEditorBeforeThreadAction(
        beforeSave,
        '创建选区线程',
        get().saveDocument,
        get().pushToast,
      ) === 'aborted'
    ) return;
    const { activeProjectId, doc, selection, baseSha } = get();
    if (
      !activeProjectId
      || !doc
      || !selection
      || doc.docId !== beforeSave.doc.docId
    ) return;
    const expectedDocumentSeq = documentRequestSeq;
    const requestSeq = ++threadRequestSeq;
    let { agents } = get();
    if (!get().agentsLoaded) {
      try {
        agents = await api.listAgents();
        set({ agents, agentsLoaded: true });
      } catch (err) {
        set({ agents: [], agentsLoaded: true });
        get().pushToast('danger', `无法创建线程：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const project = get().projects.find((candidate) => candidate.config.id === activeProjectId);
    if (!project) return;
    const profile = project.config.aiProfiles.defaultProfile;
    const preferred = pickPreferredAgent(
      agents,
      profile,
      project.config.defaultAgentId,
    );
    if (!preferred) {
      get().pushToast('danger', `没有支持 ${profile} profile 的可用 Agent`);
      return;
    }
    if (
      requestSeq !== threadRequestSeq
      || documentRequestSeq !== expectedDocumentSeq
      || get().activeProjectId !== activeProjectId
      || get().doc?.docId !== doc.docId
      || get().selection !== selection
      || get().editorDirty
      || get().running
    ) return;
    const thread = await api.createThread({
      projectId: activeProjectId,
      docId: doc.docId,
      kind,
      agentId: preferred.agentId,
      profile,
      anchor: {
        docSha: baseSha,
        start: selection.start,
        end: selection.end,
        prefix: selection.prefix,
        exact: selection.exact,
        suffix: selection.suffix,
      },
    });
    if (
      requestSeq !== threadRequestSeq
      || documentRequestSeq !== expectedDocumentSeq
      || get().activeProjectId !== activeProjectId
      || get().doc?.docId !== doc.docId
      || get().selection !== selection
      || get().editorDirty
      || get().running
    ) return;
    set((s) => ({
      threads: [...s.threads, thread],
      activeThread: thread,
      messages: [],
      runTools: [],
      runUsage: null,
      runManifest: null,
      composerFocusNonce: s.composerFocusNonce + 1,
      rightPaneTab: 'ai',
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
    }));
    // Selection→thread is the hot path: make sure the composer is visible
    // (right pane may be collapsed) so the user can type immediately.
    // Focus mode hides the right pane independently of its collapsed state.
    // Exit it before opening the pane so the new thread is visible and the
    // composer focus request lands on a usable control.
    if (get().focusMode) get().toggleFocus();
    if (get().rightCollapsed) get().toggleRight();
  },

  async createWholeDocRewriteThread() {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再创建线程');
      return;
    }
    const beforeSave = get();
    if (!beforeSave.activeProjectId || !beforeSave.doc) return;
    if (beforeSave.editorContent.length > WHOLE_DOC_FRIENDLY_CHAR_LIMIT) {
      get().pushToast(
        'warning',
        `当前正文超过 ${WHOLE_DOC_FRIENDLY_CHAR_LIMIT.toLocaleString()} 字符，无法安全生成整章改写；请改用选区改写`,
      );
      return;
    }
    if (
      await saveDirtyEditorBeforeThreadAction(
        beforeSave,
        '对整章提意见',
        get().saveDocument,
        get().pushToast,
      ) === 'aborted'
    ) return;
    const { activeProjectId, doc, baseSha, editorContent } = get();
    if (!activeProjectId || !doc || doc.docId !== beforeSave.doc.docId || !baseSha) return;
    const baseline: WholeDocBaseline = {
      projectId: activeProjectId,
      docId: doc.docId,
      baseSha,
      content: editorContent,
    };
    const expectedDocumentSeq = documentRequestSeq;
    const requestSeq = ++threadRequestSeq;
    const project = get().projects.find((candidate) => candidate.config.id === activeProjectId);
    if (!project) return;
    const profile = project.config.aiProfiles.defaultProfile;
    const preferred = pickPreferredAgent(
      get().agents,
      profile,
      project.config.defaultAgentId,
    );
    if (!preferred) {
      get().pushToast('danger', `没有支持 ${profile} profile 的可用 Agent`);
      return;
    }
    const thread = await api.createThread({
      projectId: activeProjectId,
      docId: doc.docId,
      kind: 'rewrite',
      agentId: preferred.agentId,
      profile,
    }).catch((err) => {
      get().pushToast('danger', `创建整章线程失败：${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (
      !thread
      || requestSeq !== threadRequestSeq
      || documentRequestSeq !== expectedDocumentSeq
      || get().activeProjectId !== activeProjectId
      || get().doc?.docId !== doc.docId
      || get().baseSha !== baseline.baseSha
      || get().editorContent !== baseline.content
      || get().editorDirty
      || get().running
    ) return;
    set((s) => ({
      threads: [...s.threads, thread],
      activeThread: thread,
      messages: [],
      runTools: [],
      runUsage: null,
      runManifest: null,
      composerFocusNonce: s.composerFocusNonce + 1,
      rightPaneTab: 'ai',
      pendingStructured: null,
      rewriteReview: null,
      rewriteApplyRequest: null,
      wholeDocThreadBaselines: { ...s.wholeDocThreadBaselines, [thread.id]: baseline },
      wholeDocMessageBaselines: {},
      pendingWholeDocRunBaseline: null,
    }));
    if (get().focusMode) get().toggleFocus();
    if (get().rightCollapsed) get().toggleRight();
  },

  async runConflictCheck() {
    if (get().running || get().conflictCheckStarting) {
      get().pushToast('warning', '已有 AI 任务正在运行');
      return;
    }
    const initial = get();
    if (!initial.activeProjectId || !initial.doc) return;
    const projectId = initial.activeProjectId;
    const docId = initial.doc.docId;
    set({ conflictCheckStarting: true });
    try {
      if (initial.editorDirty) {
        const saved = await get().saveDocument(initial.editorContent);
        if (saved === 'conflict') {
          get().pushToast('warning', '保存冲突：请合并外部修改后再查冲突');
          return;
        }
        if (saved === 'saved-with-new-edits') {
          get().pushToast('warning', '保存期间正文继续变化，请再次保存后再查冲突');
          return;
        }
      }
      if (
        get().activeProjectId !== projectId
        || get().doc?.docId !== docId
        || get().editorDirty
        || get().running
      ) return;
      let { agents } = get();
      if (!get().agentsLoaded) {
        agents = await api.listAgents();
        set({ agents, agentsLoaded: true });
      }
      const project = get().projects.find((candidate) => candidate.config.id === projectId);
      if (!project) return;
      const preferred = pickPreferredAgent(
        agents,
        'writer',
        project.config.defaultAgentId,
      );
      if (!preferred) {
        get().pushToast('danger', '没有支持 writer profile 的可用 Agent');
        return;
      }
      const preferredModel = get().modelPrefs[preferred.agentId];
      const model = preferred.models !== undefined
        ? preferredModel || findCatalogDefault(preferred.models)?.id
        : undefined;
      const requestSeq = ++threadRequestSeq;
      const started = await api.startConflictCheck(projectId, docId, {
        agentId: preferred.agentId,
        ...(model ? { model } : {}),
      });
      if (
        requestSeq !== threadRequestSeq
        || get().activeProjectId !== projectId
        || get().doc?.docId !== docId
        || get().running
      ) return;
      const durable = await api.getThread(started.threadId);
      if (
        requestSeq !== threadRequestSeq
        || get().activeProjectId !== projectId
        || get().doc?.docId !== docId
      ) return;
      const generation = get().runGeneration + 1;
      set((state) => ({
        threads: state.threads.some((thread) => thread.id === durable.thread.id)
          ? state.threads.map((thread) => thread.id === durable.thread.id ? durable.thread : thread)
          : [...state.threads, durable.thread],
        activeThread: durable.thread,
        messages: durable.messages,
        streamingText: '',
        running: true,
        activeRunId: started.runId,
        runGeneration: generation,
        runTools: [],
        runUsage: null,
        runManifest: null,
        runError: null,
        rightPaneTab: 'ai',
        pendingStructured: null,
        rewriteReview: null,
        rewriteApplyRequest: null,
        conflictCheckStarting: false,
      }));
      if (get().focusMode) get().toggleFocus();
      if (get().rightCollapsed) get().toggleRight();
      void api.getRun(started.runId).then(async (run) => {
        if (
          run.status === 'running'
          || get().runGeneration !== generation
          || get().activeRunId !== started.runId
        ) return;
        const finished = await api.getThread(started.threadId);
        if (
          get().runGeneration === generation
          && get().activeRunId === started.runId
          && get().activeThread?.id === started.threadId
        ) {
          const failure = run.status === 'failed'
            ? formatRunError(run.errorCode, null, run.errorDetail)
            : null;
          set({
            activeThread: finished.thread,
            messages: finished.messages,
            running: false,
            activeRunId: null,
            streamingText: '',
            pendingStructured: null,
            runError: failure,
          });
          if (failure) get().pushToast('danger', `Agent 运行失败：${failure}`);
        }
      }).catch(() => undefined);
    } catch (error) {
      get().pushToast(
        'danger',
        `查冲突失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (get().activeProjectId === projectId && get().doc?.docId === docId) {
        set({ conflictCheckStarting: false });
      }
    }
  },

  openCanonSource(docId, heading) {
    const project = get().projects.find(
      (candidate) => candidate.config.id === get().activeProjectId,
    );
    const source = project?.config.sidebarSources.find((candidate) => candidate.file === docId);
    if (!source) {
      get().pushToast('warning', `未找到正典资料源：${docId} · ${heading}`);
      return;
    }
    set({ activeSidebarId: source.id, rightPaneTab: 'canon' });
    if (get().focusMode) get().toggleFocus();
    if (get().rightCollapsed) get().toggleRight();
  },

  async startCanonRewrite(docId, section, evidence) {
    if (get().running) {
      get().pushToast('warning', '请先停止当前 AI 运行再修补正典');
      return;
    }
    const projectId = get().activeProjectId;
    const project = get().projects.find((candidate) => candidate.config.id === projectId);
    if (!projectId || !project) return;
    let { agents } = get();
    if (!get().agentsLoaded) {
      try {
        agents = await api.listAgents();
        set({ agents, agentsLoaded: true });
      } catch (error) {
        get().pushToast('danger', `无法创建修补线程：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    const preferred = pickPreferredAgent(
      agents,
      'writer',
      project.config.defaultAgentId,
    );
    if (!preferred) {
      get().pushToast('danger', '没有支持 writer profile 的可用 Agent');
      return;
    }
    const opened = await get().openDocument(docId, section.headingPath.at(-1) ?? null);
    if (
      !opened
      || get().activeProjectId !== projectId
      || get().doc?.docId !== docId
      || get().running
    ) return;
    try {
      const thread = await api.createThread({
        projectId,
        docId,
        kind: 'rewrite',
        origin: 'canon',
        profile: 'writer',
        agentId: preferred.agentId,
        anchor: section.anchor,
        headingPath: section.headingPath,
        ...(evidence ? { evidence } : {}),
      });
      if (
        get().activeProjectId !== projectId
        || get().doc?.docId !== docId
        || get().running
      ) return;
      set((state) => ({
        threads: [...state.threads, thread],
        activeThread: thread,
        messages: [],
        runTools: [],
        runUsage: null,
        runManifest: null,
        rightPaneTab: 'ai',
        composerFocusNonce: state.composerFocusNonce + 1,
        pendingStructured: null,
        rewriteReview: null,
        rewriteApplyRequest: null,
      }));
      if (get().focusMode) get().toggleFocus();
      if (get().rightCollapsed) get().toggleRight();
    } catch (error) {
      get().pushToast(
        'danger',
        `无法创建修补线程：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  async startCanonRewriteFromFinding(docId, heading, textQuote) {
    const state = get();
    const project = state.projects.find(
      (candidate) => candidate.config.id === state.activeProjectId,
    );
    const source = project?.config.sidebarSources.find((candidate) => candidate.file === docId);
    const payload = source
      ? state.sidebar.find((candidate) => candidate.sourceId === source.id)
      : undefined;
    const normalizedHeading = heading.replace(/\s*[/>]\s*/gu, ' / ').trim();
    const matches = (payload?.writerSections ?? []).filter((section) => {
      const joined = section.headingPath.join(' / ');
      const last = section.headingPath.at(-1) ?? '';
      return joined === normalizedHeading || last === heading.trim();
    });
    const evidenceDocId = state.doc?.docId;
    if (!source || matches.length !== 1 || !evidenceDocId) {
      get().pushToast('warning', `未找到唯一可修订的 writer 可见正典节：${docId} · ${heading}`);
      return;
    }
    await get().startCanonRewrite(docId, matches[0]!, {
      docId: evidenceDocId,
      textQuote,
    });
  },

  async setThreadAgent(agentId) {
    const thread = get().activeThread;
    if (!thread || get().running || thread.agentId === agentId) return;
    const projectId = get().activeProjectId;
    const docId = get().doc?.docId;
    const expectedThreadSeq = ++threadRequestSeq;
    try {
      const updated = await api.patchThread(thread.id, { agentId });
      if (
        threadRequestSeq !== expectedThreadSeq
        || get().activeProjectId !== projectId
        || get().doc?.docId !== docId
        || get().activeThread?.id !== thread.id
        || get().running
      ) return;
      set((state) => ({
        activeThread: updated,
        threads: state.threads.map((candidate) => candidate.id === updated.id ? updated : candidate),
      }));
    } catch (err) {
      get().pushToast('danger', `切换 Agent 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  },

  setAgentModel(agentId, model) {
    const prefs = { ...get().modelPrefs };
    if (model) prefs[agentId] = model;
    else delete prefs[agentId];
    localStorage.setItem(MODEL_PREFS_KEY, JSON.stringify(prefs));
    set({ modelPrefs: prefs });
  },

  async sendMessage(content, wantRewrite) {
    const thread = get().activeThread;
    if (!thread || get().running) return false;
    const wholeDocBaseline = get().wholeDocThreadBaselines[thread.id];
    if (wholeDocBaseline) {
      const state = get();
      if (
        state.activeProjectId !== wholeDocBaseline.projectId
        || state.doc?.docId !== wholeDocBaseline.docId
        || state.baseSha !== wholeDocBaseline.baseSha
        || state.editorContent !== wholeDocBaseline.content
        || state.editorDirty
      ) {
        get().pushToast('warning', '正文已在整章线程创建后变化；请重新创建整章线程再发送');
        return false;
      }
    }
    const localMessageId = `local-${Date.now()}`;
    const generation = get().runGeneration + 1;
    set((s) => ({
      running: true,
      activeRunId: null,
      runGeneration: generation,
      streamingText: '',
      runTools: [],
      runUsage: null,
      runManifest: null,
      runError: null,
      pendingStructured: null,
      pendingWholeDocRunBaseline: wholeDocBaseline
        ? { ...wholeDocBaseline, threadId: thread.id, generation }
        : null,
      messages: [
        ...s.messages,
        {
          id: localMessageId,
          threadId: thread.id,
          role: 'user',
          agentId: null,
          content,
          structured: null,
          createdAt: Date.now(),
        },
      ],
    }));
    try {
      // The model field is feature-gated: only send it when the server-side
      // availability record advertises a model catalog for this agent.
      const availability = get().agents.find((agent) => agent.agentId === thread.agentId);
      const preferredModel = get().modelPrefs[thread.agentId];
      // `undefined` is the feature gate. An explicitly empty catalog still
      // supports the custom model entry in the panel.
      const model = availability?.models !== undefined
        ? preferredModel || findCatalogDefault(availability.models)?.id
        : undefined;
      const response = await api.postMessage(thread.id, content, {
        ...(wantRewrite ? { wantRewrite: true } : {}),
        ...(model ? { model } : {}),
      });
      if (
        get().running
        && get().runGeneration === generation
        && get().activeThread?.id === thread.id
      ) {
        set({ activeRunId: response.runId });
        // A very fast run may finish before the POST response reaches this
        // tab. Read back its durable state once so a missed terminal WS frame
        // cannot leave the UI stuck in running state.
        void api.getRun(response.runId).then(async (run) => {
          if (
            run.status === 'running'
            || get().runGeneration !== generation
            || get().activeRunId !== response.runId
          ) return;
          const durable = await api.getThread(thread.id);
          if (
            get().runGeneration === generation
            && get().activeThread?.id === thread.id
            && get().activeRunId === response.runId
          ) {
            const failure = run.status === 'failed'
              ? formatRunError(run.errorCode, null, run.errorDetail)
              : null;
            const pending = get().pendingWholeDocRunBaseline;
            const assistant = [...durable.messages].reverse().find((message) => message.role === 'assistant');
            const previousAssistantId = [...get().messages]
              .reverse()
              .find((message) => message.role === 'assistant')?.id;
            set({
              activeThread: durable.thread,
              messages: durable.messages,
              running: false,
              activeRunId: null,
              streamingText: '',
              pendingStructured: null,
              runError: failure,
              ...settleGenerationBeat(
                get(),
                assistant,
                run.status === 'completed',
                previousAssistantId,
              ),
              ...(pending?.threadId === thread.id && pending.generation === generation && assistant
                ? {
                    wholeDocMessageBaselines: {
                      ...get().wholeDocMessageBaselines,
                      [assistant.id]: pending,
                    },
                    pendingWholeDocRunBaseline: null,
                  }
                : {}),
            });
            if (failure) get().pushToast('danger', `Agent 运行失败：${failure}`);
          }
        }).catch(() => undefined);
      }
      return true;
    } catch (err) {
      if (get().runGeneration === generation) {
        set((state) => ({
          running: false,
          activeRunId: null,
          streamingText: '',
          messages: state.messages.filter((message) => message.id !== localMessageId),
          pendingWholeDocRunBaseline: null,
        }));
      }
      get().pushToast('danger', `发送失败：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  },

  async stopRun() {
    const thread = get().activeThread;
    if (thread) await api.stopThread(thread.id);
  },

  applyAgentEvent(runId, threadId, event, manifest) {
    const state = get();
    if (!state.running || state.activeRunId !== runId || state.activeThread?.id !== threadId) return;
    if (manifest !== undefined) set({ runManifest: manifest });
    if (event.type === 'delta') {
      set((s) => ({ streamingText: s.streamingText + String(event['text'] ?? '') }));
    } else if (event.type === 'tool') {
      set((s) => ({
        runTools: [
          ...s.runTools.slice(-49),
          { tool: String(event['tool'] ?? ''), status: String(event['status'] ?? '') },
        ],
      }));
    } else if (event.type === 'usage') {
      set((s) => {
        const base = s.runUsage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
        return {
          runUsage: {
            inputTokens: base.inputTokens + num(event['inputTokens']),
            outputTokens: base.outputTokens + num(event['outputTokens']),
            costUsd: base.costUsd + num(event['costUsd']),
          },
        };
      });
    } else if (event.type === 'structured') {
      const data = event['data'];
      if (
        event['valid'] === true
        && data !== null
        && typeof data === 'object'
        && typeof (data as { rewritten_text?: unknown }).rewritten_text === 'string'
      ) {
        set({ pendingStructured: data as RewriteResponse });
      } else {
        set({ pendingStructured: null });
      }
    } else if (event.type === 'done' || event.type === 'error') {
      const generation = state.runGeneration;
      const completed = event.type === 'done'
        && !['cancelled', 'timeout', 'error'].includes(String(event['stopReason'] ?? ''));
      if (event.type === 'error') {
        const failure = formatRunError(
          typeof event['code'] === 'string' ? event['code'] : null,
          typeof event['message'] === 'string' ? event['message'] : null,
          typeof event['detail'] === 'string' ? event['detail'] : null,
        );
        set({ runError: failure });
        get().pushToast('danger', `Agent 运行失败：${failure}`);
      } else {
        set({ runError: null });
      }
      set({ running: false, activeRunId: null, streamingText: '', runTools: [], pendingStructured: null });
      // Replace optimistic ids/content with the durable message table after
      // every terminal event. This also recovers a structured rewrite that
      // arrived immediately before a WebSocket reconnect.
      void api.getThread(threadId).then((res) => {
        if (
          get().runGeneration === generation
          && !get().running
          && get().activeThread?.id === threadId
        ) {
          const pending = get().pendingWholeDocRunBaseline;
          const assistant = [...res.messages].reverse().find((message) => message.role === 'assistant');
          const previousAssistantId = [...get().messages]
            .reverse()
            .find((message) => message.role === 'assistant')?.id;
          set({
            activeThread: res.thread,
            messages: res.messages,
            ...settleGenerationBeat(get(), assistant, completed, previousAssistantId),
            ...(pending?.threadId === threadId && pending.generation === generation && assistant
              ? {
                  wholeDocMessageBaselines: {
                    ...get().wholeDocMessageBaselines,
                    [assistant.id]: pending,
                  },
                  pendingWholeDocRunBaseline: null,
                }
              : {}),
          });
        }
      }).catch(() => {
        get().pushToast('warning', '运行已结束，但持久化消息刷新失败；重新打开线程即可恢复');
      });
    }
  },

  openRewriteReview(messageId) {
    const {
      activeProjectId,
      doc,
      activeThread,
      messages,
      baseSha,
      editorContent,
      wholeDocMessageBaselines,
    } = get();
    const message = messages.find((candidate) => candidate.id === messageId);
    const anchor = activeThread?.anchor ?? null;
    if (
      !activeProjectId
      || !doc
      || !activeThread
      || activeThread.kind !== 'rewrite'
      || !message
      || message.role !== 'assistant'
      || (!message.structured && !message.content.trim())
    ) {
      get().pushToast('warning', '该改写结果缺少可用内容，无法打开对比');
      return;
    }
    const common = {
      messageId,
      projectId: activeProjectId,
      docId: doc.docId,
      threadId: activeThread.id,
      rewrittenText: message.structured && 'rewritten_text' in message.structured
        ? message.structured.rewritten_text
        : message.content,
      notes: message.structured && 'rewritten_text' in message.structured
        ? message.structured.notes ?? null
        : '结构化解析失败，请先核对并编辑原始输出',
      rawFallback: message.structured === null,
    };
    // A document-level thread (no anchor) reviews the candidate against the
    // full current buffer; apply replaces the whole document.
    const wholeDocBaseline = !anchor ? wholeDocMessageBaselines[messageId] : null;
    if (!anchor && (
      !wholeDocBaseline
      || wholeDocBaseline.projectId !== activeProjectId
      || wholeDocBaseline.docId !== doc.docId
      || wholeDocBaseline.baseSha !== baseSha
      || wholeDocBaseline.content !== editorContent
    )) {
      get().pushToast('warning', '正文已变化或该结果缺少完整基准，无法安全采纳；请重新创建整章线程');
      return;
    }
    set({
      rewriteReview: anchor
        ? {
            ...common,
            preferredStart: anchor.start,
            prefix: anchor.prefix,
            originalText: anchor.exact,
            suffix: anchor.suffix,
            wholeDoc: false,
            wholeDocBaseSha: null,
            canon: activeThread.origin === 'canon',
          }
        : {
            ...common,
            preferredStart: 0,
            prefix: '',
            originalText: wholeDocBaseline!.content,
            suffix: '',
            wholeDoc: true,
            wholeDocBaseSha: wholeDocBaseline!.baseSha,
            canon: false,
          },
    });
  },

  setRewriteReviewText(text) {
    const review = get().rewriteReview;
    if (review) set({ rewriteReview: { ...review, rewrittenText: text } });
  },

  closeRewriteReview() {
    set({ rewriteReview: null });
  },

  requestRewriteApply(rewrittenText) {
    const review = get().rewriteReview;
    if (review) {
      const request = rewrittenText === undefined ? review : { ...review, rewrittenText };
      set({ rewriteApplyRequest: request, rewriteReview: null });
    }
  },

  clearRewriteApplyRequest() {
    set({ rewriteApplyRequest: null });
  },

  setRevisionHistoryOpen(open) {
    set({ revisionHistoryOpen: open });
  },

  requestRevisionRestore(request) {
    set({ revisionRestoreRequest: request, revisionHistoryOpen: false });
  },

  clearRevisionRestoreRequest() {
    set({ revisionRestoreRequest: null });
  },

  setAppliedRewriteSource(threadId) {
    set({ lastAppliedRewriteThreadId: threadId });
  },
}));
