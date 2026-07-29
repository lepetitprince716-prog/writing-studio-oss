/** Chapter tree navigation + draft creation. */

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ChapterTreeNode, ContentTreeLeaf, DocumentMeta } from '@writing-studio/contract';
import { api } from '../api.js';
import { useStudio } from '../store.js';
import { FilePlusIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from './icons.js';
import { Modal } from './Modal.js';
import { onActivateKey } from '../lib/keyboard.js';
import { LoadingSkeleton } from './Empty.js';
import { DraftSection } from './DraftSection.js';
import { buildTrashDeleteMessage, TrashModal } from './TrashModal.js';
import {
  ContextMenu,
  createChapterMenuSpec,
  createDraftMenuSpec,
  useContextMenu,
} from './ContextMenu.js';
import { copyText } from '../lib/clipboard.js';
import { TreeChapterLabel } from './ChapterLabels.js';

const INDENT_STEP = 12;

function indentStyle(depth: number): CSSProperties {
  return { '--indent': `${depth * INDENT_STEP}px` } as CSSProperties;
}

function TreeNode({
  node,
  depth,
  onContextMenu,
  onContextMenuKeyDown,
  chapterLeaf,
}: {
  node: ChapterTreeNode;
  depth: number;
  onContextMenu(event: React.MouseEvent, chapter: DocumentMeta): void;
  onContextMenuKeyDown(event: React.KeyboardEvent, chapter: DocumentMeta): void;
  chapterLeaf: ContentTreeLeaf | null | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1);
  const openDocument = useStudio((s) => s.openDocument);
  const activeDocId = useStudio((s) => s.doc?.docId);
  const isRoot = node.name === 'root';
  const childDepth = isRoot ? depth : depth + 1;

  return (
    <div className="tree-node">
      {!isRoot && (
        <div
          className="tree-dir"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          style={indentStyle(depth)}
          onClick={() => setOpen(!open)}
          onKeyDown={onActivateKey(() => setOpen(!open))}
        >
          <span className="tree-dir-caret">
            {open ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
          </span>
          {node.name}
        </div>
      )}
      {open && (
        <>
          {node.children.map((child) => (
            <TreeNode
              key={child.name}
              node={child}
              depth={childDepth}
              onContextMenu={onContextMenu}
              onContextMenuKeyDown={onContextMenuKeyDown}
              chapterLeaf={chapterLeaf}
            />
          ))}
          {node.chapters.map((ch) => (
            <div
              key={ch.docId}
              className={ch.docId === activeDocId ? 'tree-chapter active' : 'tree-chapter'}
              role="button"
              tabIndex={0}
              aria-current={ch.docId === activeDocId ? 'true' : undefined}
              style={indentStyle(childDepth)}
              onClick={() => void openDocument(ch.docId)}
              onKeyDown={(event) => {
                onActivateKey(() => void openDocument(ch.docId))(event);
                onContextMenuKeyDown(event, ch);
              }}
              onContextMenu={(event) => onContextMenu(event, ch)}
            >
              <FileTextIcon size={14} className="tree-chapter-icon" />
              <TreeChapterLabel chapter={ch} chapterLeaf={chapterLeaf} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function TreePanel(): React.JSX.Element {
  const tree = useStudio((s) => s.tree);
  const drafts = useStudio((s) => s.drafts);
  const draftsLoading = useStudio((s) => s.draftsLoading);
  const draftsError = useStudio((s) => s.draftsError);
  const trash = useStudio((s) => s.trash);
  const trashLoading = useStudio((s) => s.trashLoading);
  const trashError = useStudio((s) => s.trashError);
  const trashRestoringDocId = useStudio((s) => s.trashRestoringDocId);
  const activeDocId = useStudio((s) => s.doc?.docId);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const projectItems = useStudio((s) => s.projectItems);
  const projectsLoaded = useStudio((s) => s.projectsLoaded);
  const projectDataLoading = useStudio((s) => s.projectDataLoading);
  const projectsError = useStudio((s) => s.projectsError);
  const draftsDir = useStudio((s) =>
    s.projects.find((project) => project.config.id === s.activeProjectId)?.config.draftsDir ?? '草稿');
  const chapterLeaf = useStudio((s) =>
    s.projects.find((project) => project.config.id === s.activeProjectId)
      ?.config.contentTree.leaf);
  const openDocument = useStudio((s) => s.openDocument);
  const openDocumentThen = useStudio((s) => s.openDocumentThen);
  const running = useStudio((s) => s.running);
  const editorDirty = useStudio((s) => s.editorDirty);
  const refreshDrafts = useStudio((s) => s.refreshDrafts);
  const listTrash = useStudio((s) => s.listTrash);
  const restoreDraft = useStudio((s) => s.restoreDraft);
  const deleteDraft = useStudio((s) => s.deleteDraft);
  const renameChapterTitle = useStudio((s) => s.renameChapterTitle);
  // Null strip regex means DocumentMeta.title is the whole H1 line — the
  // rename prefill would snowball the numbering prefix.
  const renameSupported = useStudio((s) =>
    (s.projects.find((p) => p.config.id === s.activeProjectId)
      ?.config.contentTree.leaf.titleStripRegex ?? null) !== null);
  const requestConfirm = useStudio((s) => s.requestConfirm);
  const pushToast = useStudio((s) => s.pushToast);
  const [draftOpen, setDraftOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('新草稿');
  const [renameTarget, setRenameTarget] = useState<DocumentMeta | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const menu = useContextMenu();
  const invalidProjects = projectItems.filter((item) => item.status === 'invalid');

  useEffect(() => {
    menu.close();
  }, [activeDocId, activeProjectId, running, menu.close]);

  function renderProjectState(): React.JSX.Element {
    if (!projectsLoaded || projectDataLoading) return <LoadingSkeleton label="正在加载正文树" />;
    if (tree) {
      return (
        <TreeNode
          node={tree.root}
          depth={0}
          onContextMenu={chapterMenu}
          onContextMenuKeyDown={chapterMenuKeyboard}
          chapterLeaf={chapterLeaf}
        />
      );
    }
    if (projectsError) {
      return <div className="project-state project-error">项目加载失败：{projectsError}</div>;
    }
    if (projectItems.length === 0) {
      return (
        <div className="muted project-state">
          尚未登记项目。复制 <code>data/registry.example.json</code> 为 <code>data/registry.json</code>，
          或设置 <code>WRITING_STUDIO_REGISTRY_PATH</code>。
        </div>
      );
    }
    return <div className="muted project-state">没有可用项目，请检查下方配置错误。</div>;
  }

  async function createDraft(): Promise<void> {
    const title = draftTitle.trim();
    if (!activeProjectId || !title) return;
    try {
      const meta = await api.createDraft(activeProjectId, title);
      setDraftOpen(false);
      await refreshDrafts();
      await openDocument(meta.docId);
    } catch (err) {
      pushToast('danger', `新建草稿失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function openTrash(): void {
    setTrashOpen(true);
    void listTrash();
  }

  async function confirmDeleteDraft(draft: DocumentMeta): Promise<void> {
    const confirmed = await requestConfirm({
      title: '删除草稿？',
      message: buildTrashDeleteMessage(draft.title, draftsDir),
      confirmText: '移至 .trash',
    });
    if (confirmed) await deleteDraft(draft.docId);
  }

  async function submitChapterRename(): Promise<void> {
    if (!renameTarget || !renameTitle.trim()) return;
    if (await renameChapterTitle(renameTarget, renameTitle)) setRenameTarget(null);
  }

  function chapterSpec(chapter: DocumentMeta) {
    return createChapterMenuSpec(chapter, {
      activeDocId,
      running,
      editorDirty,
      renameSupported,
      chapterLeaf,
      actions: {
        open: async (docId) => { await openDocument(docId); },
        openDocumentThen: async (docId, then) => { await openDocumentThen(docId, then); },
        renameChapter: (target) => {
          setRenameTarget(target);
          setRenameTitle(target.title);
        },
        copyTitle: async (title) => { await copyText(title, '已复制章节标题'); },
        copyPath: async (docId) => { await copyText(docId, '已复制文档路径'); },
      },
    });
  }

  function chapterMenu(event: React.MouseEvent, chapter: DocumentMeta): void {
    menu.openFromEvent(event, chapterSpec(chapter));
  }

  function chapterMenuKeyboard(event: React.KeyboardEvent, chapter: DocumentMeta): void {
    menu.openFromKeyboard(event, chapterSpec(chapter));
  }

  function draftSpec(draft: DocumentMeta) {
    return createDraftMenuSpec(draft, {
      activeDocId,
      running,
      actions: {
        open: async (docId) => { await openDocument(docId); },
        openDocumentThen: async (docId, then) => { await openDocumentThen(docId, then); },
        copyTitle: async (title) => { await copyText(title, '已复制草稿标题'); },
        copyPath: async (docId) => { await copyText(docId, '已复制文档路径'); },
        deleteDraft: async (target) => { await confirmDeleteDraft(target); },
      },
    });
  }

  function openDraftMenuFromEvent(event: React.MouseEvent, draft: DocumentMeta): void {
    menu.openFromEvent(event, draftSpec(draft));
  }

  function openDraftMenuFromKeyboard(event: React.KeyboardEvent, draft: DocumentMeta): void {
    menu.openFromKeyboard(event, draftSpec(draft));
  }

  return (
    <div className="tree-panel">
      <div className="panel-header">
        <span className="panel-header-title">正文</span>
        <button
          className="btn-icon"
          title="新建草稿"
          aria-label="新建草稿"
          disabled={!activeProjectId}
          onClick={() => {
            setDraftTitle('新草稿');
            setDraftOpen(true);
          }}
        >
          <FilePlusIcon />
        </button>
      </div>
      {renderProjectState()}
      {activeProjectId && (
        <DraftSection
          drafts={drafts}
          loading={draftsLoading}
          error={draftsError}
          activeDocId={activeDocId}
          onOpen={(docId) => void openDocument(docId)}
          onOpenTrash={openTrash}
          onContextMenu={openDraftMenuFromEvent}
          onContextMenuKeyDown={openDraftMenuFromKeyboard}
        />
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
      {invalidProjects.length > 0 && (
        <div className="invalid-projects" aria-label="无效项目">
          {invalidProjects.map((item) => (
            <div className="invalid-project" key={item.id}>
              <strong>{item.displayName}</strong>
              <span>{item.vaultRoot}</span>
              <span>{item.error}</span>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={renameTarget !== null}
        title="重命名章节"
        confirmText="重命名"
        confirmDisabled={!renameTitle.trim()}
        onClose={() => setRenameTarget(null)}
        onConfirm={() => void submitChapterRename()}
      >
        <label className="modal-field">
          <span className="modal-field-label">章节标题</span>
          <input
            className="modal-input"
            value={renameTitle}
            maxLength={60}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && renameTitle.trim()) void submitChapterRename();
            }}
          />
        </label>
      </Modal>

      <Modal
        open={draftOpen}
        title="新建草稿"
        confirmText="创建"
        confirmDisabled={!draftTitle.trim()}
        onClose={() => setDraftOpen(false)}
        onConfirm={() => void createDraft()}
      >
        <label className="modal-field">
          <span className="modal-field-label">草稿标题</span>
          <input
            className="modal-input"
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draftTitle.trim()) void createDraft();
            }}
          />
        </label>
      </Modal>

      <TrashModal
        open={trashOpen}
        entries={trash}
        loading={trashLoading}
        error={trashError}
        draftsDir={draftsDir}
        restoringDocId={trashRestoringDocId}
        onClose={() => setTrashOpen(false)}
        onRestore={(docId) => void restoreDraft(docId)}
      />
    </div>
  );
}
