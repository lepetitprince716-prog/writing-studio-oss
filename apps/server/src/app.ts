import { resolve } from 'node:path';
import type { Socket } from 'node:net';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { AgentBackend, AgentId } from '@writing-studio/contract';
import { agentBackends, processSupervisor } from './agents/index.js';
import {
  loadAgentModelCatalogs,
  withAgentModelCatalogs,
} from './agents/models.js';
import {
  DEFAULT_DATA_DIR,
  getGenerateTimeoutMs,
  getRunTimeoutMs,
  loadProjects,
  type LoadedProject,
} from './config.js';
import { StoreManager } from './db/store.js';
import { localBoundaryViolation } from './local-boundary.js';
import { WorldGraphModule } from './graph/index.js';
import { registerRoutes } from './routes.js';
import { AgentCatalog, RunCoordinator } from './run.js';
import { SidebarService } from './sidebar/index.js';
import { broadcast, registerClient, terminateClients } from './ws.js';

export interface BuildAppOptions {
  dataDir?: string;
  registryPath?: string;
  logger?: FastifyServerOptions['logger'];
  watchSidebar?: boolean;
  backends?: ReadonlyMap<AgentId, AgentBackend>;
  /** Test-only/programmatic override; production uses WRITING_STUDIO_RUN_TIMEOUT_MS. */
  runTimeoutMs?: number;
  /** Test-only/programmatic override; production uses WRITING_STUDIO_GENERATE_TIMEOUT_MS. */
  generateTimeoutMs?: number;
  /** Test-only/programmatic override; production uses the lint module default. */
  slowRuleBudgetMs?: number;
}

function readyEntries(
  projects: Map<string, LoadedProject>,
): Array<[string, Extract<LoadedProject, { status: 'ready' }>]> {
  return [...projects.entries()].filter(
    (entry): entry is [string, Extract<LoadedProject, { status: 'ready' }>] =>
      entry[1].status === 'ready',
  );
}

/**
 * Build a fully wired server without binding a port. Tests use `inject()`;
 * production calls `listen()` from index.ts.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const dataRoot = resolve(options.dataDir ?? DEFAULT_DATA_DIR);
  const runTimeoutMs = options.runTimeoutMs ?? getRunTimeoutMs();
  const generateTimeoutMs = options.generateTimeoutMs ?? getGenerateTimeoutMs();
  const slowRuleBudgetMs = options.slowRuleBudgetMs;
  if (!Number.isInteger(runTimeoutMs) || runTimeoutMs <= 0 || runTimeoutMs > 2_147_483_647) {
    throw new Error('runTimeoutMs must be a positive 32-bit timer interval');
  }
  if (
    !Number.isInteger(generateTimeoutMs)
    || generateTimeoutMs <= 0
    || generateTimeoutMs > 2_147_483_647
  ) {
    throw new Error('generateTimeoutMs must be a positive 32-bit timer interval');
  }
  // Unlike the timeouts above, 0 is deliberately allowed: it is the only
  // deterministic way to make every rule report, which is how the route-level
  // slow-rule test triggers a warning without racing a real clock.
  if (
    slowRuleBudgetMs !== undefined
    && (
      !Number.isInteger(slowRuleBudgetMs)
      || slowRuleBudgetMs < 0
      || slowRuleBudgetMs > 2_147_483_647
    )
  ) {
    throw new Error('slowRuleBudgetMs must be a non-negative 32-bit timer interval');
  }
  const modelCatalogs = loadAgentModelCatalogs(dataRoot);
  const projects = loadProjects({
    dataDir: dataRoot,
    ...(options.registryPath === undefined ? {} : { registryPath: options.registryPath }),
  });
  const ready = readyEntries(projects);
  const app = Fastify({ logger: options.logger ?? false });
  const stores = new StoreManager(dataRoot, ready.map(([projectId]) => projectId), app.log);
  const sidebars = new Map<string, SidebarService>();
  const graphs = new Map<string, WorldGraphModule>();

  for (const [projectId] of ready) {
    stores.get(projectId);
    const sidebar = new SidebarService();
    sidebars.set(projectId, sidebar);
    const loaded = projects.get(projectId);
    if (loaded?.status === 'ready' && loaded.project.config.graph) {
      graphs.set(projectId, new WorldGraphModule(sidebar));
    }
  }

  const catalog = new AgentCatalog(withAgentModelCatalogs(
    options.backends ?? agentBackends,
    modelCatalogs,
  ));
  // `@fastify/websocket` owns protocol-level clients, while Fastify's HTTP
  // server owns the underlying TCP connections. Track both: an abrupt upgrade
  // can otherwise leave a half-closed transport outside WSS's normal close
  // handshake and make app.close wait indefinitely.
  const transportSockets = new Set<Socket>();
  app.server.on('connection', (socket) => {
    transportSockets.add(socket);
    socket.once('close', () => transportSockets.delete(socket));
  });
  // This is a browser/DNS-rebinding gate, not local-process authentication.
  // Keep it before the websocket plugin so upgrade requests get the same
  // Host/Origin validation as REST routes.
  app.addHook('onRequest', async (request, reply) => {
    if (!localBoundaryViolation(request.headers)) return;
    await reply.status(403).send({
      ok: false,
      error: { code: 'LOCAL_ONLY', message: 'localhost access required' },
    });
  });
  const runs = new RunCoordinator(
    projects,
    stores,
    catalog,
    dataRoot,
    (error) => {
      app.log.error({ err: error }, 'agent run failed');
    },
    runTimeoutMs,
    generateTimeoutMs,
  );

  await app.register(websocket, {
    // @fastify/websocket delegates client shutdown to a custom preClose.
    // Terminate first so a valid but idle browser socket cannot keep
    // `app.close()` open indefinitely; then close the plugin WSS as required
    // by its documented custom-hook contract.
    preClose(done) {
      try {
        terminateClients(this.websocketServer.clients);
        // The plugin's WSS is `noServer`; its close callback can remain
        // pending in CLOSE_WAIT even after every client has been terminated.
        // Follow the plugin's own custom-hook test: initiate close, then let
        // Fastify continue immediately to onClose/store shutdown.
        this.websocketServer.close();
        for (const socket of transportSockets) socket.destroy();
        transportSockets.clear();
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
  app.get<{ Querystring: { projectId?: string } }>(
    '/ws',
    { websocket: true },
    (socket, request) => {
      const projectId = request.query.projectId ?? '';
      const loaded = projects.get(projectId);
      if (!projectId || !loaded || loaded.status !== 'ready') {
        socket.close(1008, 'valid projectId is required');
        return;
      }
      registerClient(socket, projectId);
    },
  );

  registerRoutes(app, {
    projects,
    stores,
    sidebars,
    graphs,
    runs,
    ...(slowRuleBudgetMs === undefined ? {} : { slowRuleBudgetMs }),
  });

  let watchersStarted = false;
  app.addHook('onReady', async () => {
    if (options.watchSidebar === false || watchersStarted) return;
    watchersStarted = true;
    for (const [projectId, loaded] of ready) {
      const service = sidebars.get(projectId);
      if (!service) continue;
      service.startWatching(loaded.project, (sourceId) => {
        broadcast(projectId, { kind: 'sidebar.updated', sourceId });
      });
      const graph = graphs.get(projectId);
      if (graph) {
        graph.startWatching(
          loaded.project,
          () => broadcast(projectId, { kind: 'graph.updated' }),
          (error) => app.log.error({ err: error }, 'world graph watcher failed'),
        );
      }
    }
  });

  app.addHook('onClose', async () => {
    await runs.shutdown();
    await processSupervisor.shutdown();
    await Promise.allSettled([...sidebars.values()].map((service) => service.close()));
    await Promise.allSettled([...graphs.values()].map((graph) => graph.close()));
    stores.close();
  });

  return app;
}
