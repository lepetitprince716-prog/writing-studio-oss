import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import {
  createChapterRequestSchema,
  createDraftRequestSchema,
  deleteDraftParamsSchema,
  restoreDraftParamsSchema,
  createRevisionRequestSchema,
  createThreadRequestSchema,
  conflictCheckRequestSchema,
  lintRequestSchema,
  patchThreadRequestSchema,
  postMessageRequestSchema,
  projectThreadsQuerySchema,
  putDocumentRequestSchema,
  renameChapterTitleRequestSchema,
  graphQuerySchema,
  graphSourceQuerySchema,
  sidebarQuerySchema,
  type ApiErrorCode,
  type ApiResult,
} from '@writing-studio/contract';
import { createAnchor, resolveAnchor } from './anchors.js';
import {
  projectListItems,
  requireReadyProject,
  type LoadedProject,
} from './config.js';
import { StoreManager, StoreValidationError } from './db/store.js';
import { resolvePromptBundle } from './prompts/index.js';
import {
  isProfilePathAllowed,
  isProfileReadablePath,
  isWriterThreadDocumentAllowed,
  resolveChatPersona,
} from './context.js';
import { assertCanonAdoption, resolveWriterVisibleCanonSection } from './canon.js';
import { StudioError } from './errors.js';
import { readGitStatus } from './git.js';
import type { WorldGraphModule } from './graph/index.js';
import type { RunCoordinator } from './run.js';
import type { SidebarService } from './sidebar/index.js';
import { buildChapterTree, listChapterDocumentRefs } from './tree.js';
import {
  VaultError,
  createChapter,
  createDraft,
  deleteDraft,
  listDrafts,
  listTrash,
  readDocument,
  renameChapterTitle,
  restoreDraft,
  writeDocument,
} from './vault.js';
import { broadcast } from './ws.js';
import { chapterMentions } from './mentions.js';
import { lintText, loadSensitiveWords } from './lint.js';
import { buildProvenance } from './provenance.js';

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  NOT_FOUND: 404,
  STALE_WRITE: 409,
  CONFLICT: 409,
  PATH_ESCAPE: 400,
  INVALID_CONFIG: 422,
  VALIDATION: 400,
  UNPROCESSABLE: 422,
  THREAD_BUSY: 409,
  AGENT_UNAVAILABLE: 503,
  GRAPH_STOP_POINT_INVALID: 422,
  GRAPH_TOO_LARGE: 422,
  LOCAL_ONLY: 403,
  INTERNAL: 500,
};

function ok<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function fail(code: ApiErrorCode, message: string): ApiResult<never> {
  return { ok: false, error: { code, message } };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new StudioError('VALIDATION', result.error.message);
  return result.data;
}

export interface RouteDependencies {
  projects: Map<string, LoadedProject>;
  stores: StoreManager;
  sidebars: Map<string, SidebarService>;
  graphs: Map<string, WorldGraphModule>;
  runs: RunCoordinator;
  slowRuleBudgetMs?: number;
}

export function registerRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const requireProject = (projectId: string) => requireReadyProject(deps.projects, projectId);
  const requireSidebar = (projectId: string): SidebarService => {
    const service = deps.sidebars.get(projectId);
    if (!service) throw new StudioError('INVALID_CONFIG', `sidebar service unavailable: ${projectId}`);
    return service;
  };
  const requireGraph = (projectId: string): WorldGraphModule => {
    const graph = deps.graphs.get(projectId);
    if (!graph) throw new StudioError('NOT_FOUND', `world graph is not configured: ${projectId}`);
    return graph;
  };

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof StudioError || error instanceof VaultError) {
      void reply.status(HTTP_STATUS[error.code]).send(fail(error.code, error.message));
      return;
    }
    if (error instanceof StoreValidationError) {
      void reply.status(400).send(fail('VALIDATION', error.message));
      return;
    }
    if (
      error instanceof Error
      && 'statusCode' in error
      && (error as Error & { statusCode?: number }).statusCode === 400
    ) {
      void reply.status(400).send(fail('VALIDATION', 'invalid JSON request body'));
      return;
    }
    app.log.error(error);
    void reply.status(500).send(fail('INTERNAL', 'internal server error'));
  });

  app.get('/health', () => ok({
    uptime: process.uptime(),
    projects: [...deps.projects.values()].filter((project) => project.status === 'ready').length,
  }));

  app.get('/api/projects', () => ok(projectListItems(deps.projects)));

  app.get<{ Params: { pid: string } }>('/api/projects/:pid', (request) =>
    ok(requireProject(request.params.pid)),
  );

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/tree', (request) => {
    const project = requireProject(request.params.pid);
    return ok(buildChapterTree(project.vaultRoot, project.config));
  });

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/drafts', (request) => {
    const project = requireProject(request.params.pid);
    return ok(listDrafts(project.vaultRoot, project.config));
  });

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/drafts/trash', (request) => {
    const project = requireProject(request.params.pid);
    return ok(listTrash(project.vaultRoot, project.config));
  });

  app.delete<{ Params: unknown }>(
    '/api/projects/:pid/drafts/:docId',
    (request) => {
      const params = parse(deleteDraftParamsSchema, request.params);
      const project = requireProject(params.pid);
      return ok(deleteDraft(project.vaultRoot, project.config, params.docId));
    },
  );

  app.post<{ Params: unknown }>(
    '/api/projects/:pid/drafts/:docId/restore',
    (request) => {
      const params = parse(restoreDraftParamsSchema, request.params);
      const project = requireProject(params.pid);
      return ok(restoreDraft(project.vaultRoot, project.config, params.docId));
    },
  );

  app.get<{ Params: { pid: string; canonical: string } }>(
    '/api/projects/:pid/mentions/:canonical',
    (request) => {
      const project = requireProject(request.params.pid);
      // Alias lookups expose only canonical values already present in the
      // writer projection; absent and filtered entries intentionally look the same.
      return ok(chapterMentions(project, request.params.canonical));
    },
  );

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/git-status', async (request) => {
    const project = requireProject(request.params.pid);
    return ok(await readGitStatus(project.vaultRoot));
  });

  app.get<{ Params: { pid: string }; Querystring: unknown }>(
    '/api/projects/:pid/sidebar',
    (request) => {
      const project = requireProject(request.params.pid);
      const query = parse(sidebarQuerySchema, request.query);
      return ok(requireSidebar(project.config.id).getAll(project, query.view));
    },
  );

  app.get<{ Params: { pid: string }; Querystring: unknown }>(
    '/api/projects/:pid/graph',
    (request) => {
      const project = requireProject(request.params.pid);
      const query = parse(graphQuerySchema, request.query);
      return ok(requireGraph(project.config.id).getSnapshot(project, query.view));
    },
  );

  app.get<{ Params: { pid: string; docId: string }; Querystring: unknown }>(
    '/api/projects/:pid/sources/:docId',
    (request) => {
      const project = requireProject(request.params.pid);
      const query = parse(graphSourceQuerySchema, request.query);
      return ok(requireGraph(project.config.id).getSourceExcerpt(
        project,
        request.params.docId,
        query.heading,
        query.view,
      ));
    },
  );

  app.get<{ Params: { pid: string; sourceId: string }; Querystring: unknown }>(
    '/api/projects/:pid/sidebar/:sourceId',
    (request) => {
      const project = requireProject(request.params.pid);
      const query = parse(sidebarQuerySchema, request.query);
      const payload = requireSidebar(project.config.id).getSource(
        project,
        request.params.sourceId,
        query.view,
        query.q,
      );
      if (!payload) throw new StudioError('NOT_FOUND', 'sidebar source not found');
      return ok(payload);
    },
  );

  app.get<{ Params: { pid: string; docId: string } }>(
    '/api/projects/:pid/documents/:docId',
    (request) => {
      const project = requireProject(request.params.pid);
      const docId = request.params.docId;
      const { meta, content } = readDocument(project.vaultRoot, project.config, docId);
      const anchors = deps.stores
        .get(project.config.id)
        .listThreadsForDoc(docId)
        .filter((thread) => thread.status === 'open' && thread.anchor !== null)
        .map((thread) => ({
          threadId: thread.id,
          anchor: thread.anchor!,
          resolution: resolveAnchor(thread.anchor!, content),
        }));
      return ok({ doc: meta, content, anchors });
    },
  );

  app.put<{ Params: { pid: string; docId: string }; Body: unknown }>(
    '/api/projects/:pid/documents/:docId',
    (request) => {
      const project = requireProject(request.params.pid);
      const docId = request.params.docId;
      const body = parse(putDocumentRequestSchema, request.body);
      let canonAdoption: { threadId: string; start: number; end: number } | null = null;
      if (body.sourceThreadId) {
        const located = deps.stores.findThread(body.sourceThreadId);
        if (
          !located
          || located.thread.projectId !== project.config.id
          || located.thread.docId !== docId
        ) {
          throw new StudioError('VALIDATION', 'canon source thread does not match this document');
        }
        const current = readDocument(project.vaultRoot, project.config, docId);
        canonAdoption = {
          threadId: located.thread.id,
          ...assertCanonAdoption(located.thread, current.content, body.content),
        };
      }
      const meta = writeDocument(
        project.vaultRoot,
        project.config,
        docId,
        body.content,
        body.baseSha256,
      );
      try {
        const store = deps.stores.get(project.config.id);
        store.updateAnchorsForDocument(docId, meta.sha256, body.content);
        if (canonAdoption) {
          store.replaceThreadAnchor(
            canonAdoption.threadId,
            docId,
            createAnchor(meta.sha256, body.content, canonAdoption.start, canonAdoption.end),
          );
        }
      } catch (error) {
        app.log.error({ err: error, docId }, 'document saved but anchor refresh failed');
      }
      broadcast(project.config.id, {
        kind: 'file.changed',
        docId,
        sha256: meta.sha256,
        source: 'panel',
      });
      if (project.config.graph?.relationsFile === docId) {
        const graph = requireGraph(project.config.id);
        graph.notePanelWrite(project);
        broadcast(project.config.id, { kind: 'graph.updated' });
      }
      return ok(meta);
    },
  );

  app.patch<{ Params: { pid: string; docId: string }; Body: unknown }>(
    '/api/projects/:pid/documents/:docId/title',
    (request) => {
      const project = requireProject(request.params.pid);
      const docId = request.params.docId;
      const body = parse(renameChapterTitleRequestSchema, request.body);
      if (!listChapterDocumentRefs(project.vaultRoot, project.config).some(
        (chapter) => chapter.docId === docId,
      )) {
        throw new StudioError(
          'UNPROCESSABLE',
          'only documents in the configured chapter tree can be renamed',
        );
      }
      const { meta, content } = renameChapterTitle(
        project.vaultRoot,
        project.config,
        docId,
        body.title,
        body.baseSha256,
      );
      try {
        deps.stores.get(project.config.id).updateAnchorsForDocument(docId, meta.sha256, content);
      } catch (error) {
        app.log.error({ err: error, docId }, 'chapter renamed but anchor refresh failed');
      }
      broadcast(project.config.id, {
        kind: 'file.changed',
        docId,
        sha256: meta.sha256,
        source: 'panel',
      });
      return ok({ sha256: meta.sha256, doc: meta });
    },
  );

  app.post<{ Params: { pid: string }; Body: unknown }>(
    '/api/projects/:pid/documents',
    (request) => {
      const project = requireProject(request.params.pid);
      const body = parse(createDraftRequestSchema, request.body);
      return ok(createDraft(project.vaultRoot, project.config, body.title));
    },
  );

  app.post<{ Params: { pid: string }; Body: unknown }>(
    '/api/projects/:pid/chapters',
    (request) => {
      const project = requireProject(request.params.pid);
      const body = parse(createChapterRequestSchema, request.body);
      const meta = createChapter(
        project.vaultRoot,
        project.config,
        body.title,
        body.dirOverride,
      );
      broadcast(project.config.id, {
        kind: 'file.changed',
        docId: meta.docId,
        sha256: meta.sha256,
        source: 'panel',
      });
      return ok(meta);
    },
  );

  app.post<{ Params: { pid: string }; Body: unknown }>(
    '/api/projects/:pid/lint',
    (request) => {
      const project = requireProject(request.params.pid);
      const body = parse(lintRequestSchema, request.body);
      const { meta, content } = readDocument(project.vaultRoot, project.config, body.docId);
      return ok({
        docId: body.docId,
        sha256: meta.sha256,
        findings: lintText(
          content,
          loadSensitiveWords(project.vaultRoot),
          project.config,
          {
            ...(deps.slowRuleBudgetMs === undefined
              ? {}
              : { slowRuleBudgetMs: deps.slowRuleBudgetMs }),
            onSlowRule: ({ ruleId, elapsedMs }) => app.log.warn(
              { ruleId, elapsedMs, docId: body.docId },
              'lint rule exceeded its time budget; review .writing-studio/project.json lint.styleRules patterns',
            ),
          },
        ),
      });
    },
  );

  app.get<{ Params: { pid: string; docId: string } }>(
    '/api/projects/:pid/documents/:docId/revisions',
    (request) => {
      const project = requireProject(request.params.pid);
      readDocument(project.vaultRoot, project.config, request.params.docId);
      return ok(deps.stores.get(project.config.id).listRevisions(request.params.docId));
    },
  );

  app.get<{ Params: { pid: string; docId: string } }>(
    '/api/projects/:pid/documents/:docId/provenance',
    (request) => {
      const project = requireProject(request.params.pid);
      const { meta } = readDocument(project.vaultRoot, project.config, request.params.docId);
      const revisions = deps.stores
        .get(project.config.id)
        .listRevisionsWithContent(request.params.docId);
      return ok(buildProvenance(request.params.docId, meta.title, revisions));
    },
  );

  app.post<{ Params: { pid: string; docId: string }; Body: unknown }>(
    '/api/projects/:pid/documents/:docId/revisions',
    (request) => {
      const project = requireProject(request.params.pid);
      readDocument(project.vaultRoot, project.config, request.params.docId);
      const body = parse(createRevisionRequestSchema, request.body);
      return ok(
        deps.stores.get(project.config.id).createRevision({
          docId: request.params.docId,
          kind: body.kind,
          content: body.content,
          sourceThreadId: body.sourceThreadId ?? null,
          label: body.label ?? null,
        }),
      );
    },
  );

  app.get<{ Params: { rid: string } }>('/api/revisions/:rid', (request) => {
    const located = deps.stores.findRevision(request.params.rid);
    if (!located) throw new StudioError('NOT_FOUND', 'revision not found');
    return ok(located.revision);
  });

  // A client that reconnects after a WebSocket gap can recover the durable
  // terminal state and bounded CLI-owned diagnostic here.
  app.get<{ Params: { runId: string } }>('/api/runs/:runId', (request) => {
    const located = deps.stores.findRun(request.params.runId);
    if (!located) throw new StudioError('NOT_FOUND', 'run not found');
    return ok(located.run);
  });

  app.get<{ Params: { pid: string; docId: string } }>(
    '/api/projects/:pid/documents/:docId/threads',
    (request) => {
      const project = requireProject(request.params.pid);
      readDocument(project.vaultRoot, project.config, request.params.docId);
      return ok(deps.stores.get(project.config.id).listThreadsForDoc(request.params.docId));
    },
  );

  app.post<{ Params: { pid: string; docId: string }; Body: unknown }>(
    '/api/projects/:pid/documents/:docId/conflict-check',
    (request) => {
      const project = requireProject(request.params.pid);
      readDocument(project.vaultRoot, project.config, request.params.docId);
      if (!isProfilePathAllowed(project, 'writer', request.params.docId)) {
        throw new StudioError('VALIDATION', 'document is not readable by the writer profile');
      }
      const body = parse(conflictCheckRequestSchema, request.body ?? {});
      const store = deps.stores.get(project.config.id);
      const existing = store.listThreadsForDoc(request.params.docId).find(
        (thread) => thread.status === 'open' && thread.kind === 'ask' && thread.origin === 'check',
      );
      const thread = existing ?? store.createThread({
        docId: request.params.docId,
        kind: 'ask',
        anchor: null,
        agentId: body.agentId ?? project.config.defaultAgentId,
        profile: 'writer',
        origin: 'check',
        title: '正典冲突检查',
      });
      const { runId } = deps.runs.start(
        thread.id,
        resolvePromptBundle(project.config).conflictCheckUserMessage,
        body.agentId,
        false,
        body.model,
      );
      return ok({ threadId: thread.id, runId });
    },
  );

  app.get<{ Params: { pid: string }; Querystring: unknown }>(
    '/api/projects/:pid/threads',
    (request) => {
      const project = requireProject(request.params.pid);
      const query = parse(projectThreadsQuerySchema, request.query);
      return ok(deps.stores.get(project.config.id).listThreadsByKind(query.kind));
    },
  );

  app.post<{ Body: unknown }>('/api/threads', (request) => {
    const body = parse(createThreadRequestSchema, request.body);
    const project = requireProject(body.projectId);
    if (body.kind === 'chat') {
      const resolved = resolveChatPersona(
        project,
        requireSidebar(project.config.id),
        body.docId,
        body.persona!,
      );
      return ok(
        deps.stores.get(project.config.id).createThread({
          docId: body.docId,
          kind: 'chat',
          anchor: null,
          agentId: body.agentId ?? project.config.defaultAgentId,
          profile: 'writer',
          persona: resolved.persona,
        }),
      );
    }
    const profile = body.origin === 'generate' || body.origin === 'canon'
      ? 'writer'
      : body.profile ?? project.config.aiProfiles.defaultProfile;
    const canonRequest = body.origin === 'canon';
    if (
      canonRequest
        ? !isProfileReadablePath(project, 'writer', body.docId)
        : !isProfilePathAllowed(project, profile, body.docId)
    ) {
      throw new StudioError(
        'VALIDATION',
        `document is not readable by the ${profile} profile`,
      );
    }
    const document = readDocument(project.vaultRoot, project.config, body.docId);
    let anchor = null;
    let canon = null;
    if (canonRequest) {
      const target = resolveWriterVisibleCanonSection(
        project,
        requireSidebar(project.config.id),
        body.docId,
        document.content,
        document.meta.sha256,
        body.headingPath!,
      );
      if (
        body.anchor!.docSha !== target.anchor.docSha
        || body.anchor!.start !== target.anchor.start
        || body.anchor!.end !== target.anchor.end
        || body.anchor!.exact !== target.anchor.exact
      ) {
        throw new StudioError('STALE_WRITE', 'canon repair section changed; refresh the canon sidebar');
      }
      if (body.evidence) {
        if (
          !isWriterThreadDocumentAllowed(project, body.evidence.docId)
          || !isProfilePathAllowed(project, 'writer', body.evidence.docId)
        ) {
          throw new StudioError('VALIDATION', 'canon evidence is unavailable');
        }
        const evidenceDocument = readDocument(
          project.vaultRoot,
          project.config,
          body.evidence.docId,
        );
        if (!evidenceDocument.content.includes(body.evidence.textQuote)) {
          throw new StudioError('VALIDATION', 'canon evidence is unavailable');
        }
      }
      anchor = createAnchor(
        document.meta.sha256,
        document.content,
        target.anchor.start,
        target.anchor.end,
      );
      canon = {
        headingPath: [...body.headingPath!],
        ...(body.evidence ? { evidence: body.evidence } : {}),
      };
    } else if (body.anchor) {
      if (body.anchor.docSha !== document.meta.sha256) {
        throw new StudioError('STALE_WRITE', 'save or reopen the document before creating a thread');
      }
      if (document.content.slice(body.anchor.start, body.anchor.end) !== body.anchor.exact) {
        throw new StudioError('VALIDATION', 'anchor does not match the saved document');
      }
      anchor = createAnchor(
        document.meta.sha256,
        document.content,
        body.anchor.start,
        body.anchor.end,
      );
    }
    return ok(
      deps.stores.get(project.config.id).createThread({
        docId: body.docId,
        kind: body.kind,
        anchor,
        agentId: body.agentId ?? project.config.defaultAgentId,
        profile,
        origin: body.origin ?? null,
        canon,
      }),
    );
  });

  app.get<{ Params: { tid: string } }>('/api/threads/:tid', (request) => {
    const located = deps.stores.findThread(request.params.tid);
    if (!located) throw new StudioError('NOT_FOUND', 'thread not found');
    return ok({ thread: located.thread, messages: located.store.getMessages(located.thread.id) });
  });

  app.patch<{ Params: { tid: string }; Body: unknown }>('/api/threads/:tid', (request) => {
    const located = deps.stores.findThread(request.params.tid);
    if (!located) throw new StudioError('NOT_FOUND', 'thread not found');
    const patch = parse(patchThreadRequestSchema, request.body);
    const mutable: Parameters<typeof located.store.patchThread>[1] = {};
    if (patch.status !== undefined) mutable.status = patch.status;
    if (patch.agentId !== undefined) mutable.agentId = patch.agentId;
    if (patch.title !== undefined) mutable.title = patch.title;
    const thread = located.store.patchThread(located.thread.id, mutable);
    if (!thread) throw new StudioError('NOT_FOUND', 'thread not found');
    return ok(thread);
  });

  app.post<{ Params: { tid: string }; Body: unknown }>(
    '/api/threads/:tid/messages',
    (request) => {
      const body = parse(postMessageRequestSchema, request.body);
      return ok(deps.runs.start(
        request.params.tid,
        body.content,
        body.agentId,
        body.wantRewrite ?? false,
        body.model,
      ));
    },
  );

  app.post<{ Params: { tid: string } }>('/api/threads/:tid/stop', (request) =>
    ok({ stopped: deps.runs.stop(request.params.tid) }),
  );

  app.get('/api/agents', async () => ok(await deps.runs.agents.listAvailability()));
}
