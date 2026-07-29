export type MemoryCutoffMode = 'latest' | 'custom' | 'none';

export interface MemoryCutoffState {
  mode: MemoryCutoffMode;
  customChapter: string;
}

export type MemoryCutoffAction =
  | { type: 'select'; mode: MemoryCutoffMode }
  | { type: 'custom'; value: string };

export function initialMemoryCutoffState(latestChapter: number | null): MemoryCutoffState {
  return {
    mode: latestChapter !== null && latestChapter > 0 ? 'latest' : 'none',
    customChapter: latestChapter === null ? '' : String(latestChapter),
  };
}

export function memoryCutoffReducer(
  state: MemoryCutoffState,
  action: MemoryCutoffAction,
): MemoryCutoffState {
  if (action.type === 'select') return { ...state, mode: action.mode };
  return { mode: 'custom', customChapter: action.value };
}

export function resolveMemoryCutoffChapter(
  state: MemoryCutoffState,
  latestChapter: number | null,
): number | undefined {
  if (state.mode === 'none') return undefined;
  if (state.mode === 'latest') return latestChapter ?? undefined;
  if (!/^[1-9]\d*$/.test(state.customChapter)) return undefined;
  const chapter = Number(state.customChapter);
  return Number.isSafeInteger(chapter) ? chapter : undefined;
}

export function isMemoryCutoffValid(
  state: MemoryCutoffState,
  latestChapter: number | null,
): boolean {
  return state.mode === 'none'
    || (state.mode === 'latest' && latestChapter !== null && latestChapter > 0)
    || (
      state.mode === 'custom'
      && /^[1-9]\d*$/.test(state.customChapter)
      && Number.isSafeInteger(Number(state.customChapter))
    );
}

export function formatPersonaLabel(persona: {
  characterName: string;
  memoryCutoffChapter?: number | undefined;
}): string {
  return persona.memoryCutoffChapter === undefined
    ? persona.characterName
    : `${persona.characterName} @≤${persona.memoryCutoffChapter}章`;
}
