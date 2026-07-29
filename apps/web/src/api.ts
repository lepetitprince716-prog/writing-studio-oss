/**
 * Typed REST client over the contract. All calls go through the Vite proxy.
 */

import type {
  AgentAvailability,
  AgentId,
  Anchor,
  ApiResult,
  ChapterTree,
  ConflictCheckStartResponse,
  CreateRevisionRequest,
  DeleteDraftResponse,
  DocumentMeta,
  DraftListResponse,
  GetDocumentResponse,
  GetThreadResponse,
  GitStatus,
  GraphSourceExcerpt,
  GraphView,
  MentionLocation,
  LintResponse,
  ProjectListItem,
  ProvenanceResponse,
  RenameChapterTitleResponse,
  Revision,
  RevisionWithContent,
  Run,
  RestoreDraftResponse,
  SidebarPayload,
  SidebarView,
  Thread,
  ThreadKind,
  TrashListResponse,
  WorldGraphSnapshot,
} from '@writing-studio/contract';

class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // A JSON content type on a body-less request makes the server reject it as
  // an invalid (empty) JSON document, so only declare one alongside a body.
  const res = await fetch(path, {
    ...(init?.body !== undefined ? { headers: { 'Content-Type': 'application/json' } } : {}),
    ...init,
  });
  const body = (await res.json()) as ApiResult<T>;
  if (!body.ok) throw new ApiError(body.error.code, body.error.message);
  return body.data;
}

const enc = encodeURIComponent;

export const api = {
  listProjects: () => call<ProjectListItem[]>('/api/projects'),
  getTree: (pid: string) => call<ChapterTree>(`/api/projects/${enc(pid)}/tree`),
  listDrafts: (pid: string) =>
    call<DraftListResponse>(`/api/projects/${enc(pid)}/drafts`),
  deleteDraft: (pid: string, docId: string) =>
    call<DeleteDraftResponse>(`/api/projects/${enc(pid)}/drafts/${enc(docId)}`, {
      method: 'DELETE',
    }),
  listTrash: (pid: string) =>
    call<TrashListResponse>(`/api/projects/${enc(pid)}/drafts/trash`),
  restoreDraft: (pid: string, docId: string) =>
    call<RestoreDraftResponse>(
      `/api/projects/${enc(pid)}/drafts/${enc(docId)}/restore`,
      { method: 'POST' },
    ),
  getGitStatus: (pid: string) => call<GitStatus>(`/api/projects/${enc(pid)}/git-status`),
  // The canon sidebar is the human author's reference surface, so it requests
  // the planner view (author-only excerpts included). The AI agent context is
  // built server-side from the thread's own profile and is unaffected by this.
  getSidebar: (pid: string, view: SidebarView) =>
    call<SidebarPayload[]>(`/api/projects/${enc(pid)}/sidebar?view=${view}`),
  getWorldGraph: (pid: string, view: GraphView, signal?: AbortSignal) =>
    call<WorldGraphSnapshot>(
      `/api/projects/${enc(pid)}/graph?view=${view}`,
      signal ? { signal } : undefined,
    ),
  getGraphSource: (
    pid: string,
    docId: string,
    heading: string | null,
    view: GraphView,
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({ view });
    if (heading) query.set('heading', heading);
    return call<GraphSourceExcerpt>(
      `/api/projects/${enc(pid)}/sources/${enc(docId)}?${query.toString()}`,
      signal ? { signal } : undefined,
    );
  },
  listAgents: () => call<AgentAvailability[]>('/api/agents'),

  getDocument: (pid: string, docId: string) =>
    call<GetDocumentResponse>(`/api/projects/${enc(pid)}/documents/${enc(docId)}`),
  putDocument: (
    pid: string,
    docId: string,
    content: string,
    baseSha256: string,
    sourceThreadId?: string,
  ) =>
    call<DocumentMeta>(`/api/projects/${enc(pid)}/documents/${enc(docId)}`, {
      method: 'PUT',
      body: JSON.stringify({ content, baseSha256, ...(sourceThreadId ? { sourceThreadId } : {}) }),
    }),
  renameChapterTitle: (pid: string, docId: string, title: string, baseSha256: string) =>
    call<RenameChapterTitleResponse>(
      `/api/projects/${enc(pid)}/documents/${enc(docId)}/title`,
      {
        method: 'PATCH',
        body: JSON.stringify({ title, baseSha256 }),
      },
    ),
  createDraft: (pid: string, title: string) =>
    call<DocumentMeta>(`/api/projects/${enc(pid)}/documents`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
  /** Next-chapter creation. */
  createChapter: (pid: string, title: string) =>
    call<DocumentMeta>(`/api/projects/${enc(pid)}/chapters`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  getMentions: (pid: string, canonical: string) =>
    call<MentionLocation[]>(
      `/api/projects/${enc(pid)}/mentions/${enc(canonical)}`,
    ),

  listRevisions: (pid: string, docId: string) =>
    call<Revision[]>(`/api/projects/${enc(pid)}/documents/${enc(docId)}/revisions`),
  createRevision: (
    pid: string,
    docId: string,
    input: CreateRevisionRequest,
  ) =>
    call<Revision>(`/api/projects/${enc(pid)}/documents/${enc(docId)}/revisions`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getRevision: (rid: string) => call<RevisionWithContent>(`/api/revisions/${enc(rid)}`),
  lintDocument: (pid: string, docId: string) =>
    call<LintResponse>(`/api/projects/${enc(pid)}/lint`, {
      method: 'POST',
      body: JSON.stringify({ docId }),
    }),
  startConflictCheck: (
    pid: string,
    docId: string,
    input: { agentId?: AgentId; model?: string } = {},
  ) =>
    call<ConflictCheckStartResponse>(
      `/api/projects/${enc(pid)}/documents/${enc(docId)}/conflict-check`,
      { method: 'POST', body: JSON.stringify(input) },
    ),
  getProvenance: (pid: string, docId: string) =>
    call<ProvenanceResponse>(
      `/api/projects/${enc(pid)}/documents/${enc(docId)}/provenance`,
    ),

  listThreads: (pid: string, docId: string) =>
    call<Thread[]>(`/api/projects/${enc(pid)}/documents/${enc(docId)}/threads`),
  /** Project-level thread listing; chat threads are not bound to an open document. */
  listProjectThreads: (pid: string, kind: ThreadKind) =>
    call<Thread[]>(`/api/projects/${enc(pid)}/threads?kind=${enc(kind)}`),
  createThread: (input: {
    projectId: string;
    docId: string;
    kind: ThreadKind;
    anchor?: Anchor;
    agentId?: AgentId;
    profile?: 'writer' | 'planner';
    persona?: { characterName: string; memoryCutoffChapter?: number };
    origin?: 'generate' | 'check' | 'canon';
    headingPath?: string[];
    evidence?: { docId: string; textQuote: string };
  }) =>
    call<Thread>('/api/threads', { method: 'POST', body: JSON.stringify(input) }),
  getThread: (tid: string) => call<GetThreadResponse>(`/api/threads/${enc(tid)}`),
  patchThread: (tid: string, input: { agentId?: AgentId; title?: string; status?: Thread['status'] }) =>
    call<Thread>(`/api/threads/${enc(tid)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  postMessage: (tid: string, content: string, opts?: { agentId?: string; model?: string; wantRewrite?: boolean }) =>
    call<{ runId: string }>(`/api/threads/${enc(tid)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content, ...opts }),
    }),
  stopThread: (tid: string) =>
    call<{ stopped: boolean }>(`/api/threads/${enc(tid)}/stop`, { method: 'POST' }),
  getRun: (runId: string) => call<Run>(`/api/runs/${enc(runId)}`),
};

export { ApiError };
