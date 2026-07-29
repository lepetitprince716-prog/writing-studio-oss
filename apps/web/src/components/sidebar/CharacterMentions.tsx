import type { ContentTreeLeaf, MentionLocation } from '@writing-studio/contract';
import {
  formatChapterLabel,
  LEGACY_CHAPTER_LABEL_LEAF,
} from '../../lib/chapter-label.js';

export type MentionUiState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; locations: MentionLocation[] }
  | { status: 'error'; message: string };

export type MentionUiAction =
  | { type: 'load' }
  | { type: 'success'; locations: MentionLocation[] }
  | { type: 'error'; message: string };

export function mentionUiReducer(
  _state: MentionUiState,
  action: MentionUiAction,
): MentionUiState {
  if (action.type === 'load') return { status: 'loading' };
  if (action.type === 'success') return { status: 'success', locations: action.locations };
  return { status: 'error', message: action.message };
}

/** Server ordering is authoritative; only discard repeated docIds. */
export function normalizeMentions(locations: MentionLocation[]): MentionLocation[] {
  const seen = new Set<string>();
  return locations.filter((location) => {
    if (seen.has(location.docId)) return false;
    seen.add(location.docId);
    return true;
  });
}

export function MentionResults({
  state,
  onOpen,
  onRetry,
  chapterLeaf,
}: {
  state: MentionUiState;
  onOpen(docId: string): void;
  onRetry(): void;
  chapterLeaf?: ContentTreeLeaf | null | undefined;
}): React.JSX.Element | null {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return <div className="character-mentions-state" role="status">正在查找出现章节…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="character-mentions-state error" role="alert">
        <span>加载失败：{state.message}</span>
        <button className="btn-ghost" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (state.locations.length === 0) {
    return <div className="character-mentions-state muted">暂无出现章节</div>;
  }
  return (
    <div className="character-mentions-list">
      {state.locations.map((location) => (
        <button
          className="character-mention-link"
          key={location.docId}
          title={location.docId}
          onClick={() => onOpen(location.docId)}
        >
          {formatChapterLabel(
            chapterLeaf ?? LEGACY_CHAPTER_LABEL_LEAF,
            location.chapterNo,
          )} ×{location.count}
        </button>
      ))}
    </div>
  );
}
