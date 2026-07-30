import type { DocumentMeta } from '@writing-studio/contract';
import { onActivateKey } from '../lib/keyboard.js';
import { Empty, ErrorState, LoadingSkeleton } from './Empty.js';
import { FileTextIcon } from './icons.js';

export function DraftSection({
  drafts,
  loading,
  error,
  activeDocId,
  onOpen,
  onOpenTrash,
  onContextMenu,
  onContextMenuKeyDown,
}: {
  drafts: DocumentMeta[];
  loading: boolean;
  error: string | null;
  activeDocId: string | undefined;
  onOpen(docId: string): void;
  onOpenTrash(): void;
  onContextMenu(event: React.MouseEvent, draft: DocumentMeta): void;
  onContextMenuKeyDown?(event: React.KeyboardEvent, draft: DocumentMeta): void;
}): React.JSX.Element {
  return (
    <section className="draft-section" aria-label="草稿">
      <div className="draft-section-header">
        <div className="tree-section-label">草稿</div>
        <button className="draft-trash-link" onClick={onOpenTrash}>回收站</button>
      </div>
      {loading ? (
        <LoadingSkeleton label="正在加载草稿" />
      ) : error ? (
        <ErrorState message={`草稿加载失败：${error}`} />
      ) : drafts.length === 0 ? (
        <Empty icon={<FileTextIcon size={22} />} text="暂无草稿" />
      ) : drafts.map((draft) => (
        <div
          key={draft.docId}
          className={draft.docId === activeDocId ? 'tree-chapter active' : 'tree-chapter'}
          role="button"
          tabIndex={0}
          aria-current={draft.docId === activeDocId ? 'true' : undefined}
          onClick={() => onOpen(draft.docId)}
          onKeyDown={(event) => {
            onActivateKey(() => onOpen(draft.docId))(event);
            onContextMenuKeyDown?.(event, draft);
          }}
          onContextMenu={(event) => onContextMenu(event, draft)}
        >
          <FileTextIcon size={14} className="tree-chapter-icon" />
          <span>{draft.title}</span>
        </div>
      ))}
    </section>
  );
}
