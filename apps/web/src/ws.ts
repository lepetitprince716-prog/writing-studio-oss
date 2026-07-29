/**
 * WebSocket connection: feeds server envelopes into the store.
 * On seq gap or reconnect the sidebar/doc state is refetched via REST.
 * connectWs returns a disconnect function so callers (React effects) can tear
 * the socket down without triggering the auto-reconnect.
 */

import type { ServerEnvelope } from '@writing-studio/contract';
import { useStudio } from './store.js';
import { invalidateWorldGraph } from './graph/invalidation.js';

const GRAPH_TREE_REFRESH_DEBOUNCE_MS = 150;

let disconnectCurrent: (() => void) | null = null;
let graphTreeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGraphTreeRefresh(): void {
  if (graphTreeRefreshTimer !== null) clearTimeout(graphTreeRefreshTimer);
  graphTreeRefreshTimer = setTimeout(() => {
    graphTreeRefreshTimer = null;
    void useStudio.getState().refreshTree();
  }, GRAPH_TREE_REFRESH_DEBOUNCE_MS);
}

function cancelGraphTreeRefresh(): void {
  if (graphTreeRefreshTimer === null) return;
  clearTimeout(graphTreeRefreshTimer);
  graphTreeRefreshTimer = null;
}

export function applyServerEnvelope(envelope: ServerEnvelope): void {
  const store = useStudio.getState();
  switch (envelope.kind) {
    case 'agent':
      store.applyAgentEvent(
        envelope.runId,
        envelope.threadId,
        envelope.event,
        envelope.manifest,
      );
      break;
    case 'sidebar.updated':
      void store.refreshSidebar();
      break;
    case 'file.changed':
      // Never overwrite a dirty editor buffer on reconnect or external edit.
      // External chapter additions/removals also change both the tree-backed
      // stale-recap comparison and the visible chapter navigation.
      if (envelope.source === 'external') {
        void store.refreshSidebar();
        void store.refreshTree();
      }
      break;
    case 'git.changed':
      break;
    case 'graph.updated':
      invalidateWorldGraph();
      // This payload-free event is shared by the chapter-tree watcher and
      // graph-source writes, so the client cannot distinguish whether /tree
      // changed. Coalesce watcher/write bursts while still refreshing shortly
      // after an external chapter addition or removal.
      scheduleGraphTreeRefresh();
      break;
  }
}

export function connectWs(projectId: string): () => void {
  disconnectCurrent?.();
  let active = true;
  let socket: WebSocket | null = null;
  let reconnectTimer: number | null = null;
  let lastSeq = 0;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  const open = (): void => {
    if (!active) return;
    lastSeq = 0;
    const sock = new WebSocket(
      `${proto}://${location.host}/ws?projectId=${encodeURIComponent(projectId)}`,
    );
    socket = sock;

    sock.onopen = () => {
      // seq restarts at 1 on every socket. Durable REST state is authoritative
      // for any run/thread/sidebar events missed while disconnected.
      void useStudio.getState().recoverConnection();
      invalidateWorldGraph();
    };

    sock.onmessage = (msg) => {
      let envelope: ServerEnvelope;
      try {
        envelope = JSON.parse(String(msg.data)) as ServerEnvelope;
      } catch {
        return;
      }
      const gap = lastSeq !== 0 && envelope.seq !== lastSeq + 1;
      lastSeq = envelope.seq;
      if (gap) void useStudio.getState().recoverConnection();
      applyServerEnvelope(envelope);
    };

    sock.onclose = () => {
      if (!active || socket !== sock) return;
      reconnectTimer = window.setTimeout(() => {
        if (active && useStudio.getState().activeProjectId === projectId) open();
      }, 2000);
    };
  };

  const disconnect = (): void => {
    active = false;
    cancelGraphTreeRefresh();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
    if (disconnectCurrent === disconnect) disconnectCurrent = null;
  };
  disconnectCurrent = disconnect;
  open();
  return disconnect;
}
