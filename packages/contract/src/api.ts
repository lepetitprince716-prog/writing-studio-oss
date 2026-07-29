/**
 * REST API contract. Base URL: http://127.0.0.1:<port>.
 * Every response uses the ApiResult envelope. Streaming goes over the
 * WebSocket at /ws (see events.ts); REST triggers runs, WS delivers them.
 */

import type {
  AgentId,
  Anchor,
  AnchorResolution,
  CanonEvidence,
  ChapterTree,
  ChatPersona,
  DocumentMeta,
  GitStatus,
  Message,
  LintResponse,
  Project,
  ProjectListItem,
  ProvenanceResponse,
  Revision,
  RevisionWithContent,
  Run,
  Thread,
  ThreadKind,
} from './models.js';
import type { AgentAvailability } from './agent.js';
import type { SidebarPayload, SidebarView } from './sidebar.js';
import type {
  GraphQuery,
  GraphSourceExcerpt,
  GraphSourceQuery,
  WorldGraphSnapshot,
} from './graph.js';

export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'STALE_WRITE'
  | 'CONFLICT'
  | 'PATH_ESCAPE'
  | 'INVALID_CONFIG'
  | 'VALIDATION'
  | 'UNPROCESSABLE'
  | 'THREAD_BUSY'
  | 'AGENT_UNAVAILABLE'
  /** The writer stop source is missing, ambiguous, or cannot resolve to a StoryPoint. */
  | 'GRAPH_STOP_POINT_INVALID'
  /** The complete semantic graph exceeds the fail-loud server hard limit. */
  | 'GRAPH_TOO_LARGE'
  /** Request did not originate from the localhost-only panel boundary. */
  | 'LOCAL_ONLY'
  | 'INTERNAL';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string } };

// ---------- Endpoint map ----------
// GET  /api/projects                              → ProjectListItem[]
// GET  /api/projects/:pid                          → Project
// GET  /api/projects/:pid/tree                     → ChapterTree
// GET  /api/projects/:pid/drafts                   → DocumentMeta[]
// GET  /api/projects/:pid/drafts/trash             → TrashListResponse
// DELETE /api/projects/:pid/drafts/:docId          → DeleteDraftResponse
// POST /api/projects/:pid/drafts/:docId/restore    → RestoreDraftResponse
// GET  /api/projects/:pid/git-status               → GitStatus
// GET  /api/projects/:pid/sidebar?view=writer      → SidebarPayload[]   (all sources; `view` defaults to writer)
// GET  /api/projects/:pid/sidebar/:sourceId?view=writer&q= → SidebarPayload (q filters table entries; `view` defaults to writer)
// GET  /api/projects/:pid/graph?view=writer        → WorldGraphSnapshot (`view` defaults to writer)
// GET  /api/projects/:pid/mentions/:canonical      → MentionLocation[]
// GET  /api/projects/:pid/sources/:docId?heading=&view=writer → GraphSourceExcerpt (bounded, read-only)
// GET  /api/projects/:pid/documents/:docId         → GetDocumentResponse
// PUT  /api/projects/:pid/documents/:docId         ← PutDocumentRequest → DocumentMeta (409 STALE_WRITE)
// PATCH /api/projects/:pid/documents/:docId/title   ← RenameChapterTitleRequest → RenameChapterTitleResponse
// POST /api/projects/:pid/documents                ← CreateDraftRequest → DocumentMeta
// POST /api/projects/:pid/chapters                 ← CreateChapterRequest → DocumentMeta
// GET  /api/projects/:pid/documents/:docId/revisions → Revision[]
// POST /api/projects/:pid/documents/:docId/revisions ← CreateRevisionRequest → Revision
// POST /api/projects/:pid/lint                    ← LintRequest → LintResponse
// GET  /api/projects/:pid/documents/:docId/provenance → ProvenanceResponse
// GET  /api/revisions/:rid                          → RevisionWithContent
// GET  /api/projects/:pid/documents/:docId/threads  → Thread[]
// GET  /api/projects/:pid/threads?kind=chat          → Thread[]
// POST /api/threads                                 ← CreateThreadRequest → Thread
// GET  /api/threads/:tid                            → GetThreadResponse
// POST /api/threads/:tid/messages                   ← PostMessageRequest → { runId: string }
// POST /api/threads/:tid/stop                       → { stopped: boolean }
// GET  /api/runs/:runId                              → Run
// PATCH /api/threads/:tid                           ← PatchThreadRequest → Thread
// GET  /api/agents                                  → AgentAvailability[]
//
// docId is the vault-relative path, URL-encoded. Server MUST reject any
// docId resolving outside vaultRoot (PATH_ESCAPE).

export interface GetDocumentResponse {
  doc: DocumentMeta;
  content: string;
  /** Anchors of open threads on this doc, re-resolved against current content. */
  anchors: Array<{ threadId: string; anchor: Anchor; resolution: AnchorResolution }>;
}

export interface MentionLocation {
  docId: string;
  chapterNo: number;
  count: number;
  firstOffset: number;
}

/** GET /api/projects/:pid/drafts additive response type. */
export type DraftListResponse = DocumentMeta[];

export interface DeleteDraftResponse {
  docId: string;
  trashedDocId: string;
}

export interface TrashEntry {
  trashedDocId: string;
  originalName: string;
  deletedAt: string;
  title: string;
}

export type TrashListResponse = TrashEntry[];

export interface RestoreDraftResponse {
  trashedDocId: string;
  docId: string;
}

export interface PutDocumentRequest {
  content: string;
  /** Optimistic lock: sha256 of the content this edit was based on. */
  baseSha256: string;
  /** Enables server-side section-boundary enforcement for a canon adoption. */
  sourceThreadId?: string;
}

export interface RenameChapterTitleRequest {
  title: string;
  /** Optimistic lock: sha256 of the chapter content this rename was based on. */
  baseSha256: string;
}

export interface RenameChapterTitleResponse {
  sha256: string;
  doc: DocumentMeta;
}

export interface CreateDraftRequest {
  title: string;
}

export interface CreateChapterRequest {
  title: string;
  dirOverride?: string;
}

export interface CreateRevisionRequest {
  kind: Revision['kind'];
  content: string;
  sourceThreadId?: string;
  label?: string;
}

export interface LintRequest {
  docId: string;
}

export interface ConflictCheckRequest {
  agentId?: AgentId;
  model?: string;
}

export interface ConflictCheckStartResponse {
  threadId: string;
  runId: string;
}

/** Parsed sidebar query. The server defaults omitted `view` to `writer`. */
export interface SidebarQuery {
  view: SidebarView;
  /** Optional text filter, currently meaningful for markdown-table sources. */
  q?: string;
}

export interface CreateThreadRequest {
  projectId: string;
  docId: string;
  kind: ThreadKind;
  anchor?: Anchor;
  agentId?: AgentId;
  profile?: 'writer' | 'planner';
  /** Required when kind is `chat` (server-enforced once roleplay lands). */
  persona?: ChatPersona;
  /** Specialized thread lifecycle marker. */
  origin?: 'generate' | 'check' | 'canon';
  /** Required only for origin=`canon`; the server verifies it against the writer projection. */
  headingPath?: string[];
  /** Optional conflict-finding evidence for a canon repair. */
  evidence?: CanonEvidence;
}

export interface GetThreadResponse {
  thread: Thread;
  messages: Message[];
}

export interface PostMessageRequest {
  content: string;
  /** Override the thread's agent for this and subsequent turns. */
  agentId?: AgentId;
  /**
   * Model id for this run's CLI `--model` flag. Only send values for an agent
   * whose availability record advertises `models` (the feature gate).
   */
  model?: string;
  /** Request a structured rewrite result (uses REWRITE_RESPONSE_SCHEMA). */
  wantRewrite?: boolean;
}

export interface PatchThreadRequest {
  status?: Thread['status'];
  agentId?: AgentId;
  title?: string;
}

export type {
  Project,
  ProjectListItem,
  ChapterTree,
  DocumentMeta,
  GitStatus,
  Revision,
  RevisionWithContent,
  LintResponse,
  ProvenanceResponse,
  Run,
  Thread,
  Message,
  AgentAvailability,
  SidebarPayload,
  SidebarView,
  GraphQuery,
  GraphSourceExcerpt,
  GraphSourceQuery,
  WorldGraphSnapshot,
};
