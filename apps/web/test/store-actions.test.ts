import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentAvailability, GitStatus, Project, Thread } from '@writing-studio/contract';
import { deferred } from './support.js';

const stored = new Map<string, string>([
  ['ws-left-collapsed', '0'],
  ['ws-right-collapsed', '0'],
]);

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem(key: string): string | null {
      return stored.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      stored.set(key, value);
    },
    removeItem(key: string): void {
      stored.delete(key);
    },
    clear(): void {
      stored.clear();
    },
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    innerWidth: 375,
    confirm: () => true,
  },
});

const { api, ApiError } = await import('../src/api.js');
const { useStudio } = await import('../src/store.js');
const { applyServerEnvelope } = await import('../src/ws.js');

function sidebar(sourceId: string) {
  return [{ sourceId, parser: 'plain' as const, markdown: sourceId }];
}

const tree = {
  root: { name: 'root', levelName: 'root', children: [], chapters: [] },
};
const git: GitStatus = { branch: 'main', dirty: [] };
const documentB = {
  doc: {
    docId: 'doc-b.md',
    projectId: 'project-a',
    kind: 'chapter' as const,
    title: 'B',
    chapterNo: 2,
    sha256: 'b'.repeat(64),
    bytes: 1,
    mtimeMs: 1,
  },
  content: 'B',
  anchors: [],
};

function resetStore(): void {
  useStudio.getState().resolveConfirm(false);
  stored.delete('ws-model-prefs');
  useStudio.setState({
    activeProjectId: null,
    projectDataLoading: false,
    tree: null,
    drafts: [],
    draftsLoading: false,
    draftsError: null,
    trash: [],
    trashLoading: false,
    trashError: null,
    trashRestoringDocId: null,
    git: null,
    sidebar: [],
    activeSidebarId: null,
    doc: null,
    docContent: '',
    editorContent: '',
    editorLoadVersion: 0,
    baseSha: '',
    editorDirty: false,
    pendingRevealQuote: null,
    threads: [],
    chatThreads: [],
    activeThread: null,
    messages: [],
    running: false,
    conflictCheckStarting: false,
    activeRunId: null,
    runGeneration: 0,
    runManifest: null,
    runError: null,
    generateDoc: null,
    beats: [],
    beatIndex: 0,
    beatTexts: [],
    beatPhase: 'writing',
    beatRewriting: false,
    modelPrefs: {},
    toasts: [],
    confirmDialog: null,
  });
}

test('production store starts narrow with both persisted desktop panes closed', () => {
  assert.equal(useStudio.getState().isNarrow, true);
  assert.equal(useStudio.getState().leftCollapsed, true);
  assert.equal(useStudio.getState().rightCollapsed, true);
});

test('renameChapterTitle refreshes the tree and a clean active editor', async (t) => {
  resetStore();
  const originalRename = api.renameChapterTitle;
  const originalGetTree = api.getTree;
  const originalGetDocument = api.getDocument;
  const originalCreateRevision = api.createRevision;
  t.after(() => {
    api.renameChapterTitle = originalRename;
    api.getTree = originalGetTree;
    api.getDocument = originalGetDocument;
    api.createRevision = originalCreateRevision;
  });
  const chapter = {
    docId: '正文/第1章.md',
    projectId: 'project-a',
    kind: 'chapter' as const,
    title: '旧题',
    chapterNo: 1,
    sha256: 'a'.repeat(64),
    bytes: 20,
    mtimeMs: 1,
  };
  const renamed = {
    ...chapter,
    title: '新题',
    sha256: 'c'.repeat(64),
    bytes: 21,
    mtimeMs: 2,
  };
  const refreshedTree = {
    root: { name: 'root', levelName: 'root', children: [], chapters: [renamed] },
  };
  let request: unknown;
  api.renameChapterTitle = async (pid, docId, title, baseSha256) => {
    request = { pid, docId, title, baseSha256 };
    return { sha256: renamed.sha256, doc: renamed };
  };
  api.getTree = async () => refreshedTree;
  api.getDocument = async () => ({
    doc: renamed,
    content: '# 第1章 新题\n\n正文。\n',
    anchors: [],
  });
  let revisionInput: unknown;
  api.createRevision = async (_pid, _docId, input) => {
    revisionInput = input;
    return {} as Awaited<ReturnType<typeof originalCreateRevision>>;
  };
  useStudio.setState({
    activeProjectId: 'project-a',
    tree,
    doc: chapter,
    docContent: '# 第1章 旧题\n\n正文。\n',
    editorContent: '# 第1章 旧题\n\n正文。\n',
    editorLoadVersion: 4,
    baseSha: chapter.sha256,
    editorDirty: false,
  });

  assert.equal(await useStudio.getState().renameChapterTitle(chapter, '新题'), true);
  assert.deepEqual(request, {
    pid: 'project-a',
    docId: chapter.docId,
    title: '新题',
    baseSha256: chapter.sha256,
  });
  const state = useStudio.getState();
  assert.equal(state.tree?.root.chapters[0]?.title, '新题');
  assert.equal(state.doc?.title, '新题');
  assert.equal(state.editorContent, '# 第1章 新题\n\n正文。\n');
  assert.equal(state.baseSha, renamed.sha256);
  assert.equal(state.editorDirty, false);
  assert.equal(state.editorLoadVersion, 5);
  // Renames leave a rollback point, same as saveDocument (review F3).
  assert.deepEqual(revisionInput, {
    kind: 'user_edit',
    content: '# 第1章 新题\n\n正文。\n',
    label: '重命名章节',
  });
});

test('renameChapterTitle reports a stale write as a human-readable conflict', async (t) => {
  resetStore();
  const originalRename = api.renameChapterTitle;
  t.after(() => {
    api.renameChapterTitle = originalRename;
  });
  const chapter = {
    ...documentB.doc,
    docId: '正文/第2章.md',
  };
  api.renameChapterTitle = async () => {
    throw Object.assign(new Error('document changed on disk'), { code: 'STALE_WRITE' });
  };
  useStudio.setState({ activeProjectId: 'project-a', doc: chapter, editorDirty: false });

  assert.equal(await useStudio.getState().renameChapterTitle(chapter, '新题'), false);
  assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /别处修改.*刷新后重试/);
});

test('renameThread updates every local projection optimistically and accepts the server result', async (t) => {
  resetStore();
  const originalPatchThread = api.patchThread;
  t.after(() => {
    api.patchThread = originalPatchThread;
  });
  const thread = {
    id: 'thread-rename',
    projectId: 'project-a',
    docId: 'doc-a.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '旧标题',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const request = deferred<Thread>();
  api.patchThread = async () => request.promise;
  useStudio.setState({
    threads: [thread],
    chatThreads: [thread],
    activeThread: thread,
  });

  const result = useStudio.getState().renameThread(thread.id, '  新标题  ');
  assert.deepEqual(
    [
      useStudio.getState().threads[0]?.title,
      useStudio.getState().chatThreads[0]?.title,
      useStudio.getState().activeThread?.title,
    ],
    ['新标题', '新标题', '新标题'],
  );

  request.resolve({ ...thread, title: '新标题', updatedAt: 2 });
  assert.equal(await result, true);
  assert.equal(useStudio.getState().activeThread?.updatedAt, 2);
  assert.equal(useStudio.getState().toasts.at(-1)?.text, '线程已重命名');
});

test('renameThread rolls back every unchanged optimistic projection on failure', async (t) => {
  resetStore();
  const originalPatchThread = api.patchThread;
  t.after(() => {
    api.patchThread = originalPatchThread;
  });
  const thread = {
    id: 'thread-rollback',
    projectId: 'project-a',
    docId: 'doc-a.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '原标题',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const request = deferred<Thread>();
  api.patchThread = async () => request.promise;
  useStudio.setState({
    threads: [thread],
    chatThreads: [thread],
    activeThread: thread,
  });

  const result = useStudio.getState().renameThread(thread.id, '失败标题');
  request.reject(new Error('offline'));

  assert.equal(await result, false);
  assert.deepEqual(
    [
      useStudio.getState().threads[0]?.title,
      useStudio.getState().chatThreads[0]?.title,
      useStudio.getState().activeThread?.title,
    ],
    ['原标题', '原标题', '原标题'],
  );
  assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /重命名线程失败：offline/);
});

test('character chats reuse only the same character and memory cutoff', async (t) => {
  resetStore();
  const original = {
    createThread: api.createThread,
    getThread: api.getThread,
  };
  t.after(() => Object.assign(api, original));
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文',
        levels: [],
        leaf: {
          filePattern: '第{num}章.md',
          numberStyle: 'arabic',
          numberingScope: 'book',
          titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [{
        id: 'characters',
        label: '角色',
        file: '角色.md',
        parser: 'heading-sections',
        parserConfig: {
          kind: 'characters',
          cardHeadingLevel: 2,
          sectionHeadingLevel: 3,
          authorOnlyMarkers: [],
        },
        order: 1,
      }],
      aiProfiles: {
        writer: {
          description: '',
          readable: ['正文/**'],
          forbidden: [],
          allowVaultBrowsing: false,
        },
        planner: {
          description: '',
          readable: ['**/*.md'],
          forbidden: [],
          allowVaultBrowsing: true,
        },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'echo',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const requests: Parameters<typeof api.createThread>[0][] = [];
  api.createThread = async (input) => {
    requests.push(input);
    return {
      id: `chat-${requests.length}`,
      projectId: input.projectId,
      docId: input.docId,
      kind: 'chat',
      anchor: null,
      persona: input.persona,
      agentId: 'echo',
      profile: 'writer',
      title: `chat ${requests.length}`,
      status: 'open',
      createdAt: requests.length,
      updatedAt: requests.length,
    } as Thread;
  };
  api.getThread = async (threadId) => {
    const thread = useStudio.getState().chatThreads.find((item) => item.id === threadId);
    assert.ok(thread);
    return { thread, messages: [] };
  };
  useStudio.setState({
    activeProjectId: project.config.id,
    projects: [project],
    agents: [{
      agentId: 'echo',
      ok: true,
      supportedProfiles: ['writer'],
      version: 'test',
      binaryPath: 'echo',
      error: null,
    }],
    agentsLoaded: true,
  });

  await useStudio.getState().startCharacterChat('角色A', 70);
  await useStudio.getState().startCharacterChat('角色A');
  assert.deepEqual(requests.map((request) => request.persona), [
    { characterName: '角色A', memoryCutoffChapter: 70 },
    { characterName: '角色A' },
  ]);
  assert.equal(useStudio.getState().chatThreads.length, 2);

  await useStudio.getState().startCharacterChat('角色A', 70);
  assert.equal(requests.length, 2);
  assert.equal(useStudio.getState().activeThread?.id, 'chat-1');
});

test('conflict check starts the reusable run surface and exposes quote/canon navigation', async (t) => {
  resetStore();
  const originalLayout = {
    focusMode: useStudio.getState().focusMode,
    rightCollapsed: useStudio.getState().rightCollapsed,
    rightPaneTab: useStudio.getState().rightPaneTab,
  };
  t.after(() => useStudio.setState(originalLayout));
  const original = {
    startConflictCheck: api.startConflictCheck,
    getThread: api.getThread,
    getRun: api.getRun,
  };
  t.after(() => Object.assign(api, original));
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文', levels: [],
        leaf: {
          filePattern: '第{num}章.md', numberStyle: 'arabic',
          numberingScope: 'book', titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [{
        id: 'characters',
        label: '角色',
        file: '角色.md',
        order: 1,
        parser: 'plain' as const,
        parserConfig: {},
      }],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer' as const,
      },
      defaultAgentId: 'echo' as const,
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const checkThread = {
    id: 'thread-check',
    projectId: 'project-a',
    docId: documentB.doc.docId,
    kind: 'ask' as const,
    anchor: null,
    origin: 'check' as const,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '正典冲突检查',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  api.startConflictCheck = async () => ({ threadId: checkThread.id, runId: 'run-check' });
  api.getThread = async () => ({ thread: checkThread, messages: [] });
  api.getRun = async () => ({
    id: 'run-check',
    projectId: 'project-a',
    threadId: checkThread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
  };
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    doc: documentB.doc,
    editorContent: documentB.content,
    editorDirty: false,
    agents: [agent],
    agentsLoaded: true,
    focusMode: true,
    rightCollapsed: true,
  });

  await useStudio.getState().runConflictCheck();
  assert.equal(useStudio.getState().activeThread?.origin, 'check');
  assert.equal(useStudio.getState().activeRunId, 'run-check');
  assert.equal(useStudio.getState().running, true);
  assert.equal(useStudio.getState().rightPaneTab, 'ai');
  assert.equal(useStudio.getState().focusMode, false);
  assert.equal(useStudio.getState().rightCollapsed, false);

  useStudio.getState().revealTextQuote('示例文本引用一');
  assert.equal(useStudio.getState().pendingRevealQuote, '示例文本引用一');
  useStudio.getState().openCanonSource('角色.md', '角色A / 状态');
  assert.equal(useStudio.getState().activeSidebarId, 'characters');
  assert.equal(useStudio.getState().rightPaneTab, 'canon');
});

test('canon repair finding resolves one writer section and prefills manuscript evidence', async (t) => {
  resetStore();
  const originalStart = useStudio.getState().startCanonRewrite;
  t.after(() => useStudio.setState({ startCanonRewrite: originalStart }));
  const section = {
    headingPath: ['角色A', '当前状态'],
    anchor: {
      docSha: 'c'.repeat(64),
      start: 8,
      end: 30,
      prefix: '',
      exact: '### 当前状态\n左臂受伤。\n',
      suffix: '',
    },
  };
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文', levels: [],
        leaf: {
          filePattern: '第{num}章.md', numberStyle: 'arabic',
          numberingScope: 'book', titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [{
        id: 'characters', label: '角色', file: '角色.md', order: 1,
        parser: 'heading-sections' as const,
        parserConfig: {
          kind: 'characters' as const,
          cardHeadingLevel: 2,
          sectionHeadingLevel: 3,
          authorOnlyMarkers: ['AUTHOR_ONLY'],
        },
      }],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer' as const,
      },
      defaultAgentId: 'echo' as const,
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  let captured: unknown = null;
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    doc: documentB.doc,
    sidebar: [{
      sourceId: 'characters',
      parser: 'heading-sections',
      kind: 'characters',
      data: [],
      writerSections: [section],
    }],
    startCanonRewrite: async (docId, target, evidence) => {
      captured = { docId, target, evidence };
    },
  });
  await useStudio.getState().startCanonRewriteFromFinding(
    '角色.md',
    '角色A / 当前状态',
    '示例文本引用二',
  );
  assert.deepEqual(captured, {
    docId: '角色.md',
    target: section,
    evidence: {
      docId: 'doc-b.md',
      textQuote: '示例文本引用二',
    },
  });
});

test('sidebar canon entry opens its document and creates an anchored writer rewrite', async (t) => {
  resetStore();
  const original = {
    createThread: api.createThread,
    openDocument: useStudio.getState().openDocument,
  };
  t.after(() => {
    api.createThread = original.createThread;
    useStudio.setState({ openDocument: original.openDocument });
  });
  const section = {
    headingPath: ['停点'],
    anchor: {
      docSha: 'd'.repeat(64),
      start: 0,
      end: 14,
      prefix: '',
      exact: '## 停点\n地点G。\n',
      suffix: '',
    },
  };
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文', levels: [],
        leaf: {
          filePattern: '第{num}章.md', numberStyle: 'arabic',
          numberingScope: 'book', titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [{
        id: 'status', label: '状态', file: '状态.md', order: 1,
        parser: 'plain' as const, parserConfig: {},
      }],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer' as const,
      },
      defaultAgentId: 'echo' as const,
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
  };
  let request: Parameters<typeof api.createThread>[0] | null = null;
  api.createThread = async (input) => {
    request = input;
    return {
      id: 'canon-thread',
      projectId: 'project-a',
      docId: '状态.md',
      kind: 'rewrite',
      anchor: section.anchor,
      origin: 'canon',
      canon: { headingPath: ['停点'] },
      agentId: 'echo',
      profile: 'writer',
      title: '修补正典：停点',
      status: 'open',
      createdAt: 1,
      updatedAt: 1,
    };
  };
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    agents: [agent],
    agentsLoaded: true,
    openDocument: async () => {
      useStudio.setState({
        doc: {
          ...documentB.doc,
          docId: '状态.md',
          kind: 'canon',
          title: '状态',
          chapterNo: null,
          sha256: section.anchor.docSha,
        },
      });
      return true;
    },
  });
  await useStudio.getState().startCanonRewrite('状态.md', section);
  assert.deepEqual(request, {
    projectId: 'project-a',
    docId: '状态.md',
    kind: 'rewrite',
    origin: 'canon',
    profile: 'writer',
    agentId: 'echo',
    anchor: section.anchor,
    headingPath: ['停点'],
  });
  assert.equal(useStudio.getState().activeThread?.origin, 'canon');
  assert.equal(useStudio.getState().rightPaneTab, 'ai');
});

test('dirty navigation waits for modal confirmation and cancellation preserves context', async () => {
  resetStore();
  useStudio.setState({
    activeProjectId: 'project-a',
    editorDirty: true,
    editorContent: 'unsaved',
  });

  const selecting = useStudio.getState().selectProject('project-b');
  assert.equal(useStudio.getState().confirmDialog?.confirmText, '放弃并切换');
  assert.equal(useStudio.getState().activeProjectId, 'project-a');
  useStudio.getState().resolveConfirm(false);
  await selecting;
  assert.equal(useStudio.getState().activeProjectId, 'project-a');

  const opening = useStudio.getState().openDocument('doc-b.md');
  assert.equal(useStudio.getState().confirmDialog?.confirmText, '放弃并打开');
  useStudio.getState().resolveConfirm(false);
  assert.equal(await opening, false);
  assert.equal(useStudio.getState().editorContent, 'unsaved');
});

test('rewrite apply request keeps safety identity while using the composed chunk text', () => {
  resetStore();
  useStudio.setState({
    rewriteReview: {
      messageId: 'message-a',
      projectId: 'project-a',
      docId: 'doc-a.md',
      threadId: 'thread-a',
      preferredStart: 4,
      prefix: 'pre',
      originalText: 'old',
      suffix: 'post',
      rewrittenText: 'candidate',
      notes: null,
      rawFallback: false,
      wholeDoc: false,
      wholeDocBaseSha: null,
      canon: false,
    },
  });

  useStudio.getState().requestRewriteApply('partially composed');
  const request = useStudio.getState().rewriteApplyRequest;
  assert.equal(request?.rewrittenText, 'partially composed');
  assert.equal(request?.projectId, 'project-a');
  assert.equal(request?.docId, 'doc-a.md');
  assert.equal(request?.threadId, 'thread-a');
  assert.equal(request?.originalText, 'old');
  assert.equal(useStudio.getState().rewriteReview, null);
});

test('selectProject and recoverConnection keep the newest valid sidebar when the document changes', async (t) => {
  resetStore();
  const original = {
    getTree: api.getTree,
    listDrafts: api.listDrafts,
    getGitStatus: api.getGitStatus,
    getSidebar: api.getSidebar,
    getDocument: api.getDocument,
    listThreads: api.listThreads,
  };
  t.after(() => Object.assign(api, original));

  const selectedSidebar = deferred<ReturnType<typeof sidebar>>();
  const recoveredSidebar = deferred<ReturnType<typeof sidebar>>();
  let sidebarCalls = 0;
  api.getTree = async () => tree;
  api.listDrafts = async () => [];
  api.getGitStatus = async () => git;
  api.getSidebar = async () => (
    sidebarCalls++ === 0 ? selectedSidebar.promise : recoveredSidebar.promise
  );
  api.getDocument = async () => documentB;
  api.listThreads = async () => [];

  const selecting = useStudio.getState().selectProject('project-a');
  assert.equal(useStudio.getState().projectDataLoading, true);
  const recovering = useStudio.getState().recoverConnection();
  const opening = useStudio.getState().openDocument('doc-b.md');
  assert.equal(await opening, true);

  recoveredSidebar.resolve(sidebar('recovered'));
  await recovering;
  assert.equal(useStudio.getState().sidebar[0]?.sourceId, 'recovered');

  selectedSidebar.resolve(sidebar('selected-stale'));
  await selecting;
  assert.equal(useStudio.getState().projectDataLoading, false);
  assert.equal(useStudio.getState().sidebar[0]?.sourceId, 'recovered');
});

test('selectProject cannot overwrite newer recovered tree and git state', async (t) => {
  resetStore();
  const original = {
    getTree: api.getTree,
    listDrafts: api.listDrafts,
    getGitStatus: api.getGitStatus,
    getSidebar: api.getSidebar,
  };
  t.after(() => Object.assign(api, original));

  const selectedTree = deferred<typeof tree>();
  const recoveredTree = deferred<typeof tree>();
  const selectedGit = deferred<typeof git>();
  const recoveredGit = deferred<typeof git>();
  const selectedSidebar = deferred<ReturnType<typeof sidebar>>();
  const recoveredSidebar = deferred<ReturnType<typeof sidebar>>();
  let treeCalls = 0;
  let gitCalls = 0;
  let sidebarCalls = 0;
  api.getTree = async () => (treeCalls++ === 0 ? selectedTree.promise : recoveredTree.promise);
  api.listDrafts = async () => [];
  api.getGitStatus = async () => (gitCalls++ === 0 ? selectedGit.promise : recoveredGit.promise);
  api.getSidebar = async () => (
    sidebarCalls++ === 0 ? selectedSidebar.promise : recoveredSidebar.promise
  );

  const selecting = useStudio.getState().selectProject('project-a');
  const recovering = useStudio.getState().recoverConnection();
  const treeNew = {
    root: { name: 'recovered', levelName: 'root', children: [], chapters: [] },
  };
  const gitNew: GitStatus = {
    branch: 'recovered',
    dirty: [{ path: 'new.md', status: 'M' }],
  };
  recoveredTree.resolve(treeNew);
  recoveredGit.resolve(gitNew);
  recoveredSidebar.resolve(sidebar('recovered'));
  await recovering;
  assert.equal(useStudio.getState().tree?.root.name, 'recovered');
  assert.equal(useStudio.getState().git?.branch, 'recovered');

  selectedTree.resolve(tree);
  selectedGit.resolve(git);
  selectedSidebar.resolve(sidebar('selected-stale'));
  await selecting;
  assert.equal(useStudio.getState().tree?.root.name, 'recovered');
  assert.equal(useStudio.getState().git?.branch, 'recovered');
});

test('refreshSidebar can still apply an older success when a newer request fails', async (t) => {
  resetStore();
  useStudio.setState({ activeProjectId: 'project-a' });
  const original = api.getSidebar;
  t.after(() => {
    api.getSidebar = original;
  });

  const older = deferred<ReturnType<typeof sidebar>>();
  const newer = deferred<ReturnType<typeof sidebar>>();
  let calls = 0;
  api.getSidebar = async () => (calls++ === 0 ? older.promise : newer.promise);

  const olderRefresh = useStudio.getState().refreshSidebar();
  const newerRefresh = useStudio.getState().refreshSidebar();
  newer.reject(new Error('temporary failure'));
  await newerRefresh;
  assert.equal(useStudio.getState().toasts.at(-1)?.text, '侧栏刷新失败：temporary failure');
  older.resolve(sidebar('older-success'));
  await olderRefresh;

  assert.equal(useStudio.getState().sidebar[0]?.sourceId, 'older-success');
});

test('a stale refresh failure after a newer applied success stays silent', async (t) => {
  resetStore();
  useStudio.setState({ activeProjectId: 'project-a' });
  const original = api.getSidebar;
  t.after(() => {
    api.getSidebar = original;
  });

  const slowOlder = deferred<ReturnType<typeof sidebar>>();
  const fastNewer = deferred<ReturnType<typeof sidebar>>();
  let calls = 0;
  api.getSidebar = async () => (calls++ === 0 ? slowOlder.promise : fastNewer.promise);

  const olderRefresh = useStudio.getState().refreshSidebar();
  const newerRefresh = useStudio.getState().refreshSidebar();
  fastNewer.resolve(sidebar('fresh'));
  assert.equal(await newerRefresh, true);
  slowOlder.reject(new Error('slow failure'));
  // Fresh data already landed, so the stale failure is noise: no toast,
  // and the caller-facing contract still reads as refreshed.
  assert.equal(await olderRefresh, true);

  assert.equal(useStudio.getState().sidebar[0]?.sourceId, 'fresh');
  assert.deepEqual(useStudio.getState().toasts, []);
});

test('a current refresh failure resolves false so callers can soften success claims', async (t) => {
  resetStore();
  useStudio.setState({ activeProjectId: 'project-a' });
  const original = api.getSidebar;
  t.after(() => {
    api.getSidebar = original;
  });
  api.getSidebar = async () => {
    throw new Error('sidebar offline');
  };

  assert.equal(await useStudio.getState().refreshSidebar(), false);
  assert.equal(useStudio.getState().toasts.at(-1)?.text, '侧栏刷新失败：sidebar offline');
});

test('WebSocket-triggered tree and sidebar refresh failures are caught and surfaced', async (t) => {
  resetStore();
  const original = {
    getTree: api.getTree,
    getSidebar: api.getSidebar,
  };
  t.after(() => Object.assign(api, original));
  api.getTree = async () => {
    throw new Error('tree offline');
  };
  api.getSidebar = async () => {
    throw new Error('sidebar offline');
  };
  useStudio.setState({ activeProjectId: 'project-a' });

  applyServerEnvelope({ kind: 'sidebar.updated', seq: 1, sourceId: 'canon' });
  applyServerEnvelope({ kind: 'graph.updated', seq: 2 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(
    useStudio.getState().toasts.map(({ kind, text }) => ({ kind, text })),
    [
      { kind: 'danger', text: '侧栏刷新失败：sidebar offline' },
      { kind: 'danger', text: '章节树刷新失败：tree offline' },
    ],
  );
});

test('selection thread exits focus mode before opening the right pane', async (t) => {
  resetStore();
  const originalCreateThread = api.createThread;
  t.after(() => {
    api.createThread = originalCreateThread;
  });

  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文',
        levels: [],
        leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null },
      },
      draftsDir: '草稿',
      sidebarSources: [],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'echo',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const thread = {
    id: 'thread-a',
    projectId: 'project-a',
    docId: documentB.doc.docId,
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '选区提问',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  api.createThread = async () => thread;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer', 'planner'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
    models: [],
  };
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    doc: documentB.doc,
    baseSha: documentB.doc.sha256,
    selection: { start: 0, end: 1, prefix: '', exact: 'B', suffix: '' },
    agents: [agent],
    agentsLoaded: true,
    focusMode: true,
    rightCollapsed: true,
  });

  await useStudio.getState().createThreadFromSelection('ask');

  assert.equal(useStudio.getState().focusMode, false);
  assert.equal(useStudio.getState().rightCollapsed, false);
  assert.equal(useStudio.getState().activeThread?.id, thread.id);
});

test('chapter generation preserves default-to-echo agent fallback', async (t) => {
  resetStore();
  const original = {
    createDraft: api.createDraft,
    createThread: api.createThread,
  };
  t.after(() => Object.assign(api, original));
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文',
        levels: [],
        leaf: {
          filePattern: '第{num}章.md',
          numberStyle: 'arabic',
          numberingScope: 'book',
          titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'claude',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const generated = {
    ...documentB.doc,
    docId: 'generated.md',
    title: 'Generated',
  };
  let selectedAgent: string | undefined;
  api.createDraft = async () => generated;
  api.createThread = async (input) => {
    assert.ok(input.agentId);
    selectedAgent = input.agentId;
    return {
      id: 'generated-thread',
      projectId: input.projectId,
      docId: input.docId,
      kind: input.kind,
      anchor: null,
      origin: 'generate',
      agentId: input.agentId,
      profile: 'writer',
      title: 'Generated',
      status: 'open',
      createdAt: 1,
      updatedAt: 1,
    };
  };
  useStudio.setState({
    activeProjectId: project.config.id,
    projects: [project],
    agents: [
      {
        agentId: 'claude',
        ok: false,
        supportedProfiles: ['writer'],
        version: null,
        binaryPath: 'claude',
        error: 'unavailable',
      },
      {
        agentId: 'echo',
        ok: true,
        supportedProfiles: ['writer'],
        version: 'test',
        binaryPath: 'echo',
        error: null,
      },
    ],
    agentsLoaded: true,
  });

  await useStudio.getState().startChapterGeneration({ title: 'Generated', target: 'draft' });

  assert.equal(selectedAgent, 'echo');
});

test('thread creation saves dirty editor snapshots before continuing', async (t) => {
  const originalCreateThread = api.createThread;
  const originalSaveDocument = useStudio.getState().saveDocument;
  t.after(() => {
    api.createThread = originalCreateThread;
    useStudio.setState({ saveDocument: originalSaveDocument });
  });
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文',
        levels: [],
        leaf: {
          filePattern: '第{num}章.md',
          numberStyle: 'arabic',
          numberingScope: 'book',
          titleStripRegex: null,
        },
      },
      draftsDir: '草稿',
      sidebarSources: [],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'echo',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
  };
  const thread = {
    id: 'saved-thread',
    projectId: 'project-a',
    docId: documentB.doc.docId,
    kind: 'rewrite' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: 'Saved thread',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const cases = [
    { action: 'selection', dirty: false, saved: 'saved', expectedCreates: 1, expectedSaves: 0 },
    { action: 'selection', dirty: true, saved: 'saved', expectedCreates: 1, expectedSaves: 1 },
    { action: 'selection', dirty: true, saved: 'conflict', expectedCreates: 0, expectedSaves: 1 },
    { action: 'selection', dirty: true, saved: 'saved-with-new-edits', expectedCreates: 0, expectedSaves: 1 },
    { action: 'whole', dirty: false, saved: 'saved', expectedCreates: 1, expectedSaves: 0 },
    { action: 'whole', dirty: true, saved: 'saved', expectedCreates: 1, expectedSaves: 1 },
    { action: 'whole', dirty: true, saved: 'conflict', expectedCreates: 0, expectedSaves: 1 },
    { action: 'whole', dirty: true, saved: 'saved-with-new-edits', expectedCreates: 0, expectedSaves: 1 },
  ] as const;

  for (const scenario of cases) {
    await t.test(`${scenario.action}: dirty=${scenario.dirty} save=${scenario.saved}`, async () => {
      resetStore();
      let creates = 0;
      let saves = 0;
      api.createThread = async (input) => {
        creates += 1;
        assert.ok(input.agentId);
        return { ...thread, kind: input.kind, agentId: input.agentId };
      };
      useStudio.setState({
        activeProjectId: project.config.id,
        projects: [project],
        doc: documentB.doc,
        baseSha: documentB.doc.sha256,
        editorContent: 'B',
        editorDirty: scenario.dirty,
        selection: { start: 0, end: 1, prefix: '', exact: 'B', suffix: '' },
        agents: [agent],
        agentsLoaded: true,
        saveDocument: async () => {
          saves += 1;
          if (scenario.saved === 'saved') useStudio.setState({ editorDirty: false });
          return scenario.saved;
        },
      });

      if (scenario.action === 'selection') {
        await useStudio.getState().createThreadFromSelection('ask');
      } else {
        await useStudio.getState().createWholeDocRewriteThread();
      }

      assert.equal(saves, scenario.expectedSaves);
      assert.equal(creates, scenario.expectedCreates);
      if (scenario.saved === 'conflict') {
        assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /保存冲突/);
      }
      if (scenario.saved === 'saved-with-new-edits') {
        assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /保存期间正文继续变化/);
      }
    });
  }
});

test('accepted agent envelopes capture manifest and retain it after the run ends', async (t) => {
  resetStore();
  const originalGetThread = api.getThread;
  t.after(() => {
    api.getThread = originalGetThread;
  });
  const thread = {
    id: 'thread-manifest',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: 'manifest',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  api.getThread = async () => ({ thread, messages: [] });
  const manifest = [{
    sourceId: 'document:doc-b.md',
    originalChars: 10,
    injectedChars: 10,
    truncated: false,
    quotaChars: 100,
    trigger: 'always' as const,
  }];
  useStudio.setState({
    activeThread: thread,
    running: true,
    activeRunId: 'run-manifest',
    runGeneration: 1,
    runManifest: null,
  });

  useStudio.getState().applyAgentEvent(
    'run-manifest',
    thread.id,
    { type: 'delta', text: 'ok' },
    manifest,
  );
  assert.deepEqual(useStudio.getState().runManifest, manifest);

  useStudio.getState().applyAgentEvent('run-manifest', thread.id, { type: 'done' });
  await Promise.resolve();
  assert.equal(useStudio.getState().running, false);
  assert.deepEqual(useStudio.getState().runManifest, manifest);
});

test('agent failures show detail inline and use authentication guidance', async (t) => {
  resetStore();
  const originalGetThread = api.getThread;
  t.after(() => { api.getThread = originalGetThread; });
  const thread = {
    id: 'thread-error-detail',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'claude' as const,
    profile: 'writer' as const,
    title: 'error detail',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  api.getThread = async () => ({ thread, messages: [] });
  useStudio.setState({
    activeThread: thread,
    running: true,
    activeRunId: 'run-error-detail',
    runGeneration: 1,
  });
  useStudio.getState().applyAgentEvent('run-error-detail', thread.id, {
    type: 'error',
    code: 'cli_not_authenticated',
    message: 'agent CLI is not authenticated',
    retryable: false,
    detail: 'OAuth session expired',
  });
  await Promise.resolve();
  assert.match(useStudio.getState().runError ?? '', /该 CLI 未登录或凭据过期/);
  assert.match(useStudio.getState().runError ?? '', /OAuth session expired/);
  assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /OAuth session expired/);
});

test('deleting an open draft resets editor, generation, and thread workspace state', async (t) => {
  resetStore();
  const original = {
    deleteDraft: api.deleteDraft,
    listDrafts: api.listDrafts,
    getTree: api.getTree,
  };
  t.after(() => {
    api.deleteDraft = original.deleteDraft;
    api.listDrafts = original.listDrafts;
    api.getTree = original.getTree;
  });
  const draft = {
    docId: '草稿/2026-07-23_打开中.md',
    projectId: 'project-a',
    kind: 'draft' as const,
    title: '打开中',
    chapterNo: null,
    sha256: 'd'.repeat(64),
    bytes: 12,
    mtimeMs: 1,
  };
  const thread = {
    id: 'thread-deleted-draft',
    projectId: 'project-a',
    docId: draft.docId,
    kind: 'rewrite' as const,
    origin: 'generate' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: 'generate',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  let deletedDocId = '';
  api.deleteDraft = async (_pid, docId) => {
    deletedDocId = docId;
    return { docId, trashedDocId: `草稿/.trash/2026-07-23T00:00:00.000Z_${docId.split('/').at(-1)}` };
  };
  api.listDrafts = async () => [];
  api.getTree = async () => tree;
  useStudio.setState({
    activeProjectId: 'project-a',
    doc: draft,
    docContent: '# 打开中',
    editorContent: '# 未保存修改',
    editorDirty: true,
    baseSha: draft.sha256,
    selection: { start: 0, end: 1, prefix: '', exact: '#', suffix: '' },
    threads: [thread],
    activeThread: thread,
    messages: [{
      id: 'message',
      threadId: thread.id,
      role: 'user',
      agentId: null,
      content: '生成',
      structured: null,
      createdAt: 1,
    }],
    appMode: 'generate',
    generateDoc: draft,
    beats: ['第一拍'],
    beatTexts: ['候选'],
  });

  assert.equal(await useStudio.getState().deleteDraft(draft.docId), true);
  assert.equal(deletedDocId, draft.docId);
  const state = useStudio.getState();
  assert.equal(state.doc, null);
  assert.equal(state.editorContent, '');
  assert.equal(state.editorDirty, false);
  assert.equal(state.generateDoc, null);
  assert.equal(state.appMode, 'writing');
  assert.equal(state.activeThread, null);
  assert.deepEqual(state.threads, []);
  assert.deepEqual(state.messages, []);
  assert.match(state.toasts.at(-1)?.text ?? '', /已关闭当前工作区/);
});

test('restoring a draft refreshes drafts and trash and reports a human conflict', async (t) => {
  resetStore();
  const original = {
    restoreDraft: api.restoreDraft,
    listDrafts: api.listDrafts,
    listTrash: api.listTrash,
  };
  t.after(() => {
    api.restoreDraft = original.restoreDraft;
    api.listDrafts = original.listDrafts;
    api.listTrash = original.listTrash;
  });
  const trashedDocId = '草稿/.trash/2026-07-25T01:02:03.004Z_恢复.md';
  const restoredDraft = {
    docId: '草稿/恢复.md',
    projectId: 'project-a',
    kind: 'draft' as const,
    title: '恢复',
    chapterNo: null,
    sha256: 'e'.repeat(64),
    bytes: 12,
    mtimeMs: 1,
  };
  let restoreCalls = 0;
  let draftRefreshes = 0;
  let trashRefreshes = 0;
  api.restoreDraft = async (_pid, docId) => {
    restoreCalls += 1;
    return { trashedDocId: docId, docId: restoredDraft.docId };
  };
  api.listDrafts = async () => {
    draftRefreshes += 1;
    return [restoredDraft];
  };
  api.listTrash = async () => {
    trashRefreshes += 1;
    return [];
  };
  useStudio.setState({ activeProjectId: 'project-a' });

  assert.equal(await useStudio.getState().restoreDraft(trashedDocId), true);
  assert.equal(restoreCalls, 1);
  assert.equal(draftRefreshes, 1);
  assert.equal(trashRefreshes, 1);
  assert.deepEqual(useStudio.getState().drafts, [restoredDraft]);
  assert.deepEqual(useStudio.getState().trash, []);
  assert.equal(useStudio.getState().trashRestoringDocId, null);
  assert.equal(useStudio.getState().toasts.at(-1)?.text, '草稿已恢复');

  api.restoreDraft = async () => {
    throw new ApiError('CONFLICT', 'draft already exists');
  };
  assert.equal(await useStudio.getState().restoreDraft(trashedDocId), false);
  assert.equal(draftRefreshes, 1);
  assert.equal(trashRefreshes, 1);
  assert.equal(
    useStudio.getState().toasts.at(-1)?.text,
    '草稿区已有同名文件，请先处理现有文件再恢复',
  );
});

test('restore disables a second item while the first restore is in flight', async (t) => {
  resetStore();
  const original = {
    restoreDraft: api.restoreDraft,
    listDrafts: api.listDrafts,
    listTrash: api.listTrash,
  };
  t.after(() => {
    api.restoreDraft = original.restoreDraft;
    api.listDrafts = original.listDrafts;
    api.listTrash = original.listTrash;
  });
  const firstId = '草稿/.trash/2026-07-25T01:02:03.004Z_第一.md';
  const secondId = '草稿/.trash/2026-07-25T01:02:04.004Z_第二.md';
  const firstRestore = deferred<{ trashedDocId: string; docId: string }>();
  let restoreCalls = 0;
  api.restoreDraft = async (_pid, docId) => {
    restoreCalls += 1;
    return firstRestore.promise.then(() => ({ trashedDocId: docId, docId: '草稿/第一.md' }));
  };
  api.listDrafts = async () => [];
  api.listTrash = async () => [];
  useStudio.setState({ activeProjectId: 'project-a' });

  const first = useStudio.getState().restoreDraft(firstId);
  assert.equal(useStudio.getState().trashRestoringDocId, firstId);
  assert.equal(await useStudio.getState().restoreDraft(secondId), false);
  assert.equal(restoreCalls, 1);
  assert.equal(useStudio.getState().trashRestoringDocId, firstId);

  firstRestore.resolve({ trashedDocId: firstId, docId: '草稿/第一.md' });
  assert.equal(await first, true);
  assert.equal(useStudio.getState().trashRestoringDocId, null);
});

test('late drafts and trash responses cannot overwrite post-restore lists', async (t) => {
  resetStore();
  const original = {
    restoreDraft: api.restoreDraft,
    listDrafts: api.listDrafts,
    listTrash: api.listTrash,
  };
  t.after(() => {
    api.restoreDraft = original.restoreDraft;
    api.listDrafts = original.listDrafts;
    api.listTrash = original.listTrash;
  });
  const staleDrafts = deferred<Awaited<ReturnType<typeof api.listDrafts>>>();
  const staleTrash = deferred<Awaited<ReturnType<typeof api.listTrash>>>();
  const freshDraft = {
    docId: '草稿/已恢复.md',
    projectId: 'project-a',
    kind: 'draft' as const,
    title: '已恢复',
    chapterNo: null,
    sha256: 'f'.repeat(64),
    bytes: 12,
    mtimeMs: 2,
  };
  const staleTrashEntry = {
    trashedDocId: '草稿/.trash/2026-07-25T01:02:03.004Z_已恢复.md',
    originalName: '已恢复.md',
    deletedAt: '2026-07-25T01:02:03.004Z',
    title: '已恢复',
  };
  let draftsCalls = 0;
  let trashCalls = 0;
  api.listDrafts = async () => (++draftsCalls === 1 ? staleDrafts.promise : [freshDraft]);
  api.listTrash = async () => (++trashCalls === 1 ? staleTrash.promise : []);
  api.restoreDraft = async (_pid, docId) => ({ trashedDocId: docId, docId: freshDraft.docId });
  useStudio.setState({ activeProjectId: 'project-a' });

  const oldDraftsRequest = useStudio.getState().refreshDrafts();
  const oldTrashRequest = useStudio.getState().listTrash();
  assert.equal(await useStudio.getState().restoreDraft(staleTrashEntry.trashedDocId), true);
  assert.deepEqual(useStudio.getState().drafts, [freshDraft]);
  assert.deepEqual(useStudio.getState().trash, []);

  staleDrafts.resolve([]);
  staleTrash.resolve([staleTrashEntry]);
  await Promise.all([oldDraftsRequest, oldTrashRequest]);
  assert.deepEqual(useStudio.getState().drafts, [freshDraft]);
  assert.deepEqual(useStudio.getState().trash, []);
});

test('restore warns when either post-success list refresh fails', async (t) => {
  resetStore();
  const original = {
    restoreDraft: api.restoreDraft,
    listDrafts: api.listDrafts,
    listTrash: api.listTrash,
  };
  t.after(() => {
    api.restoreDraft = original.restoreDraft;
    api.listDrafts = original.listDrafts;
    api.listTrash = original.listTrash;
  });
  const trashedDocId = '草稿/.trash/2026-07-25T01:02:03.004Z_恢复.md';
  api.restoreDraft = async (_pid, docId) => ({ trashedDocId: docId, docId: '草稿/恢复.md' });
  api.listDrafts = async () => {
    throw new Error('draft refresh failed');
  };
  api.listTrash = async () => [];
  useStudio.setState({ activeProjectId: 'project-a' });

  assert.equal(await useStudio.getState().restoreDraft(trashedDocId), true);
  assert.deepEqual(useStudio.getState().toasts.at(-1), {
    id: useStudio.getState().toasts.at(-1)?.id,
    kind: 'warning',
    text: '草稿已恢复，但列表刷新不完整；请稍后重试',
  });
});

test('external file.changed refreshes both tree and recap sidebar through request gates', async (t) => {
  resetStore();
  const original = {
    getTree: api.getTree,
    getSidebar: api.getSidebar,
  };
  t.after(() => {
    api.getTree = original.getTree;
    api.getSidebar = original.getSidebar;
  });
  const externalTree = {
    root: {
      name: 'root',
      levelName: 'root',
      children: [],
      chapters: [{
        docId: '正文/第3章.md',
        projectId: 'project-a',
        kind: 'chapter' as const,
        title: '外部新增',
        chapterNo: 3,
        sha256: '3'.repeat(64),
        bytes: 12,
        mtimeMs: 3,
      }],
    },
  };
  api.getTree = async () => externalTree;
  api.getSidebar = async () => sidebar('writing-status');
  useStudio.setState({ activeProjectId: 'project-a', tree, sidebar: [] });

  applyServerEnvelope({
    kind: 'file.changed',
    seq: 1,
    docId: '正文/第3章.md',
    sha256: '3'.repeat(64),
    source: 'external',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(useStudio.getState().tree, externalTree);
  assert.deepEqual(useStudio.getState().sidebar, sidebar('writing-status'));
});

test('graph.updated refreshes the REST tree after an external chapter invalidation', async (t) => {
  resetStore();
  const originalGetTree = api.getTree;
  t.after(() => {
    api.getTree = originalGetTree;
  });
  const externalTree = {
    root: {
      name: 'root',
      levelName: 'root',
      children: [],
      chapters: [{
        docId: '正文/第4章.md',
        projectId: 'project-a',
        kind: 'chapter' as const,
        title: '监视器新增',
        chapterNo: 4,
        sha256: '4'.repeat(64),
        bytes: 12,
        mtimeMs: 4,
      }],
    },
  };
  api.getTree = async () => externalTree;
  useStudio.setState({ activeProjectId: 'project-a', tree });

  applyServerEnvelope({ kind: 'graph.updated', seq: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.deepEqual(useStudio.getState().tree, externalTree);
});

test('payload-free relation graph.updated bursts refresh /tree at most once per debounce window', async (t) => {
  resetStore();
  const originalGetTree = api.getTree;
  t.after(() => {
    api.getTree = originalGetTree;
  });
  let treeCalls = 0;
  api.getTree = async () => {
    treeCalls += 1;
    return tree;
  };
  useStudio.setState({ activeProjectId: 'project-a', tree });

  applyServerEnvelope({ kind: 'graph.updated', seq: 1 });
  applyServerEnvelope({ kind: 'graph.updated', seq: 2 });
  applyServerEnvelope({ kind: 'graph.updated', seq: 3 });
  assert.equal(treeCalls, 0, 'tree refresh should wait for the debounce window');
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(treeCalls, 1);
});

test('an explicit empty model catalog still sends a saved custom model', async (t) => {
  resetStore();
  const originalPostMessage = api.postMessage;
  const originalGetRun = api.getRun;
  t.after(() => {
    api.postMessage = originalPostMessage;
    api.getRun = originalGetRun;
  });

  const thread = {
    id: 'thread-model',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '模型测试',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
    models: [],
  };
  let requestOptions: { model?: string } | undefined;
  api.postMessage = async (_tid, _content, options) => {
    requestOptions = options;
    return { runId: 'run-model' };
  };
  api.getRun = async () => ({
    id: 'run-model',
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  useStudio.setState({
    activeThread: thread,
    agents: [agent],
    agentsLoaded: true,
    modelPrefs: {},
  });
  useStudio.getState().setAgentModel('echo', 'custom-local-model');
  assert.equal(stored.get('ws-model-prefs'), JSON.stringify({ echo: 'custom-local-model' }));

  assert.equal(await useStudio.getState().sendMessage('hello', false), true);
  assert.deepEqual(requestOptions, { model: 'custom-local-model' });
});

test('a catalog default is sent when no model preference is saved', async (t) => {
  resetStore();
  const originalPostMessage = api.postMessage;
  const originalGetRun = api.getRun;
  t.after(() => {
    api.postMessage = originalPostMessage;
    api.getRun = originalGetRun;
  });

  const thread = {
    id: 'thread-catalog-default',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '目录默认值测试',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
    models: [
      { id: 'echo-1', label: 'Echo 1', isDefault: true },
      { id: 'echo-verbose', label: 'Echo verbose' },
    ],
  };
  let requestOptions: { model?: string } | undefined;
  api.postMessage = async (_tid, _content, options) => {
    requestOptions = options;
    return { runId: 'run-catalog-default' };
  };
  api.getRun = async () => ({
    id: 'run-catalog-default',
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  useStudio.setState({
    activeThread: thread,
    agents: [agent],
    agentsLoaded: true,
    modelPrefs: {},
  });

  assert.equal(await useStudio.getState().sendMessage('hello', false), true);
  assert.deepEqual(requestOptions, { model: 'echo-1' });
});

test('an explicit model preference overrides the catalog default', async (t) => {
  resetStore();
  const originalPostMessage = api.postMessage;
  const originalGetRun = api.getRun;
  t.after(() => {
    api.postMessage = originalPostMessage;
    api.getRun = originalGetRun;
  });

  const thread = {
    id: 'thread-catalog-preference',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '显式模型测试',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
    models: [{ id: 'echo-1', label: 'Echo 1', isDefault: true }],
  };
  let requestOptions: { model?: string } | undefined;
  api.postMessage = async (_tid, _content, options) => {
    requestOptions = options;
    return { runId: 'run-catalog-preference' };
  };
  api.getRun = async () => ({
    id: 'run-catalog-preference',
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  useStudio.setState({
    activeThread: thread,
    agents: [agent],
    agentsLoaded: true,
    modelPrefs: { echo: 'custom-local-model' },
  });

  assert.equal(await useStudio.getState().sendMessage('hello', false), true);
  assert.deepEqual(requestOptions, { model: 'custom-local-model' });
});

test('model selection stays feature-gated when the catalog is absent', async (t) => {
  resetStore();
  const originalPostMessage = api.postMessage;
  const originalGetRun = api.getRun;
  t.after(() => {
    api.postMessage = originalPostMessage;
    api.getRun = originalGetRun;
  });

  const thread = {
    id: 'thread-no-catalog',
    projectId: 'project-a',
    docId: 'doc-b.md',
    kind: 'ask' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '无目录测试',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const agent: AgentAvailability = {
    agentId: 'echo',
    ok: true,
    supportedProfiles: ['writer'],
    version: 'test',
    binaryPath: 'echo',
    error: null,
  };
  let requestOptions: { model?: string } | undefined;
  api.postMessage = async (_tid, _content, options) => {
    requestOptions = options;
    return { runId: 'run-no-catalog' };
  };
  api.getRun = async () => ({
    id: 'run-no-catalog',
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  useStudio.setState({
    activeThread: thread,
    agents: [agent],
    agentsLoaded: true,
    modelPrefs: { echo: 'custom-local-model' },
  });

  assert.equal(await useStudio.getState().sendMessage('hello', false), true);
  assert.deepEqual(requestOptions, {});
});

test('whole-document rewrite rejects the friendly size limit before creating a thread', async (t) => {
  resetStore();
  const originalCreateThread = api.createThread;
  t.after(() => {
    api.createThread = originalCreateThread;
  });
  let calls = 0;
  api.createThread = async () => {
    calls += 1;
    throw new Error('must not create');
  };
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文', levels: [],
        leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null },
      },
      draftsDir: '草稿',
      sidebarSources: [],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'echo',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    doc: documentB.doc,
    baseSha: documentB.doc.sha256,
    editorContent: 'a'.repeat(16_001),
    editorDirty: false,
  });

  await useStudio.getState().createWholeDocRewriteThread();

  assert.equal(calls, 0);
  assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /超过 16,000 字符/);
});

test('whole-document candidates bind to the saved creation and send baseline', async (t) => {
  resetStore();
  const original = { createThread: api.createThread, postMessage: api.postMessage };
  t.after(() => Object.assign(api, original));
  const project = {
    config: {
      schemaVersion: 1,
      id: 'project-a',
      displayName: 'Project A',
      contentTree: {
        root: '正文', levels: [],
        leaf: { filePattern: '第{num}章.md', numberStyle: 'arabic', numberingScope: 'book', titleStripRegex: null },
      },
      draftsDir: '草稿',
      sidebarSources: [],
      aiProfiles: {
        writer: { description: '', readable: [], forbidden: [], allowVaultBrowsing: false },
        planner: { description: '', readable: [], forbidden: [], allowVaultBrowsing: true },
        defaultProfile: 'writer',
      },
      defaultAgentId: 'echo',
    },
    vaultRoot: '/tmp/project-a',
    dataDir: '/tmp/project-a-data',
  } satisfies Project;
  const wholeThread = {
    id: 'whole-thread',
    projectId: 'project-a',
    docId: documentB.doc.docId,
    kind: 'rewrite' as const,
    anchor: null,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '整章意见',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const agent: AgentAvailability = {
    agentId: 'echo', ok: true, supportedProfiles: ['writer'], version: 'test', binaryPath: 'echo', error: null,
  };
  api.createThread = async () => wholeThread;
  let sent = 0;
  api.postMessage = async () => {
    sent += 1;
    return { runId: 'whole-run' };
  };
  useStudio.setState({
    activeProjectId: 'project-a',
    projects: [project],
    doc: documentB.doc,
    baseSha: documentB.doc.sha256,
    editorContent: 'short manuscript',
    editorDirty: false,
    agents: [agent],
    agentsLoaded: true,
  });

  await useStudio.getState().createWholeDocRewriteThread();
  const baseline = useStudio.getState().wholeDocThreadBaselines[wholeThread.id];
  assert.deepEqual(baseline, {
    projectId: 'project-a', docId: documentB.doc.docId, baseSha: documentB.doc.sha256, content: 'short manuscript',
  });
  assert.equal(await useStudio.getState().sendMessage('润色整章', true), true);
  assert.equal(sent, 1);
  assert.equal(useStudio.getState().pendingWholeDocRunBaseline?.content, 'short manuscript');

  useStudio.setState({ running: false, editorContent: 'edited after sending', editorDirty: true });
  assert.equal(await useStudio.getState().sendMessage('再次润色', true), false);
  assert.equal(sent, 1);

  const assistant = {
    id: 'whole-answer', threadId: wholeThread.id, role: 'assistant' as const, agentId: 'echo' as const,
    content: 'short manuscript revised', structured: null, createdAt: 2,
  };
  useStudio.setState({
    messages: [assistant],
    wholeDocMessageBaselines: { [assistant.id]: baseline! },
  });
  useStudio.getState().openRewriteReview(assistant.id);
  assert.equal(useStudio.getState().rewriteReview, null);
  assert.match(useStudio.getState().toasts.at(-1)?.text ?? '', /正文已变化/);

  useStudio.setState({
    editorContent: 'short manuscript',
    editorDirty: false,
    messages: [assistant],
    wholeDocMessageBaselines: { [assistant.id]: baseline! },
  });
  useStudio.getState().openRewriteReview(assistant.id);
  assert.equal(useStudio.getState().rewriteReview?.wholeDoc, true);
  assert.equal(useStudio.getState().rewriteReview?.originalText, 'short manuscript');
  assert.equal(useStudio.getState().rewriteReview?.wholeDocBaseSha, documentB.doc.sha256);
});

test('generation beats advance, rewrite, survive cancellation, and adopt the composed text', async (t) => {
  resetStore();
  const original = {
    postMessage: api.postMessage,
    getRun: api.getRun,
    getThread: api.getThread,
    getDocument: api.getDocument,
    createRevision: api.createRevision,
    putDocument: api.putDocument,
    openDocument: useStudio.getState().openDocument,
  };
  t.after(() => {
    Object.assign(api, {
      postMessage: original.postMessage,
      getRun: original.getRun,
      getThread: original.getThread,
      getDocument: original.getDocument,
      createRevision: original.createRevision,
      putDocument: original.putDocument,
    });
    useStudio.setState({ openDocument: original.openDocument });
  });

  const thread = {
    id: 'generate-thread',
    projectId: 'project-a',
    docId: 'generated.md',
    kind: 'rewrite' as const,
    anchor: null,
    origin: 'generate' as const,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '生成',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  const generatedDoc = {
    docId: 'generated.md',
    projectId: 'project-a',
    kind: 'chapter' as const,
    title: '生成章',
    chapterNo: 3,
    sha256: 'c'.repeat(64),
    bytes: 0,
    mtimeMs: 1,
  };
  const sent: string[] = [];
  let runNo = 0;
  let durableMessages: Array<{
    id: string;
    threadId: string;
    role: 'assistant';
    agentId: 'echo';
    content: string;
    structured: null;
    createdAt: number;
  }> = [];
  api.postMessage = async (_threadId, content) => {
    sent.push(content);
    runNo += 1;
    return { runId: `beat-run-${runNo}` };
  };
  api.getRun = async (runId) => ({
    id: runId,
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  api.getThread = async () => ({ thread, messages: durableMessages });
  useStudio.setState({
    activeProjectId: 'project-a',
    generateDoc: generatedDoc,
    activeThread: thread,
    agents: [{
      agentId: 'echo',
      ok: true,
      supportedProfiles: ['writer'],
      version: 'test',
      binaryPath: 'echo',
      error: null,
    }],
  });

  assert.equal(
    await useStudio.getState().startGenerationBeats('相遇\n---\n交锋\n---\n离开'),
    true,
  );
  assert.equal(sent[0], '【本拍章纲】\n相遇\n\n【写作要求】只写到本拍情节结束即停笔，不要预写后续拍。');
  durableMessages = [{
    id: 'a1', threadId: thread.id, role: 'assistant', agentId: 'echo',
    content: '第一拍正文', structured: null, createdAt: 2,
  }];
  useStudio.getState().applyAgentEvent('beat-run-1', thread.id, {
    type: 'done', stopReason: 'end_turn',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useStudio.getState().beatPhase, 'awaiting-confirm');
  assert.deepEqual(useStudio.getState().beatTexts, ['第一拍正文', '', '']);

  assert.equal(await useStudio.getState().continueGenerationBeat(), true);
  assert.match(sent[1] ?? '', /【前文已定稿，从此处继续】[\s\S]*【本拍章纲】\n交锋/);
  durableMessages = [...durableMessages, {
    id: 'a2', threadId: thread.id, role: 'assistant', agentId: 'echo',
    content: '第二拍初稿', structured: null, createdAt: 3,
  }];
  useStudio.getState().applyAgentEvent('beat-run-2', thread.id, {
    type: 'done', stopReason: 'end_turn',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await useStudio.getState().rewriteGenerationBeat('收紧对话'), true);
  assert.match(sent[2] ?? '', /【作者意见】\n收紧对话[\s\S]*【本拍章纲】\n交锋/);
  durableMessages = [...durableMessages, {
    id: 'a3', threadId: thread.id, role: 'assistant', agentId: 'echo',
    content: '第二拍定稿', structured: null, createdAt: 4,
  }];
  useStudio.getState().applyAgentEvent('beat-run-3', thread.id, {
    type: 'done', stopReason: 'end_turn',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useStudio.getState().beatTexts[1], '第二拍定稿');

  assert.equal(await useStudio.getState().continueGenerationBeat(), true);
  useStudio.getState().applyAgentEvent('beat-run-4', thread.id, {
    type: 'done', stopReason: 'cancelled',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useStudio.getState().beatPhase, 'writing');
  assert.equal(useStudio.getState().beatTexts[2], '');

  assert.equal(await useStudio.getState().retryGenerationBeat(), true);
  durableMessages = [...durableMessages, {
    id: 'a4', threadId: thread.id, role: 'assistant', agentId: 'echo',
    content: '第三拍正文', structured: null, createdAt: 5,
  }];
  useStudio.getState().applyAgentEvent('beat-run-5', thread.id, {
    type: 'done', stopReason: 'end_turn',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(useStudio.getState().beatPhase, 'done');

  let revisionContent = '';
  let writtenContent = '';
  api.getDocument = async () => ({ doc: generatedDoc, content: '', anchors: [] });
  api.createRevision = async (_pid, _docId, input) => {
    revisionContent = input.content;
    return {
      id: 'revision',
      projectId: 'project-a',
      docId: generatedDoc.docId,
      kind: input.kind,
      sha256: 'd'.repeat(64),
      createdAt: 1,
      sourceThreadId: input.sourceThreadId ?? null,
      label: input.label ?? null,
    };
  };
  api.putDocument = async (_pid, _docId, content) => {
    writtenContent = content;
    return generatedDoc;
  };
  useStudio.setState({ openDocument: async () => true });

  await useStudio.getState().adoptGeneratedChapter();
  assert.equal(revisionContent, '第一拍正文\n\n第二拍定稿\n\n第三拍正文');
  assert.equal(writtenContent, revisionContent);
});

test('single-beat generation sends the original outline byte-for-byte', async (t) => {
  resetStore();
  const original = { postMessage: api.postMessage, getRun: api.getRun };
  t.after(() => Object.assign(api, original));
  const thread = {
    id: 'legacy-generate',
    projectId: 'project-a',
    docId: 'generated.md',
    kind: 'rewrite' as const,
    anchor: null,
    origin: 'generate' as const,
    agentId: 'echo' as const,
    profile: 'writer' as const,
    title: '生成',
    status: 'open' as const,
    createdAt: 1,
    updatedAt: 1,
  } satisfies Thread;
  let sent = '';
  api.postMessage = async (_threadId, content) => {
    sent = content;
    return { runId: 'legacy-run' };
  };
  api.getRun = async () => ({
    id: 'legacy-run',
    projectId: 'project-a',
    threadId: thread.id,
    agentId: 'echo',
    status: 'running',
    errorCode: null,
    createdAt: 1,
    finishedAt: null,
  });
  useStudio.setState({ activeThread: thread });
  const outline = '  原始章纲\r\n保留尾空格  \n';
  assert.equal(await useStudio.getState().startGenerationBeats(outline), true);
  assert.equal(sent, outline);
});
