import type { ConflictFinding } from '@writing-studio/contract';

export type ConflictSeverity = ConflictFinding['severity'];

const SEVERITY_ORDER: ConflictSeverity[] = ['high', 'medium', 'low'];

export function groupConflictFindings(
  findings: ConflictFinding[],
): Array<[ConflictSeverity, ConflictFinding[]]> {
  const grouped = new Map<ConflictSeverity, ConflictFinding[]>();
  for (const finding of findings) {
    const entries = grouped.get(finding.severity) ?? [];
    entries.push(finding);
    grouped.set(finding.severity, entries);
  }
  return SEVERITY_ORDER.flatMap((severity) => {
    const entries = grouped.get(severity);
    return entries ? [[severity, entries] as [ConflictSeverity, ConflictFinding[]]] : [];
  });
}

export function conflictCheckButtonState(input: {
  hasDocument: boolean;
  starting: boolean;
  running: boolean;
}): { disabled: boolean; label: string } {
  if (input.starting) return { disabled: true, label: '启动中…' };
  if (input.running) return { disabled: true, label: '检查中…' };
  return { disabled: !input.hasDocument, label: '查冲突' };
}
