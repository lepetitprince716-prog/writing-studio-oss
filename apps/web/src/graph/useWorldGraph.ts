import { useCallback, useEffect, useState } from 'react';
import type { GraphView, WorldGraphSnapshot } from '@writing-studio/contract';
import { api } from '../api.js';
import { subscribeWorldGraphInvalidation } from './invalidation.js';

interface WorldGraphState {
  snapshot: WorldGraphSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

interface WorldGraphLoadState {
  requestKey: string;
  snapshot: WorldGraphSnapshot | null;
  loading: boolean;
  error: string | null;
}

export function useWorldGraph(projectId: string, view: GraphView): WorldGraphState {
  const [generation, setGeneration] = useState(0);
  const requestKey = `${projectId}\u0000${view}\u0000${generation}`;
  const [state, setState] = useState<WorldGraphLoadState>({
    requestKey: '',
    snapshot: null,
    loading: true,
    error: null,
  });
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => subscribeWorldGraphInvalidation(refresh), [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ requestKey, snapshot: null, loading: true, error: null });
    void api.getWorldGraph(projectId, view, controller.signal).then((next) => {
      if (!controller.signal.aborted) {
        setState({ requestKey, snapshot: next, loading: false, error: null });
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) {
        setState({
          requestKey,
          snapshot: null,
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });
    return () => controller.abort();
  }, [projectId, requestKey, view]);

  // Never expose a planner snapshot under a writer-safe label (or an old
  // project after switching projects), even for the render before the effect
  // above starts its replacement request.
  if (state.requestKey !== requestKey) {
    return { snapshot: null, loading: true, error: null, refresh };
  }
  return { snapshot: state.snapshot, loading: state.loading, error: state.error, refresh };
}
