interface CachedModels<T extends object> {
  at: number;
  binary: string;
  models: T[];
}

export function createCachedBinaryProbe<T extends object>(
  load: (binary: string) => Promise<T[]>,
  ttlMs = 60_000,
): (binary: string) => Promise<T[]> {
  let cache: CachedModels<T> | null = null;
  return async (binary) => {
    if (cache && cache.binary === binary && Date.now() - cache.at < ttlMs) {
      return cache.models.map((model) => ({ ...model }));
    }
    const models = await load(binary);
    cache = { at: Date.now(), binary, models };
    return models.map((model) => ({ ...model }));
  };
}
