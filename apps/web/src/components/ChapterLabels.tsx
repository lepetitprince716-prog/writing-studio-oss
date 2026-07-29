import type { ContentTreeLeaf, DocumentMeta } from '@writing-studio/contract';
import { formatChapterLabel } from '../lib/chapter-label.js';

export function TreeChapterLabel({
  chapter,
  chapterLeaf,
}: {
  chapter: DocumentMeta;
  chapterLeaf: ContentTreeLeaf | null | undefined;
}): React.JSX.Element {
  return <span>{formatChapterLabel(chapterLeaf, chapter.chapterNo, chapter.title)}</span>;
}

export function EditorChapterBadge({
  chapterNo,
  chapterLeaf,
}: {
  chapterNo: number;
  chapterLeaf: ContentTreeLeaf | null | undefined;
}): React.JSX.Element {
  return (
    <span className="chapter-badge">
      {formatChapterLabel(chapterLeaf, chapterNo)}
    </span>
  );
}
