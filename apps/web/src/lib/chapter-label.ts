import type { ContentTreeLeaf } from '@writing-studio/contract';
import { renderTitleTemplate } from '@writing-studio/contract/chapter-label';

export const LEGACY_CHAPTER_LABEL_LEAF: ContentTreeLeaf = {
  filePattern: '第{num}章.md',
  numberStyle: 'arabic',
  titleTemplate: '第{num}章 {title}',
  numberingScope: 'book',
  titleStripRegex: null,
};

/**
 * Formats project data as a chapter label without letting malformed project
 * configuration take down the surrounding UI.
 */
export function formatChapterLabel(
  leaf: ContentTreeLeaf | null | undefined,
  chapterNo: number | null,
  title?: string,
): string {
  if (chapterNo === null) return title ?? '';
  try {
    // A missing leaf (project data not loaded) falls back to the legacy
    // template so the chapter number is never silently dropped.
    const effectiveLeaf = !leaf || leaf.titleTemplate == null
      ? LEGACY_CHAPTER_LABEL_LEAF
      : leaf;
    const rendered = renderTitleTemplate(
      effectiveLeaf.titleTemplate,
      chapterNo,
      title ?? '',
      effectiveLeaf.numberStyle,
    );
    return title === undefined ? rendered.trim() : rendered;
  } catch {
    return title ?? '';
  }
}
