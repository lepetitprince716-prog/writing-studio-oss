import type { DocumentMeta } from '@writing-studio/contract';
import { onActivateKey } from '../lib/keyboard.js';
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
        <div className="muted draft-state">正在加载草稿…</div>
      ) : error ? (
        <div className="project-error draft-state">草稿加载失败：{error}</div>
      ) : drafts.length === 0 ? (
        <div className="muted draft-state">暂无草稿</div>
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
