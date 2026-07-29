/**
 * Text-quote anchors use JavaScript string offsets (UTF-16 code units).
 * Keeping this module pure makes re-anchoring safe to use both while saving
 * and while reading a document after an external edit.
 */

import DiffMatchPatch from 'diff-match-patch';
import type { Anchor, AnchorResolution } from '@writing-studio/contract';

const DEFAULT_CONTEXT_LENGTH = 32;
const FUZZY_THRESHOLD = 0.72;

export interface AnchorFingerprint {
  docSha: string;
  start: number;
  end: number;
  prefix: string;
  exact: string;
  suffix: string;
}

export function createAnchor(
  docSha: string,
  content: string,
  start: number,
  end: number,
  contextLength = DEFAULT_CONTEXT_LENGTH,
): Anchor {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > content.length) {
    throw new RangeError('anchor range must be a non-empty JavaScript UTF-16 range within content');
  }
  if (!Number.isInteger(contextLength) || contextLength < 0) {
    throw new RangeError('contextLength must be a non-negative integer');
  }
  return {
    docSha,
    start,
    end,
    prefix: content.slice(Math.max(0, start - contextLength), start),
    exact: content.slice(start, end),
    suffix: content.slice(end, end + contextLength),
  };
}

/** Alias used by persistence callers when refreshing an anchor after a save. */
export function refreshAnchorFingerprint(
  previous: Pick<Anchor, 'start' | 'end'>,
  docSha: string,
  content: string,
  contextLength = DEFAULT_CONTEXT_LENGTH,
): AnchorFingerprint {
  return createAnchor(docSha, content, previous.start, previous.end, contextLength);
}

function commonSuffixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

interface Candidate {
  start: number;
  end: number;
  score: number;
  context: number;
}

function contextScore(anchor: Anchor, content: string, start: number, end: number): number {
  const before = content.slice(Math.max(0, start - anchor.prefix.length), start);
  const after = content.slice(end, end + anchor.suffix.length);
  return commonSuffixLength(anchor.prefix, before) + commonPrefixLength(anchor.suffix, after);
}

function collectExactCandidates(anchor: Anchor, content: string): Candidate[] {
  const candidates: Candidate[] = [];
  let start = content.indexOf(anchor.exact);
  while (start !== -1) {
    const end = start + anchor.exact.length;
    candidates.push({ start, end, score: 1, context: contextScore(anchor, content, start, end) });
    start = content.indexOf(anchor.exact, start + 1);
  }
  return candidates;
}

function similarity(dmp: DiffMatchPatch, expected: string, actual: string): number {
  if (expected.length === 0 || actual.length === 0) return 0;
  const diffs = dmp.diff_main(expected, actual, false);
  const distance = dmp.diff_levenshtein(diffs);
  return Math.max(0, 1 - distance / Math.max(expected.length, actual.length));
}

function nearbyStarts(anchor: Anchor, content: string, dmp: DiffMatchPatch): number[] {
  const starts = new Set<number>();
  const originalLength = anchor.exact.length;
  const radius = Math.max(256, originalLength * 2);
  const lower = Math.max(0, anchor.start - radius);
  const upper = Math.min(content.length, anchor.start + radius);

  // A bounded scan makes short selections robust even when DMP's Bitap match
  // rejects an internal edit. Long selections use a denser local search plus
  // DMP seeds; scanning every offset for a multi-kilobyte quote is needlessly
  // expensive and produces no better result.
  if (originalLength <= 192) {
    for (let start = lower; start <= upper; start += 1) starts.add(start);
  } else {
    const localRadius = Math.max(32, Math.ceil(originalLength * 0.35) * 2);
    const step = Math.max(1, Math.floor(localRadius / 64));
    for (let delta = -localRadius; delta <= localRadius; delta += step) {
      const start = anchor.start + delta;
      if (start >= 0 && start <= content.length) starts.add(start);
    }
  }

  const seedLength = Math.min(24, originalLength);
  if (seedLength > 0) {
    for (const seedOffset of [0, Math.max(0, originalLength - seedLength), Math.floor((originalLength - seedLength) / 2)]) {
      const seed = anchor.exact.slice(seedOffset, seedOffset + seedLength);
      if (!seed) continue;
      let position = dmp.match_main(content, seed, Math.max(0, anchor.start + seedOffset));
      if (position !== -1) {
        starts.add(Math.max(0, position - seedOffset));
      }
    }
  }
  // diff-match-patch's Bitap implementation only accepts patterns up to its
  // Match_MaxBits limit (normally 32 UTF-16 code units). Seeds above cover
  // larger selections without throwing.
  if (anchor.exact.length <= dmp.Match_MaxBits) {
    const dmpStart = dmp.match_main(content, anchor.exact, anchor.start);
    if (dmpStart !== -1) starts.add(dmpStart);
  }
  return [...starts];
}

function findFuzzyCandidate(anchor: Anchor, content: string): Candidate | null {
  const dmp = new DiffMatchPatch();
  const originalLength = anchor.exact.length;
  const variation = Math.max(8, Math.ceil(originalLength * 0.35));
  const lengthStep = originalLength > 192 ? Math.max(1, Math.floor(variation / 24)) : 1;
  let best: Candidate | null = null;
  for (const start of nearbyStarts(anchor, content, dmp)) {
    if (start >= content.length) continue;
    for (let length = Math.max(1, originalLength - variation); length <= originalLength + variation; length += lengthStep) {
      const end = start + length;
      if (end > content.length) break;
      const score = similarity(dmp, anchor.exact, content.slice(start, end));
      if (score < FUZZY_THRESHOLD) continue;
      const candidate: Candidate = { start, end, score, context: contextScore(anchor, content, start, end) };
      if (
        !best
        || candidate.score > best.score
        || (candidate.score === best.score && candidate.context > best.context)
        || (candidate.score === best.score && candidate.context === best.context
          && Math.abs(candidate.start - anchor.start) < Math.abs(best.start - anchor.start))
      ) {
        best = candidate;
      }
    }
  }
  return best;
}

export function resolveAnchor(anchor: Anchor, content: string): AnchorResolution {
  const exact = collectExactCandidates(anchor, content);
  if (exact.length > 0) {
    exact.sort((left, right) =>
      Math.abs(left.start - anchor.start) - Math.abs(right.start - anchor.start)
      || right.context - left.context
      || left.start - right.start,
    );
    const match = exact[0]!;
    return { status: 'exact', start: match.start, end: match.end };
  }

  const fuzzy = findFuzzyCandidate(anchor, content);
  if (!fuzzy) return { status: 'lost' };
  return { status: 'fuzzy', start: fuzzy.start, end: fuzzy.end, score: fuzzy.score };
}
