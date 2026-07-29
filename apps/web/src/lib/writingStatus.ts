import type {
  ChapterTree,
  ChapterTreeNode,
  SidebarPayload,
  WritingStatusDto,
} from '@writing-studio/contract';

/** Select the first structured writing-status source in project order. */
export function selectWritingStatus(sidebar: SidebarPayload[]): WritingStatusDto | null {
  return sidebar.find(
    (payload): payload is Extract<SidebarPayload, { kind: 'writingStatus' }> =>
      payload.parser === 'heading-sections' && payload.kind === 'writingStatus',
  )?.data ?? null;
}

/** Highest structured chapter number currently present in the project tree. */
export function selectMaxChapterNo(tree: ChapterTree | null): number | null {
  if (!tree) return null;
  let max: number | null = null;

  const visit = (node: ChapterTreeNode): void => {
    for (const chapter of node.chapters) {
      if (chapter.chapterNo !== null && (max === null || chapter.chapterNo > max)) {
        max = chapter.chapterNo;
      }
    }
    node.children.forEach(visit);
  };

  visit(tree.root);
  return max;
}
