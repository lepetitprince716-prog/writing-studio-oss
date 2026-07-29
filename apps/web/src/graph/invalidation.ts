/**
 * Tiny invalidation seam between the long-lived WebSocket adapter and the
 * lazy WorldGraph workspace. It deliberately carries no graph data: REST is
 * authoritative after reconnects and `graph.updated` notifications.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function invalidateWorldGraph(): void {
  for (const listener of listeners) listener();
}

export function subscribeWorldGraphInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
