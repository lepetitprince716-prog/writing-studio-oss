const NODE_COLOR_VAR: Record<string, string> = {
  character: '--graph-character',
  faction: '--graph-faction',
  place: '--graph-place',
  item: '--graph-item',
  event: '--graph-event',
  skill: '--graph-skill',
  species: '--graph-species',
  rule: '--graph-rule',
  foreshadow: '--graph-foreshadow',
  custom: '--graph-custom',
  unknown: '--graph-unknown',
};

const EDGE_COLOR_VAR: Record<string, string> = {
  affinity: '--graph-affinity',
  conflict: '--graph-conflict',
  kinship: '--graph-kinship',
  ownership: '--graph-ownership',
  location: '--graph-location',
  participation: '--graph-participation',
  knowledge: '--graph-knowledge',
  causality: '--graph-causality',
  constraint: '--graph-constraint',
  foreshadow: '--graph-foreshadow',
  custom: '--graph-custom',
};

function readColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || 'gray';
}

export function nodeColor(visualFamily: string): string {
  return readColor(NODE_COLOR_VAR[visualFamily] ?? NODE_COLOR_VAR['unknown']!);
}

export function edgeColor(visualFamily: string): string {
  return readColor(
    EDGE_COLOR_VAR[visualFamily]
      ?? NODE_COLOR_VAR[visualFamily]
      ?? EDGE_COLOR_VAR['custom']!,
  );
}

export function graphCanvasColor(kind: 'background' | 'fog'): string {
  return readColor(kind === 'background' ? '--graph-bg' : '--graph-surface');
}
