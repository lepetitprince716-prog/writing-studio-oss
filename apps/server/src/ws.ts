/**
 * WebSocket hub: one connection per client, server→client envelopes with
 * per-connection monotonically increasing seq. A reconnect starts a new
 * sequence, so clients recover durable state via REST on every reconnect.
 */

import type { WebSocket } from 'ws';
import type { ServerEnvelope } from '@writing-studio/contract';

interface Client {
  socket: WebSocket;
  projectId: string;
  seq: number;
}

const clients = new Set<Client>();

export function registerClient(socket: WebSocket, projectId: string): void {
  const client: Client = { socket, projectId, seq: 0 };
  clients.add(client);
  socket.on('close', () => clients.delete(client));
  socket.on('error', () => clients.delete(client));
}

/**
 * Drain both our project/sequence hub and the plugin's complete client set
 * before Fastify closes its HTTP server. `terminate()` is deliberate: a client
 * that never completes the WebSocket close handshake must not block shutdown
 * and therefore SQLite/store closure.
 */
export function terminateClients(pluginClients?: Iterable<WebSocket>): void {
  const sockets = new Set<WebSocket>();
  for (const client of clients) {
    sockets.add(client.socket);
    clients.delete(client);
  }
  if (pluginClients) {
    for (const socket of pluginClients) sockets.add(socket);
  }
  for (const socket of sockets) {
    try {
      socket.terminate();
    } catch {
      // A concurrently-closing client is already drained.
    }
  }
}

/** Omit that distributes over union members (plain Omit collapses unions). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function broadcast(
  projectId: string,
  envelope: DistributiveOmit<ServerEnvelope, 'seq'>,
): void {
  for (const client of clients) {
    if (client.projectId !== projectId) continue;
    client.seq += 1;
    const payload = JSON.stringify({ ...envelope, seq: client.seq });
    try {
      client.socket.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}
