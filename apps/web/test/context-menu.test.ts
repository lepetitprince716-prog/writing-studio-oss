import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentMeta } from '@writing-studio/contract';
import { LEGACY_CHAPTER_LABEL_LEAF } from '../src/lib/chapter-label.js';
import {
  calculateContextMenuPosition,
  createChapterMenuSpec,
  createDraftMenuSpec,
  type ContextMenuEntry,
  type ContextMenuItem,
} from '../src/components/ContextMenu.js';
import {
  createMessageMenuSpec,
  createThreadMenuSpec,
} from '../src/components/thread-menu-specs.js';
import { createSidebarEntryMenuSpec } from '../src/components/sidebar/sidebar-menu-specs.js';
import {
  createGraphEntityMenuSpec,
  createGraphRelationMenuSpec,
  relationText,
} from '../src/graph/graph-menu-specs.js';

const documentMeta: DocumentMeta = {
  docId: '正文/第12章.md',
  projectId: 'project-a',
  kind: 'chapter',
  title: '章节标题A',
  chapterNo: 12,
  sha256: 'a'.repeat(64),
  bytes: 1,
  mtimeMs: 1,
};

const draftMeta: DocumentMeta = {
  ...documentMeta,
  docId: '草稿/新稿.md',
  kind: 'draft',
  title: '新稿',
  chapterNo: null,
};

const noopActions = {
  open: () => undefined,
  openDocumentThen: () => undefined,
  renameChapter: () => undefined,
  copyTitle: () => undefined,
  copyPath: () => undefined,
  deleteDraft: () => undefined,
};

function menuItems(entries: ContextMenuEntry[]): ContextMenuItem[] {
  return entries.filter((entry): entry is ContextMenuItem => !('separator' in entry));
}

function assertSpecInvariants(entries: ContextMenuEntry[]): void {
  const actionable = menuItems(entries);
  assert.ok(actionable.length <= 8);
  entries.forEach((entry, index) => {
    if ('separator' in entry) return;
    if (entry.disabled) assert.ok(entry.disabledReason);
    if (entry.danger) {
      assert.ok(index > 0 && 'separator' in entries[index - 1]!);
    }
  });
}

test('chapter and draft specs keep menu invariants and exact running guards', () => {
  const chapter = createChapterMenuSpec(documentMeta, {
    activeDocId: '正文/别章.md',
    running: true,
    editorDirty: false,
    renameSupported: true,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  const draft = createDraftMenuSpec(draftMeta, {
    activeDocId: undefined,
    running: false,
    actions: noopActions,
  });

  assert.equal(menuItems(chapter.items).length, 6);
  assert.deepEqual(
    menuItems(chapter.items).slice(0, 4).map((entry) => entry.disabled),
    [true, true, true, true],
  );
  assert.equal(menuItems(draft.items).length, 5);
  assert.equal(menuItems(draft.items).find((entry) => entry.danger)?.label, '删除草稿…');
  assertSpecInvariants(chapter.items);
  assertSpecInvariants(draft.items);
});

test('chapter rename sits after revisions and guards running or a dirty active editor', () => {
  const clean = createChapterMenuSpec(documentMeta, {
    activeDocId: documentMeta.docId,
    running: false,
    editorDirty: false,
    renameSupported: true,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  const cleanItems = menuItems(clean.items);
  assert.deepEqual(cleanItems.slice(0, 4).map((entry) => entry.id), [
    'open',
    'open-revisions',
    'rename-chapter',
    'whole-doc-thread',
  ]);
  assert.equal(cleanItems.find((entry) => entry.id === 'rename-chapter')?.disabled, undefined);

  const dirty = createChapterMenuSpec(documentMeta, {
    activeDocId: documentMeta.docId,
    running: false,
    editorDirty: true,
    renameSupported: true,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  const dirtyRename = menuItems(dirty.items).find((entry) => entry.id === 'rename-chapter');
  assert.equal(dirtyRename?.disabled, true);
  assert.equal(dirtyRename?.disabledReason, '请先保存当前修改');

  const running = createChapterMenuSpec(documentMeta, {
    activeDocId: '正文/别章.md',
    running: true,
    editorDirty: false,
    renameSupported: true,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  const runningRename = menuItems(running.items).find((entry) => entry.id === 'rename-chapter');
  assert.equal(runningRename?.disabled, true);
  assert.match(runningRename?.disabledReason ?? '', /AI 运行中/);
  assert.equal(running.items.some((entry) => !('separator' in entry) && entry.danger), false);
  assertSpecInvariants(dirty.items);

  const unsupported = createChapterMenuSpec(documentMeta, {
    activeDocId: undefined,
    running: false,
    editorDirty: false,
    renameSupported: false,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  const unsupportedRename = menuItems(unsupported.items)
    .find((entry) => entry.id === 'rename-chapter');
  assert.equal(unsupportedRename?.disabled, true);
  assert.match(unsupportedRename?.disabledReason ?? '', /titleStripRegex/);
  assertSpecInvariants(unsupported.items);
});

test('chapter menu label and copy target follow the active project title template', async () => {
  let copiedTitle: string | undefined;
  const spec = createChapterMenuSpec(
    { ...documentMeta, title: 'Aftermath' },
    {
      activeDocId: undefined,
      running: false,
      editorDirty: false,
      renameSupported: true,
      chapterLeaf: {
        ...LEGACY_CHAPTER_LABEL_LEAF,
        titleTemplate: 'Chapter {num} {title}',
      },
      actions: {
        ...noopActions,
        copyTitle: (title) => {
          copiedTitle = title;
        },
      },
    },
  );

  assert.equal(spec.label, 'Chapter 12 Aftermath · 操作');
  const copyTitle = menuItems(spec.items).find((item) => item.id === 'copy-title');
  assert.equal(copyTitle?.label, '复制章节标题');
  await copyTitle?.onSelect();
  assert.equal(copiedTitle, 'Chapter 12 Aftermath');

  const legacy = createChapterMenuSpec(documentMeta, {
    activeDocId: undefined,
    running: false,
    editorDirty: false,
    renameSupported: true,
    chapterLeaf: LEGACY_CHAPTER_LABEL_LEAF,
    actions: noopActions,
  });
  assert.equal(legacy.label, '第12章 章节标题A · 操作');
});

test('message specs enforce role cropping and disabled reasons', () => {
  const baseMessage = {
    id: 'message-a',
    threadId: 'thread-a',
    agentId: null,
    content: '第一行\n第二行',
    structured: null,
    createdAt: 1,
  };
  const actions = {
    copyContent: () => undefined,
    quoteContent: () => undefined,
    openRewriteReview: () => undefined,
  };
  const assistant = createMessageMenuSpec(
    { ...baseMessage, role: 'assistant' },
    { running: false, canReviewRewrite: true, actions },
  );
  const user = createMessageMenuSpec(
    { ...baseMessage, role: 'user' },
    { running: true, canReviewRewrite: false, actions },
  );

  assert.equal(menuItems(assistant.items).length, 3);
  assert.equal(menuItems(user.items).length, 2);
  assert.equal(user.items.some((entry) => !('separator' in entry) && entry.id === 'review-rewrite'), false);
  assertSpecInvariants(assistant.items);
  assertSpecInvariants(user.items);

  const empty = createMessageMenuSpec(
    { ...baseMessage, content: '   ', role: 'assistant' },
    { running: false, canReviewRewrite: false, actions },
  );
  const copyItem = empty.items.find((entry) => !('separator' in entry) && entry.id === 'copy-message');
  assert.ok(copyItem && !('separator' in copyItem) && copyItem.disabled, 'copy must be disabled for empty content');
  assertSpecInvariants(empty.items);
});

test('thread spec has three actions and guards only the active running mutations', () => {
  const thread = {
    id: 'thread-a',
    projectId: 'project-a',
    docId: '正文/第12章.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '讨论风暴',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  };
  const spec = createThreadMenuSpec(thread, {
    activeThreadId: thread.id,
    running: true,
    actions: {
      open: () => undefined,
      rename: () => undefined,
      copyTranscript: () => undefined,
    },
  });

  const actions = menuItems(spec.items);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions.map((entry) => entry.disabled), [true, true, undefined]);
  assertSpecInvariants(spec.items);
});

test('sidebar entry specs crop role-only mentions and preserve exact action targets', async () => {
  const section = {
    headingPath: ['一、地理'],
    anchor: {
      docSha: 'b'.repeat(64),
      start: 0,
      end: 1,
      prefix: '',
      exact: 'x',
      suffix: '',
    },
  };
  let opened: unknown;
  let repaired: unknown;
  const actions = {
    openSource: (target: unknown) => {
      opened = target;
    },
    repair: (target: unknown) => {
      repaired = target;
    },
    copyName: () => undefined,
    copyEntry: () => undefined,
  };
  const normal = createSidebarEntryMenuSpec({
    label: '地点B',
    sourceFile: '设定索引.md',
    sourceRaw: '世界观.md §3.2',
    source: { docId: '世界观.md', heading: '3.2 大地理结构' },
    repairSection: section,
    actions,
  });
  const character = createSidebarEntryMenuSpec({
    label: '角色A',
    sourceFile: '角色设定.md',
    sourceRaw: '',
    source: null,
    showJump: false,
    repairSection: undefined,
    actions: { ...actions, showMentions: () => undefined },
  });

  assert.equal(menuItems(normal.items).length, 4);
  assert.equal(menuItems(character.items).length, 4);
  assert.equal(
    normal.items.some((entry) => !('separator' in entry) && entry.id === 'show-character-mentions'),
    false,
  );
  assert.equal(
    character.items.some((entry) => !('separator' in entry) && entry.id === 'open-canon-source'),
    false,
  );
  await menuItems(normal.items).find(
    (entry) => entry.id === 'open-canon-source',
  )?.onSelect();
  await menuItems(normal.items).find(
    (entry) => entry.id === 'repair-canon-section',
  )?.onSelect();
  assert.deepEqual(opened, { docId: '世界观.md', heading: '3.2 大地理结构' });
  assert.equal(repaired, section, 'menu repair must forward the same CanonSectionRef object');
  assertSpecInvariants(normal.items);
  assertSpecInvariants(character.items);
});

test('sidebar entry spec hides source-dependent actions when source config is absent', () => {
  const spec = createSidebarEntryMenuSpec({
    label: '停点',
    sourceFile: '',
    sourceRaw: '',
    source: null,
    repairSection: undefined,
    actions: {
      openSource: () => undefined,
      repair: () => undefined,
      copyName: () => undefined,
      copyEntry: () => undefined,
    },
  });
  const actions = menuItems(spec.items);
  assert.equal(spec.items.length, 2);
  assert.deepEqual(actions.map((entry) => entry.id), [
    'copy-sidebar-entry-name',
    'copy-sidebar-entry',
  ]);
  assertSpecInvariants(spec.items);
});

test('context menu placement flips from the viewport corner and clamps to the gap', () => {
  assert.deepEqual(
    calculateContextMenuPosition({ x: 790, y: 590 }, 168, 150, 800, 600),
    { left: 620, top: 438 },
  );
  assert.deepEqual(
    calculateContextMenuPosition({ x: 0, y: 0 }, 300, 900, 800, 600),
    { left: 8, top: 8, maxHeight: 584 },
  );
});

test('graph entity and relation specs expose source availability and selection guards', () => {
  const sourceNode = {
    id: 'node-a',
    name: '地点B',
    aliases: [],
    typeId: 'place',
    activeFrom: null,
    revealedAt: null,
    inactiveFrom: null,
    visibility: 'public' as const,
    confidence: 'confirmed' as const,
    sources: [{ docId: '世界观.md', heading: '地点B', label: null }],
    implicit: false,
  };
  const targetNode = {
    ...sourceNode,
    id: 'node-b',
    name: '地点F',
    sources: [],
  };
  const edge = {
    id: 'edge-a',
    sourceId: sourceNode.id,
    relationTypeId: 'flows-to',
    targetId: targetNode.id,
    activeFrom: null,
    revealedAt: null,
    inactiveFrom: null,
    visibility: 'public' as const,
    confidence: 'confirmed' as const,
    sources: [],
  };
  const relation = {
    id: 'flows-to',
    name: '流向',
    visualFamily: 'place' as const,
    directed: true,
    reverseName: null,
  };
  const actions = {
    select: () => undefined,
    openSource: () => undefined,
    copyName: () => undefined,
    copyRelation: () => undefined,
  };
  const entity = createGraphEntityMenuSpec(sourceNode, sourceNode.id, actions);
  const relationSpec = createGraphRelationMenuSpec(
    edge,
    sourceNode,
    targetNode,
    relation,
    targetNode.id,
    actions,
  );

  assert.equal(menuItems(entity.items).length, 3);
  assert.equal(
    menuItems(entity.items).find((entry) => entry.id === 'select-graph-entity')?.disabled,
    true,
  );
  assert.equal(relationText(edge, sourceNode, targetNode, relation), '地点B 流向 地点F');
  assert.equal(relationSpec.items.length, 4);
  assert.equal(
    menuItems(relationSpec.items).find(
      (entry) => entry.id === 'open-graph-relation-source',
    )?.disabled,
    true,
  );
  assert.equal(
    menuItems(relationSpec.items).find(
      (entry) => entry.id === 'select-graph-relation-target',
    )?.disabled,
    true,
  );
  assertSpecInvariants(entity.items);
  assertSpecInvariants(relationSpec.items);
});
