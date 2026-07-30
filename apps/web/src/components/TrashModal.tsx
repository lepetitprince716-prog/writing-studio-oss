import type { TrashEntry } from '@writing-studio/contract';
import { Empty, ErrorState, LoadingSkeleton } from './Empty.js';
import { Modal } from './Modal.js';

export function formatTrashDeletedAt(deletedAt: string): string {
  const date = new Date(deletedAt);
  if (Number.isNaN(date.getTime())) return deletedAt;
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatTrashDirectory(draftsDir: string): string {
  return `${draftsDir}/.trash/`;
}

export function buildTrashDeleteMessage(title: string, draftsDir: string): string {
  return `“${title}”将移至磁盘上的 ${formatTrashDirectory(draftsDir)} 文件夹。`;
}

export function TrashList({
  entries,
  loading,
  error,
  draftsDir,
  restoringDocId,
  onRestore,
}: {
  entries: TrashEntry[];
  loading: boolean;
  error: string | null;
  draftsDir: string;
  restoringDocId: string | null;
  onRestore(trashedDocId: string): void;
}): React.JSX.Element {
  return (
    <div className="trash-content">
      {loading ? (
        <LoadingSkeleton label="正在加载回收站" />
      ) : error ? (
        <ErrorState message={`回收站加载失败：${error}`} />
      ) : entries.length === 0 ? (
        <Empty text="回收站是空的" />
      ) : (
        <div className="trash-list">
          {entries.map((entry) => {
            const restoring = restoringDocId === entry.trashedDocId;
            const restoreBlocked = restoringDocId !== null;
            return (
              <div className="trash-item" key={entry.trashedDocId}>
                <div className="trash-item-copy">
                  <strong>{entry.originalName}</strong>
                  <span>{formatTrashDeletedAt(entry.deletedAt)}</span>
                </div>
                <button
                  className="btn"
                  disabled={restoreBlocked}
                  onClick={() => onRestore(entry.trashedDocId)}
                >
                  {restoring ? '正在恢复…' : '恢复'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <p className="muted trash-note">
        回收站文件保留在磁盘 <code>{formatTrashDirectory(draftsDir)}</code>，
        需要彻底清理请在文件管理器中手动删除。
      </p>
    </div>
  );
}

export function TrashModal({
  open,
  entries,
  loading,
  error,
  draftsDir,
  restoringDocId,
  onClose,
  onRestore,
}: {
  open: boolean;
  entries: TrashEntry[];
  loading: boolean;
  error: string | null;
  draftsDir: string;
  restoringDocId: string | null;
  onClose(): void;
  onRestore(trashedDocId: string): void;
}): React.JSX.Element | null {
  return (
    <Modal open={open} title="回收站" cancelText="关闭" onClose={onClose}>
      <TrashList
        entries={entries}
        loading={loading}
        error={error}
        draftsDir={draftsDir}
        restoringDocId={restoringDocId}
        onRestore={onRestore}
      />
    </Modal>
  );
}
