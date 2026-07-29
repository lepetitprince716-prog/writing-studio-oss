import DiffMatchPatch from 'diff-match-patch';
import type {
  ProvenanceResponse,
  RevisionWithContent,
} from '@writing-studio/contract';
import { countManuscriptWords } from '@writing-studio/contract/word-count';

export { countManuscriptWords };

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

export function buildProvenance(
  docId: string,
  title: string,
  revisions: readonly RevisionWithContent[],
): ProvenanceResponse {
  // Equal createdAt values retain input order through stable sort; the store supplies insertion order.
  const ordered = [...revisions].sort((left, right) => left.createdAt - right.createdAt);
  const dmp = new DiffMatchPatch();
  let previous = '';

  const timeline = ordered.map((revision, index) => {
    const diffs = index === 0 ? [] : dmp.diff_main(previous, revision.content, false);
    let addedChars = 0;
    let deletedChars = 0;
    for (const [operation, content] of diffs as Array<[number, string]>) {
      if (operation === 1) addedChars += countCodePoints(content);
      if (operation === -1) deletedChars += countCodePoints(content);
    }
    previous = revision.content;
    return {
      revisionId: revision.id,
      kind: revision.kind,
      createdAt: revision.createdAt,
      wordCount: countManuscriptWords(revision.content),
      addedChars,
      deletedChars,
    };
  });

  const firstAi = ordered.find((revision) => revision.kind === 'ai_original');
  const firstAt = ordered[0]?.createdAt ?? 0;
  const lastAt = ordered.at(-1)?.createdAt ?? firstAt;
  const authorChangedChars = timeline.reduce((total, item) => {
    if (item.kind === 'ai_original') return total;
    return total + item.addedChars + item.deletedChars;
  }, 0);

  return {
    docId,
    title,
    summary: {
      aiDraftWordCount: firstAi ? countManuscriptWords(firstAi.content) : 0,
      authorChangedChars,
      revisionCount: timeline.length,
      timeSpanMs: Math.max(0, lastAt - firstAt),
    },
    revisions: timeline,
  };
}
