/** Shared portal-based context menu and its local state hook. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContentTreeLeaf, DocumentMeta } from '@writing-studio/contract';
import { formatChapterLabel } from '../lib/chapter-label.js';

export interface ContextMenuItem {
  id: string;
  label: string;
  /** Returned promises are deliberately not awaited by the menu. */
  onSelect: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  hint?: string;
}

export interface ContextMenuSeparator {
  id: string;
  separator: true;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

export interface ContextMenuSpec {
  label: string;
  items: ContextMenuEntry[];
}

export interface ContextMenuOpenState extends ContextMenuSpec {
  anchor: { x: number; y: number } | { rect: DOMRect };
  via: 'pointer' | 'keyboard';
  restoreTo: HTMLElement | null;
}

export interface ChapterMenuActions {
  open(docId: string): void | Promise<void>;
  openDocumentThen(docId: string, then: 'revisions' | 'wholeDocThread'): void | Promise<void>;
  renameChapter(chapter: DocumentMeta): void | Promise<void>;
  copyTitle(title: string): void | Promise<void>;
  copyPath(docId: string): void | Promise<void>;
}

export interface DraftMenuActions {
  open(docId: string): void | Promise<void>;
  openDocumentThen(docId: string, then: 'wholeDocThread'): void | Promise<void>;
  copyTitle(title: string): void | Promise<void>;
  copyPath(docId: string): void | Promise<void>;
  deleteDraft(draft: DocumentMeta): void | Promise<void>;
}

const NATIVE_MENU_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], .cm-editor, a[href]';
const VIEWPORT_GAP = 8;
const POINTER_OFFSET = 2;

export function isContextMenuOpenKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey'>): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

function disabledReason(running: boolean): string | undefined {
  return running ? 'AI 运行中，无法切换文档' : undefined;
}

export function withDisabledReason(
  item: ContextMenuItem,
  reason: string | undefined,
): ContextMenuItem {
  // Invariant: a present reason always forces disabled — it deliberately
  // overrides any explicit disabled value on the item.
  return reason ? { ...item, disabled: true, disabledReason: reason } : item;
}

/** Pure chapter-node spec factory; actions are supplied so the result is easy to test. */
export function createChapterMenuSpec(
  chapter: DocumentMeta,
  options: {
    activeDocId: string | undefined;
    running: boolean;
    editorDirty: boolean;
    chapterLeaf: ContentTreeLeaf | null | undefined;
    /** False when titleStripRegex is null: the modal prefill would carry the
     * rendered numbering prefix and every rename would snowball it. */
    renameSupported: boolean;
    actions: ChapterMenuActions;
  },
): ContextMenuSpec {
  const title = formatChapterLabel(options.chapterLeaf, chapter.chapterNo, chapter.title);
  const openDisabled = options.running || options.activeDocId === chapter.docId;
  const openReason = options.running ? disabledReason(true) : options.activeDocId === chapter.docId
    ? '当前已是此文档'
    : undefined;
  return {
    label: `${title} · 操作`,
    items: [
      withDisabledReason({
        id: 'open',
        label: '打开',
        disabled: openDisabled,
        onSelect: () => options.actions.open(chapter.docId),
      }, openReason),
      withDisabledReason({
        id: 'open-revisions',
        label: '打开并查看版本历史…',
        disabled: options.running,
        onSelect: () => options.actions.openDocumentThen(chapter.docId, 'revisions'),
      }, disabledReason(options.running)),
      withDisabledReason({
        id: 'rename-chapter',
        label: '重命名章节…',
        onSelect: () => options.actions.renameChapter(chapter),
      }, options.running
        ? 'AI 运行中，无法重命名章节'
        : !options.renameSupported
          ? '项目未配置 titleStripRegex，暂不支持重命名'
          : options.activeDocId === chapter.docId && options.editorDirty
            ? '请先保存当前修改'
            : undefined),
      withDisabledReason({
        id: 'whole-doc-thread',
        label: '对整章提意见',
        disabled: options.running,
        onSelect: () => options.actions.openDocumentThen(chapter.docId, 'wholeDocThread'),
      }, disabledReason(options.running)),
      { id: 'chapter-actions-separator', separator: true },
      {
        id: 'copy-title',
        label: '复制章节标题',
        onSelect: () => options.actions.copyTitle(title),
      },
      {
        id: 'copy-path',
        label: '复制文档路径',
        onSelect: () => options.actions.copyPath(chapter.docId),
      },
    ],
  };
}

/** Pure draft-node spec factory; delete semantics remain owned by the caller. */
export function createDraftMenuSpec(
  draft: DocumentMeta,
  options: { activeDocId: string | undefined; running: boolean; actions: DraftMenuActions },
): ContextMenuSpec {
  const openDisabled = options.running || options.activeDocId === draft.docId;
  const openReason = options.running ? disabledReason(true) : options.activeDocId === draft.docId
    ? '当前已是此文档'
    : undefined;
  return {
    label: `${draft.title} · 操作`,
    items: [
      withDisabledReason({
        id: 'open',
        label: '打开',
        disabled: openDisabled,
        onSelect: () => options.actions.open(draft.docId),
      }, openReason),
      withDisabledReason({
        id: 'whole-doc-thread',
        label: '对整章提意见',
        disabled: options.running,
        onSelect: () => options.actions.openDocumentThen(draft.docId, 'wholeDocThread'),
      }, disabledReason(options.running)),
      { id: 'draft-actions-separator', separator: true },
      {
        id: 'copy-title',
        label: '复制标题',
        onSelect: () => options.actions.copyTitle(draft.title),
      },
      {
        id: 'copy-path',
        label: '复制文档路径',
        onSelect: () => options.actions.copyPath(draft.docId),
      },
      { id: 'draft-delete-separator', separator: true },
      {
        id: 'delete-draft',
        label: '删除草稿…',
        danger: true,
        onSelect: () => options.actions.deleteDraft(draft),
      },
    ],
  };
}

export function shouldYieldToNative(event: Pick<React.MouseEvent, 'shiftKey' | 'target'>): boolean {
  if (event.shiftKey) return true;
  const target = event.target;
  if (!(target instanceof Element)) return true;
  if (target.closest(NATIVE_MENU_SELECTOR)) return true;
  const selection = window.getSelection();
  return Boolean(selection && !selection.isCollapsed && selection.containsNode(target, true));
}

interface Position {
  left: number;
  top: number;
  maxHeight?: number;
}

export function calculateContextMenuPosition(
  anchor: ContextMenuOpenState['anchor'],
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): Position {
  const isRectAnchor = 'rect' in anchor;
  const anchorX = isRectAnchor ? anchor.rect.left : anchor.x;
  const anchorY = isRectAnchor ? anchor.rect.bottom : anchor.y;
  // Keyboard (rect) anchors left-align with the trigger; only pointer anchors offset.
  let left = isRectAnchor ? anchorX : anchorX + POINTER_OFFSET;
  let top = anchorY + POINTER_OFFSET;
  let maxHeight: number | undefined;

  if (left + width > viewportWidth - VIEWPORT_GAP) left = anchorX - width - POINTER_OFFSET;
  if (left < VIEWPORT_GAP) left = VIEWPORT_GAP;
  if (top + height > viewportHeight - VIEWPORT_GAP) top = anchorY - height - POINTER_OFFSET;
  if (top < VIEWPORT_GAP) {
    top = VIEWPORT_GAP;
    maxHeight = Math.max(0, viewportHeight - 2 * VIEWPORT_GAP);
  }
  return { left, top, ...(maxHeight === undefined ? {} : { maxHeight }) };
}

export function useContextMenu(): {
  state: ContextMenuOpenState | null;
  openFromEvent: (event: React.MouseEvent, spec: ContextMenuSpec) => void;
  openFromKeyboard: (event: React.KeyboardEvent, spec: ContextMenuSpec) => void;
  close: () => void;
} {
  const [state, setState] = useState<ContextMenuOpenState | null>(null);
  const stateRef = useRef<ContextMenuOpenState | null>(null);
  stateRef.current = state;

  const close = useCallback((): void => {
    const restoreTo = stateRef.current?.restoreTo;
    setState(null);
    restoreTo?.focus({ preventScroll: true });
  }, []);

  const openFromEvent = useCallback((event: React.MouseEvent, spec: ContextMenuSpec): void => {
    if (shouldYieldToNative(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setState({
      ...spec,
      anchor: { x: event.clientX, y: event.clientY },
      via: 'pointer',
      restoreTo: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }, []);

  const openFromKeyboard = useCallback((event: React.KeyboardEvent, spec: ContextMenuSpec): void => {
    if (!isContextMenuOpenKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    setState({
      ...spec,
      anchor: { rect: target.getBoundingClientRect() },
      via: 'keyboard',
      restoreTo: document.activeElement instanceof HTMLElement ? document.activeElement : target,
    });
  }, []);

  useEffect(() => () => {
    stateRef.current?.restoreTo?.focus({ preventScroll: true });
  }, []);

  return { state, openFromEvent, openFromKeyboard, close };
}

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return 'separator' in entry;
}

export function ContextMenu({
  state,
  onClose,
}: {
  state: ContextMenuOpenState | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [position, setPosition] = useState<(Position & { state: ContextMenuOpenState }) | null>(null);

  useLayoutEffect(() => {
    if (!state) {
      setPosition(null);
      return undefined;
    }
    const menu = menuRef.current;
    if (!menu) return undefined;
    const rect = menu.getBoundingClientRect();
    setPosition({
      ...calculateContextMenuPosition(
        state.anchor,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      ),
      state,
    });
    return undefined;
  }, [state]);

  useLayoutEffect(() => {
    // Focus only after the measured position is committed: during the first
    // hidden-measurement frame the menu is visibility:hidden and focus() is a no-op.
    if (!state || !menuRef.current || position?.state !== state) return;
    if (state.via === 'keyboard') {
      const first = menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      first?.focus({ preventScroll: true });
    } else {
      menuRef.current.focus({ preventScroll: true });
    }
  }, [state, position]);

  useEffect(() => {
    if (!state) return undefined;
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) onCloseRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const closeOnViewportChange = (): void => onCloseRef.current();
    const closeOnScroll = (event: Event): void => {
      // The menu itself scrolls when maxHeight kicks in; only outside scrolls close it.
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onCloseRef.current();
    };
    document.addEventListener('pointerdown', closeOnPointerDown, true);
    document.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnViewportChange);
    window.addEventListener('blur', closeOnViewportChange);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnViewportChange);
      window.removeEventListener('blur', closeOnViewportChange);
    };
  }, [state]);

  if (!state || typeof document === 'undefined') return null;
  const ready = position?.state === state;
  const enabledItems = state.items.filter((entry): entry is ContextMenuItem => !isSeparator(entry) && !entry.disabled);

  function focusItem(index: number): void {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      .filter((button) => !button.disabled);
    buttons[index]?.focus({ preventScroll: true });
  }

  function focusRelative(direction: 1 | -1): void {
    const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      .filter((button) => !button.disabled);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = current < 0
      ? (direction > 0 ? 0 : buttons.length - 1)
      : (current + direction + buttons.length) % buttons.length;
    buttons[next]?.focus({ preventScroll: true });
  }

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusRelative(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusRelative(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusItem(enabledItems.length - 1);
    } else if (event.key === 'Enter') {
      // Activate explicitly (ARIA APG menu pattern) instead of relying on the
      // native button default, and preventDefault so it cannot fire twice.
      event.preventDefault();
      if (event.target instanceof HTMLButtonElement && !event.target.disabled) event.target.click();
    } else if (event.key === 'Tab') {
      // Close without preventDefault so Tab continues from the restored trigger.
      onCloseRef.current();
    } else if (event.key === ' ' && event.target === menuRef.current) {
      // Stop Space from scrolling the page; on a focused item Space must keep
      // its native button activation, so only intercept on the container.
      event.preventDefault();
    }
  }

  const style = {
    left: ready ? `${position.left}px` : '0px',
    top: ready ? `${position.top}px` : '0px',
    maxHeight: ready && position.maxHeight !== undefined ? `${position.maxHeight}px` : undefined,
    visibility: ready ? 'visible' : 'hidden',
  } as const;

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={state.label}
      tabIndex={-1}
      style={style}
      onKeyDown={onMenuKeyDown}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {state.items.map((entry) => {
        if (isSeparator(entry)) {
          return <div key={entry.id} className="context-menu-separator" role="separator" />;
        }
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={['context-menu-item', entry.danger ? 'danger' : ''].filter(Boolean).join(' ')}
            disabled={entry.disabled}
            aria-disabled={entry.disabled ? 'true' : undefined}
            title={entry.disabled ? entry.disabledReason : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (entry.disabled) return;
              onCloseRef.current();
              void entry.onSelect();
            }}
          >
            <span className="context-menu-label">{entry.label}</span>
            {entry.hint && <span className="context-menu-hint">{entry.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
