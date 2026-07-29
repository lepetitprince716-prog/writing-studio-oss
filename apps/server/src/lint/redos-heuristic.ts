export interface RedosHeuristicHit {
  index: number;
  reason: '分组体内存在量词' | '分组体内存在分支';
}

/**
 * Heuristic only: this flags a repeated group whose body contains another
 * quantifier or an alternation. It does not prove that an unflagged pattern is
 * safe. It misses cross-group polynomial amplification such as `.*.*`,
 * backreference-driven amplification, and every pathological pattern outside
 * the shape described above.
 *
 * It also over-reports in the other direction: an alternation inside a repeated
 * group is flagged even when the branches cannot overlap, so a warning means
 * "worth a second look", never "proven pathological".
 *
 * Expects a pattern that compiles; callers reach this through a schema that
 * already rejects the rest. Malformed input is scanned without crashing but
 * carries no accuracy promise.
 */
export function findNestedQuantifierRisk(pattern: string): RedosHeuristicHit | null {
  const groupStarts: number[] = [];
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === '(') {
      groupStarts.push(index);
      continue;
    }
    if (character !== ')') continue;

    const groupStart = groupStarts.pop();
    if (groupStart === undefined || !hasAmplifyingQuantifier(pattern, index + 1)) continue;
    const bodyStart = groupStart + groupPrefixLength(pattern, groupStart, index);
    const reason = riskyGroupBodyReason(pattern, bodyStart, index);
    if (reason !== null) return { index: groupStart, reason };
  }

  return null;
}

/**
 * Characters the group opener at `index` occupies, `(` included: `(?:`, `(?=`
 * and `(?!` take 3, `(?<=` and `(?<!` take 4, `(?<name>` runs through `>`, and
 * a plain `(` takes 1. Skipping the whole opener is what keeps the `?` and `<`
 * inside it from reading as body quantifiers.
 */
function groupPrefixLength(pattern: string, index: number, limit: number): number {
  if (pattern[index + 1] !== '?') return 1;
  const third = pattern[index + 2];
  if (third === ':' || third === '=' || third === '!') return 3;
  if (third !== '<') return 2;
  const fourth = pattern[index + 3];
  if (fourth === '=' || fourth === '!') return 4;
  // A group name always closes before the group does. Bounding the search keeps
  // a malformed opener from swallowing the body it was supposed to precede,
  // which would silently downgrade a real hit to no hit.
  const nameEnd = pattern.indexOf('>', index + 3);
  return nameEnd < 0 || nameEnd >= limit ? 2 : nameEnd - index + 1;
}

function hasAmplifyingQuantifier(pattern: string, index: number): boolean {
  const character = pattern[index];
  if (character === '*' || character === '+') return true;
  if (character !== '{') return false;

  const quantifier = /^\{[0-9]+,([0-9]*)\}/u.exec(pattern.slice(index));
  if (!quantifier) return false;
  const upperBound = quantifier[1];
  return upperBound === '' || Number(upperBound) > 1;
}

function riskyGroupBodyReason(
  pattern: string,
  start: number,
  end: number,
): RedosHeuristicHit['reason'] | null {
  let escaped = false;
  let inCharacterClass = false;

  for (let index = start; index < end; index += 1) {
    const character = pattern[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (character === ']') inCharacterClass = false;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === '(') {
      index += groupPrefixLength(pattern, index, end) - 1;
      continue;
    }
    if (character === '|') return '分组体内存在分支';
    if (character === '*' || character === '+' || character === '?') {
      return '分组体内存在量词';
    }
    if (
      character === '{'
      && /^\{[0-9]+(?:,[0-9]*)?\}/u.test(pattern.slice(index, end))
    ) {
      return '分组体内存在量词';
    }
  }

  return null;
}
