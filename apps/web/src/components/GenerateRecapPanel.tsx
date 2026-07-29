import { useState } from 'react';
import type { ContentTreeLeaf, WritingStatusDto } from '@writing-studio/contract';
import { selectMaxChapterNo, selectWritingStatus } from '../lib/writingStatus.js';
import {
  formatChapterLabel,
  LEGACY_CHAPTER_LABEL_LEAF,
} from '../lib/chapter-label.js';
import { useStudio } from '../store.js';
import { Modal } from './Modal.js';

export type GenerateRecapPhase = 'setup' | 'session';

const STORAGE_KEYS: Record<GenerateRecapPhase, string> = {
  setup: 'ws-generate-recap-setup-collapsed',
  session: 'ws-generate-recap-session-collapsed',
};

const MORE_STORAGE_KEYS: Record<GenerateRecapPhase, string> = {
  setup: 'ws-generate-recap-setup-more-open',
  session: 'ws-generate-recap-session-more-open',
};

interface RecapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeLocalStorage(): RecapStorage | undefined {
  // Accessing the localStorage property itself throws when site data is
  // blocked (sandboxed frames, denied cookies), so the probe stays in try.
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readGenerateRecapCollapsed(
  phase: GenerateRecapPhase,
  storage: Pick<RecapStorage, 'getItem'> | undefined = safeLocalStorage(),
): boolean {
  const fallback = phase === 'session';
  if (!storage) return fallback;
  try {
    const stored = storage.getItem(STORAGE_KEYS[phase]);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    // Storage can be unavailable in privacy modes; retain the phase default.
  }
  return fallback;
}

export function persistGenerateRecapCollapsed(
  phase: GenerateRecapPhase,
  collapsed: boolean,
  storage: Pick<RecapStorage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEYS[phase], collapsed ? '1' : '0');
  } catch {
    // The panel remains usable when persistence is unavailable.
  }
}

export function readGenerateRecapMoreOpen(
  phase: GenerateRecapPhase,
  storage: Pick<RecapStorage, 'getItem'> | undefined = safeLocalStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(MORE_STORAGE_KEYS[phase]) === '1';
  } catch {
    return false;
  }
}

export function persistGenerateRecapMoreOpen(
  phase: GenerateRecapPhase,
  open: boolean,
  storage: Pick<RecapStorage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  try {
    storage?.setItem(MORE_STORAGE_KEYS[phase], open ? '1' : '0');
  } catch {
    // The disclosure remains usable when persistence is unavailable.
  }
}

export interface GenerateRecapPanelViewProps {
  status: WritingStatusDto | null;
  maxChapterNo: number | null;
  collapsed: boolean;
  sectionId?: string;
  moreOpen?: boolean;
  onToggle?: () => void;
  onToggleMore?: (open: boolean) => void;
  onOpenFullscreen?: () => void;
  chapterLeaf?: ContentTreeLeaf | null | undefined;
}

export interface GenerateRecapContent {
  stopPoint: string;
  storylines: WritingStatusDto['storylines'];
  characterOneLiners: WritingStatusDto['characterOneLiners'];
  activeForeshadow: WritingStatusDto['activeForeshadow'];
  redLines: string[];
  hasPrimary: boolean;
  hasMore: boolean;
  hasSections: boolean;
}

export function selectGenerateRecapContent(status: WritingStatusDto): GenerateRecapContent {
  const stopPoint = status.stopPoint.trim();
  const storylines = status.storylines
    .map((storyline) => ({ name: storyline.name.trim(), body: storyline.body.trim() }))
    .filter((storyline) => storyline.name || storyline.body);
  const characterOneLiners = status.characterOneLiners
    .map((character) => ({ name: character.name.trim(), text: character.text.trim() }))
    .filter((character) => character.name || character.text);
  const activeForeshadow = status.activeForeshadow
    .map((entry) => ({
      id: entry.id.trim(),
      content: entry.content.trim(),
      status: entry.status.trim(),
    }))
    .filter((entry) => entry.id || entry.content || entry.status);
  const redLines = status.redLines.map((line) => line.trim()).filter(Boolean);
  const hasPrimary = Boolean(stopPoint) || storylines.length > 0;
  const hasMore = characterOneLiners.length > 0
    || activeForeshadow.length > 0
    || redLines.length > 0;

  return {
    stopPoint,
    storylines,
    characterOneLiners,
    activeForeshadow,
    redLines,
    hasPrimary,
    hasMore,
    hasSections: hasPrimary || hasMore,
  };
}

function GenerateRecapSections({
  content,
  sections,
}: {
  content: GenerateRecapContent;
  sections: 'primary' | 'more' | 'all';
}): React.JSX.Element {
  const showPrimary = sections !== 'more';
  const showMore = sections !== 'primary';

  return (
    <>
      {showPrimary && content.stopPoint && (
        <section className="generate-recap-section">
          <div className="generate-recap-section-title" role="heading" aria-level={3}>刚刚发生</div>
          <p className="generate-recap-copy">{content.stopPoint}</p>
        </section>
      )}
      {showPrimary && content.storylines.length > 0 && (
        <section className="generate-recap-section">
          <div className="generate-recap-section-title" role="heading" aria-level={3}>故事线</div>
          <div className="generate-recap-storylines">
            {content.storylines.map((storyline, index) => (
              <div className="generate-recap-storyline" key={`${storyline.name}-${index}`}>
                {storyline.name && <strong>{storyline.name}</strong>}
                {storyline.body && <p className="generate-recap-copy">{storyline.body}</p>}
              </div>
            ))}
          </div>
        </section>
      )}
      {showMore && content.characterOneLiners.length > 0 && (
        <section className="generate-recap-section">
          <div className="generate-recap-section-title" role="heading" aria-level={3}>角色一句话</div>
          <dl className="generate-recap-pairs">
            {content.characterOneLiners.map((character, index) => (
              <div key={`${character.name}-${index}`}>
                <dt>{character.name}</dt>
                <dd>{character.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {showMore && content.activeForeshadow.length > 0 && (
        <section className="generate-recap-section">
          <div className="generate-recap-section-title" role="heading" aria-level={3}>活跃伏笔</div>
          <ul className="generate-recap-list">
            {content.activeForeshadow.map((entry, index) => (
              <li key={`${entry.id}-${index}`}>
                {entry.id && <strong>{entry.id}</strong>}
                {entry.content && <span>{entry.content}</span>}
                {entry.status && <em>{entry.status}</em>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {showMore && content.redLines.length > 0 && (
        <section className="generate-recap-section">
          <div className="generate-recap-section-title" role="heading" aria-level={3}>动笔前核对</div>
          <ol className="generate-recap-checklist">
            {content.redLines.map((line, index) => <li key={index}>{line}</li>)}
          </ol>
        </section>
      )}
    </>
  );
}

function hasRecapMeta(status: WritingStatusDto): boolean {
  // A stale hint requires stopChapter, so these two cover every meta element.
  return Boolean(status.lastRefreshed) || status.stopChapter !== null;
}

function GenerateRecapMeta({
  status,
  maxChapterNo,
  chapterLeaf,
}: {
  status: WritingStatusDto;
  maxChapterNo: number | null;
  chapterLeaf?: ContentTreeLeaf | null | undefined;
}): React.JSX.Element | null {
  const snapshotStale = status.stopChapter !== null
    && maxChapterNo !== null
    && maxChapterNo > status.stopChapter;
  if (!hasRecapMeta(status)) return null;

  return (
    <span className="generate-recap-meta">
      {status.lastRefreshed && <span>最后刷新 {status.lastRefreshed}</span>}
      {status.stopChapter !== null && (
        <span>
          停点{formatChapterLabel(chapterLeaf ?? LEGACY_CHAPTER_LABEL_LEAF, status.stopChapter)}
        </span>
      )}
      {snapshotStale && (
        <span className="generate-recap-stale">
          正文已至{formatChapterLabel(
            chapterLeaf ?? LEGACY_CHAPTER_LABEL_LEAF,
            maxChapterNo,
          )}，前情快照可能未刷新
        </span>
      )}
    </span>
  );
}

export function GenerateRecapFullView({
  status,
  maxChapterNo,
  chapterLeaf,
}: {
  status: WritingStatusDto | null;
  maxChapterNo: number | null;
  chapterLeaf?: ContentTreeLeaf | null | undefined;
}): React.JSX.Element | null {
  if (!status) return null;
  const content = selectGenerateRecapContent(status);
  const hasAnything = content.hasSections
    || Boolean(status.lastRefreshed)
    || status.stopChapter !== null;
  if (!hasAnything) return null;

  return (
    <article className="generate-recap-full">
      {hasRecapMeta(status) && (
        <div className="generate-recap-full-meta">
          <GenerateRecapMeta
            status={status}
            maxChapterNo={maxChapterNo}
            chapterLeaf={chapterLeaf}
          />
        </div>
      )}
      <GenerateRecapSections content={content} sections="all" />
    </article>
  );
}

export function GenerateRecapPanelView({
  status,
  maxChapterNo,
  collapsed,
  sectionId = 'generate-recap-panel',
  moreOpen = false,
  onToggle,
  onToggleMore,
  onOpenFullscreen,
  chapterLeaf,
}: GenerateRecapPanelViewProps): React.JSX.Element | null {
  if (!status) return null;
  const content = selectGenerateRecapContent(status);
  const hasAnything = content.hasSections
    || Boolean(status.lastRefreshed)
    || status.stopChapter !== null;
  if (!hasAnything) return null;

  return (
    <section className="generate-recap" aria-label="生成前情摘要">
      <div className="generate-recap-header">
        <button
          type="button"
          className="generate-recap-toggle"
          aria-expanded={!collapsed}
          aria-controls={`${sectionId}-body`}
          onClick={onToggle}
        >
          <span className="generate-recap-title">前情</span>
          <GenerateRecapMeta
            status={status}
            maxChapterNo={maxChapterNo}
            chapterLeaf={chapterLeaf}
          />
          <span className="generate-recap-affordance" aria-hidden="true">
            {collapsed ? '展开' : '收起'}
          </span>
        </button>
        <button
          type="button"
          className="generate-recap-fullscreen"
          aria-label="全屏查看前情"
          onClick={onOpenFullscreen}
        >
          全屏
        </button>
      </div>

      <div className="generate-recap-body" id={`${sectionId}-body`} hidden={collapsed}>
        {!collapsed && (
          <>
            <GenerateRecapSections content={content} sections="primary" />
            {content.hasMore && (
              <details
                className="generate-recap-more"
                open={moreOpen}
                onToggle={(event) => onToggleMore?.(event.currentTarget.open)}
              >
                <summary>更多</summary>
                <div className="generate-recap-more-body">
                  <GenerateRecapSections content={content} sections="more" />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function GenerateRecapPanel({
  phase,
}: {
  phase: GenerateRecapPhase;
}): React.JSX.Element | null {
  const sidebar = useStudio((state) => state.sidebar);
  const tree = useStudio((state) => state.tree);
  const chapterLeaf = useStudio((state) =>
    state.projects.find((project) => project.config.id === state.activeProjectId)
      ?.config.contentTree.leaf);
  const [collapsedByPhase, setCollapsedByPhase] = useState<Record<GenerateRecapPhase, boolean>>(
    () => ({
      setup: readGenerateRecapCollapsed('setup'),
      session: readGenerateRecapCollapsed('session'),
    }),
  );
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [moreOpenByPhase, setMoreOpenByPhase] = useState<Record<GenerateRecapPhase, boolean>>(
    () => ({
      setup: readGenerateRecapMoreOpen('setup'),
      session: readGenerateRecapMoreOpen('session'),
    }),
  );
  const collapsed = collapsedByPhase[phase];
  const status = selectWritingStatus(sidebar);
  const maxChapterNo = selectMaxChapterNo(tree);

  return (
    <>
      <GenerateRecapPanelView
        status={status}
        maxChapterNo={maxChapterNo}
        collapsed={collapsed}
        sectionId={`generate-recap-${phase}`}
        moreOpen={moreOpenByPhase[phase]}
        onToggle={() => {
          const next = !collapsed;
          setCollapsedByPhase((current) => ({ ...current, [phase]: next }));
          persistGenerateRecapCollapsed(phase, next);
        }}
        onToggleMore={(open) => {
          setMoreOpenByPhase((current) => ({ ...current, [phase]: open }));
          persistGenerateRecapMoreOpen(phase, open);
        }}
        onOpenFullscreen={() => setFullscreenOpen(true)}
        chapterLeaf={chapterLeaf}
      />
      <Modal
        open={fullscreenOpen}
        title="前情"
        className="modal-fullscreen"
        cancelText="关闭"
        onClose={() => setFullscreenOpen(false)}
      >
        <GenerateRecapFullView
          status={status}
          maxChapterNo={maxChapterNo}
          chapterLeaf={chapterLeaf}
        />
      </Modal>
    </>
  );
}
