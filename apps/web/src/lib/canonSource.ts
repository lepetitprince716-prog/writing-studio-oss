import type { CanonSectionRef, SidebarSource } from '@writing-studio/contract';

export interface ResolvedCanonSource {
  docId: string;
  headingPrefix: string;
}

export interface CanonSourceReference {
  file: string;
  headingPrefix: string;
}

const CANON_SOURCE_REFERENCE_PATTERN =
  /^([^§\n]+?\.md)(?:\s*§\s*|\s+)([^\s/§（]+)/u;

export function parseCanonSourceReference(raw: string): CanonSourceReference | null {
  const match = CANON_SOURCE_REFERENCE_PATTERN.exec(raw.trim());
  const file = match?.[1]?.trim();
  const headingPrefix = match?.[2]?.trim();
  return file && headingPrefix ? { file, headingPrefix } : null;
}

/**
 * Resolve a table's source string into one configured canon source.
 *
 * Real vault values use `<file>.md [§]<token>`, optionally listing more
 * sections or files with `/`. Multi-file references are tried left-to-right.
 * Short file names only match a configured path segment or `_`-prefixed suffix.
 */
export function resolveCanonSource(
  raw: string,
  sources: readonly SidebarSource[],
): ResolvedCanonSource | null {
  const value = raw.trim();
  if (!value) return null;

  for (const part of value.split(/\s+\/\s+/u)) {
    const reference = parseCanonSourceReference(part);
    if (!reference) continue;
    const { file, headingPrefix } = reference;

    const candidates = sources.filter((source) =>
      source.file === file
      || source.file.endsWith(`/${file}`)
      || source.file.endsWith(`_${file}`),
    );
    const source = candidates.reduce<SidebarSource | undefined>(
      (shortest, candidate) =>
        shortest === undefined || candidate.file.length < shortest.file.length
          ? candidate
          : shortest,
      undefined,
    );
    if (source) return { docId: source.file, headingPrefix };
  }

  return null;
}

/** Map a source token to the first loaded heading with an approved prefix boundary. */
export function resolveCanonHeading(
  headingPrefix: string,
  sections: readonly CanonSectionRef[],
): string | null {
  const prefix = headingPrefix.trim();
  if (!prefix) return null;
  const boundaries = new Set(['', '.', ' ', '·', '：', '（']);
  for (const section of sections) {
    const heading = section.headingPath.at(-1)?.trim() ?? '';
    if (heading.startsWith(prefix) && boundaries.has(heading.slice(prefix.length, prefix.length + 1))) {
      return heading;
    }
  }
  return null;
}
