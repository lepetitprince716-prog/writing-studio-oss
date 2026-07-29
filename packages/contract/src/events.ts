/**
 * WebSocket event contract. Single connection per client:
 *   ws://127.0.0.1:<port>/ws?projectId=<pid>
 * Server → client only; client-side writes go through REST.
 * Envelope `seq` starts at 1 and increases by exactly 1 for every envelope on
 * one connection. A new connection restarts at 1, so reconnect recovery must
 * refetch durable REST state; `seq` only detects loss within the live socket.
 */

import type { AgentEvent } from './agent.js';
import type { AgentId } from './models.js';
import type { ContextManifest } from './models.js';

export interface AgentStreamEnvelope {
  kind: 'agent';
  seq: number;
  runId: string;
  threadId: string;
  agentId: AgentId;
  event: AgentEvent;
  /** Writer-safe diagnostic data for the sources actually injected this run. */
  manifest?: ContextManifest | undefined;
}

export interface FileChangedEnvelope {
  kind: 'file.changed';
  seq: number;
  docId: string;
  sha256: string;
  /** 'panel' = our own write echo; 'external' = Obsidian/editor/git. */
  source: 'panel' | 'external';
}

export interface SidebarUpdatedEnvelope {
  kind: 'sidebar.updated';
  seq: number;
  sourceId: string;
}

/**
 * Cache invalidation only. Deliberately carries no names, paths, counts, view,
 * or version; clients must refetch the projection they are authorized to see.
 */
export interface GraphUpdatedEnvelope {
  kind: 'graph.updated';
  seq: number;
}

export interface GitChangedEnvelope {
  kind: 'git.changed';
  seq: number;
  dirtyCount: number;
}

export type ServerEnvelope =
  | AgentStreamEnvelope
  | FileChangedEnvelope
  | SidebarUpdatedEnvelope
  | GraphUpdatedEnvelope
  | GitChangedEnvelope;
