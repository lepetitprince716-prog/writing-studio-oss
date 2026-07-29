/**
 * AI thread panel: selection → ask/rewrite thread, message history,
 * streaming output, tool activity, usage meta, stop. Composer keys follow the
 * CLI feel: Enter sends, Shift+Enter breaks the line, Esc stops the run.
 * The model selector renders only when the agent's availability record
 * advertises a model catalog (server-side feature gate).
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { AgentId, ConflictCheckResponse, Message, Thread } from '@writing-studio/contract';
import { api } from '../api.js';
import { findCatalogDefault, useStudio } from '../store.js';
import { copyText, copyTextDeferred } from '../lib/clipboard.js';
import { onActivateKey } from '../lib/keyboard.js';
import { ContextMenu, useContextMenu } from './ContextMenu.js';
import { Empty } from './Empty.js';
import { FeatureErrorBoundary } from './FeatureErrorBoundary.js';
import { MousePointerClickIcon } from './icons.js';
import { Modal } from './Modal.js';
import { ContextManifestPanel } from './ContextManifestPanel.js';
import { ConflictFindingsPanel } from './ConflictFindingsPanel.js';
import { formatPersonaLabel } from '../lib/memory-cutoff.js';
import { createMessageMenuSpec, createThreadMenuSpec } from './thread-menu-specs.js';

const LazySafeMarkdown = lazy(async () => {
  const module = await import('./SafeMarkdown.js');
  return { default: module.SafeMarkdown };
});

const TOOL_STATUS_LABEL: Record<string, string> = {
  requested: '调用中',
  completed: '完成',
  denied: '被拒绝',
  failed: '失败',
};

/** Mirrors the contract's agentModelIdSchema (argv-safe model ids). */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const MODEL_ID_MAX = 120;
const DEFAULT_MODEL_VALUE = '__default__';
const CUSTOM_MODEL_VALUE = '__custom__';

/** Composer height bounds (px); grows with content like a CLI prompt. */
const COMPOSER_MIN_H = 44;
const COMPOSER_MAX_H = 180;

/** Keep auto-scroll pinned unless the user scrolled up beyond this slack. */
const STICK_SLACK_PX = 48;

function PlainMessage({ markdown }: { markdown: string }): React.JSX.Element {
  // React escapes text children, so a chunk/render failure still cannot turn
  // assistant output into active markup. Keep the original text available
  // without letting one failed message escape its row boundary.
  return <pre className="message-plain">{markdown}</pre>;
}

function MarkdownMessage({ markdown }: { markdown: string }): React.JSX.Element {
  const plain = <PlainMessage markdown={markdown} />;
  return (
    <FeatureErrorBoundary
      featureName="消息 Markdown"
      fallback={plain}
    >
      <Suspense fallback={plain}>
        <LazySafeMarkdown markdown={markdown} />
      </Suspense>
    </FeatureErrorBoundary>
  );
}

export function ThreadPanel(): React.JSX.Element {
  const selection = useStudio((s) => s.selection);
  const threads = useStudio((s) => s.threads);
  const activeThread = useStudio((s) => s.activeThread);
  const messages = useStudio((s) => s.messages);
  const streamingText = useStudio((s) => s.streamingText);
  const running = useStudio((s) => s.running);
  const runTools = useStudio((s) => s.runTools);
  const runUsage = useStudio((s) => s.runUsage);
  const runManifest = useStudio((s) => s.runManifest);
  const runError = useStudio((s) => s.runError);
  const modelPrefs = useStudio((s) => s.modelPrefs);
  const composerFocusNonce = useStudio((s) => s.composerFocusNonce);
  const agents = useStudio((s) => s.agents);
  const agentsLoaded = useStudio((s) => s.agentsLoaded);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const activeProject = useStudio((s) =>
    s.projects.find((project) => project.config.id === activeProjectId),
  );
  const [input, setInput] = useState('');
  const [customModel, setCustomModel] = useState<{ agentId: AgentId; value: string } | null>(null);
  const [renamingThread, setRenamingThread] = useState<{ id: string; title: string } | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const menu = useContextMenu();

  const doc = useStudio((s) => s.doc);
  const chatThreads = useStudio((s) => s.chatThreads);
  const loadChatThreads = useStudio((s) => s.loadChatThreads);
  const createThread = useStudio((s) => s.createThreadFromSelection);
  const createWholeDocThread = useStudio((s) => s.createWholeDocRewriteThread);
  const openThread = useStudio((s) => s.openThread);
  const renameThread = useStudio((s) => s.renameThread);
  const setThreadAgent = useStudio((s) => s.setThreadAgent);
  const setAgentModel = useStudio((s) => s.setAgentModel);
  const sendMessage = useStudio((s) => s.sendMessage);
  const stopRun = useStudio((s) => s.stopRun);
  const openRewriteReview = useStudio((s) => s.openRewriteReview);
  const revealTextQuote = useStudio((s) => s.revealTextQuote);
  const openCanonSource = useStudio((s) => s.openCanonSource);
  const startCanonRewriteFromFinding = useStudio((s) => s.startCanonRewriteFromFinding);

  async function send(): Promise<void> {
    if (!input.trim() || !activeThread || running) return;
    const content = input;
    if (await sendMessage(content, activeThread.kind === 'rewrite')) setInput('');
  }

  // Composer focus requests come from the store (thread created/opened).
  useEffect(() => {
    if (composerFocusNonce > 0) composerRef.current?.focus();
  }, [composerFocusNonce]);

  // Chat history is project-level; refresh it whenever the project changes.
  useEffect(() => {
    if (activeProjectId) void loadChatThreads();
  }, [activeProjectId, loadChatThreads]);

  // Grow the composer with its content, clamped like a CLI prompt.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = 'auto';
    composer.style.height = `${Math.min(COMPOSER_MAX_H, Math.max(COMPOSER_MIN_H, composer.scrollHeight))}px`;
  }, [input, activeThread?.id]);

  // Follow the stream unless the user scrolled up to read history.
  useEffect(() => {
    const list = listRef.current;
    if (list && stickToBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [messages, streamingText, runTools, running]);

  // Each thread owns an independent message history. Returning to a thread
  // should start at its latest message even if the previous thread was
  // scrolled up for reading.
  useEffect(() => {
    stickToBottomRef.current = true;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [activeThread?.id]);

  // A menu describes one concrete thread/document snapshot; discard it when
  // navigation changes so actions cannot target stale rows.
  useEffect(() => {
    menu.close();
  }, [activeProjectId, activeThread?.id, doc?.docId, menu.close]);

  const defaultProfile = activeProject?.config.aiProfiles.defaultProfile ?? 'writer';
  const canCreateThread = agentsLoaded && agents.some(
    (agent) => agent.ok && agent.supportedProfiles.includes(defaultProfile),
  );
  const activeAvailability = activeThread
    ? agents.find((agent) => agent.agentId === activeThread.agentId)
    : undefined;
  const activeAgentUsable = Boolean(
    activeThread
      && activeAvailability?.ok
      && activeAvailability.supportedProfiles.includes(activeThread.profile),
  );
  // `undefined` means the agent does not implement model selection. An empty
  // catalog is still an explicit capability and keeps custom input available.
  const models = activeAvailability?.models;
  const currentModel = activeThread ? modelPrefs[activeThread.agentId] ?? '' : '';
  const catalogDefault = findCatalogDefault(models);
  const modelSelectValue = currentModel || DEFAULT_MODEL_VALUE;
  const lastTool = runTools[runTools.length - 1];
  const showUsage = !running && runUsage
    && (runUsage.inputTokens > 0 || runUsage.outputTokens > 0 || runUsage.costUsd > 0);

  function onModelChange(agentId: AgentId, value: string): void {
    if (value === DEFAULT_MODEL_VALUE) {
      setAgentModel(agentId, null);
      return;
    }
    if (value === CUSTOM_MODEL_VALUE) {
      setCustomModel({ agentId, value: currentModel });
      return;
    }
    setAgentModel(agentId, value || null);
  }

  function confirmCustomModel(): void {
    if (!customModel) return;
    const trimmed = customModel.value.trim();
    if (!trimmed) {
      setAgentModel(customModel.agentId, null);
      setCustomModel(null);
      return;
    }
    if (trimmed.length > MODEL_ID_MAX || !MODEL_ID_RE.test(trimmed)) {
      useStudio.getState().pushToast('warning', '模型 id 含不支持的字符，未保存');
      return;
    }
    setAgentModel(customModel.agentId, trimmed);
    setCustomModel(null);
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Escape confirms/cancels IME composition on some platforms. Let the IME
    // consume it instead of stopping an in-flight run.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && running) {
      event.preventDefault();
      event.stopPropagation();
      void stopRun();
      return;
    }
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.shiftKey) return;
    event.preventDefault();
    void send();
  }

  function quoteMessage(content: string): void {
    const quote = content.split('\n').map((line) => `> ${line}`).join('\n');
    setInput((previous) => `${previous ? `${previous}\n\n` : ''}${quote}\n\n`);
    composerRef.current?.focus();
  }

  async function copyThreadTranscript(threadId: string): Promise<void> {
    const fetched = api.getThread(threadId);
    // Surface fetch failures with their own diagnosis instead of letting them
    // masquerade as clipboard-permission problems in the copy path.
    fetched.catch((err: unknown) => {
      useStudio.getState().pushToast('danger', `读取线程失败：${err instanceof Error ? err.message : String(err)}`);
    });
    const transcript = fetched.then((result) =>
      result.messages.map((message) => {
        const role = message.role === 'user' ? '我' : message.agentId ?? 'AI';
        return `## ${role}\n${message.content}`;
      }).join('\n\n'),
    );
    await copyTextDeferred(transcript, '线程全文已复制');
  }

  function threadSpec(thread: Thread) {
    return createThreadMenuSpec(thread, {
      activeThreadId: activeThread?.id,
      running,
      actions: {
        open: (threadId) => openThread(threadId),
        rename: (target) => setRenamingThread({ id: target.id, title: target.title }),
        copyTranscript: copyThreadTranscript,
      },
    });
  }

  function messageSpec(message: Message) {
    const canReviewRewrite = message.role === 'assistant'
      && activeThread?.kind === 'rewrite'
      && Boolean(message.structured || message.content.trim());
    return createMessageMenuSpec(message, {
      running,
      canReviewRewrite,
      actions: {
        copyContent: async (content) => {
          await copyText(content, '消息内容已复制');
        },
        quoteContent: quoteMessage,
        openRewriteReview,
      },
    });
  }

  async function confirmRenameThread(): Promise<void> {
    if (!renamingThread) return;
    if (await renameThread(renamingThread.id, renamingThread.title)) {
      setRenamingThread(null);
    }
  }

  return (
    <div className="thread-panel">
      <div className="panel-header">
        <span className="panel-header-title">AI 对话</span>
        {running && (
          <button className="btn-ghost danger" onClick={() => void stopRun()}>
            停止 Esc
          </button>
        )}
      </div>

      <div className="thread-actions">
        <button
          className="btn"
          disabled={running || !selection || !canCreateThread}
          onClick={() => void createThread('ask')}
        >
          对选中段落提问
        </button>
        <button
          className="btn"
          disabled={running || !selection || !canCreateThread}
          onClick={() => void createThread('rewrite')}
        >
          改写选中段落
        </button>
        <button
          className="btn"
          disabled={running || !doc || !canCreateThread}
          onClick={() => void createWholeDocThread()}
        >
          对整章提意见
        </button>
      </div>
      {selection && (
        <div className="selection-preview">
          选中 {selection.exact.length} 字：{selection.exact.slice(0, 40)}
          {selection.exact.length > 40 ? '…' : ''}
        </div>
      )}

      {threads.length > 0 && (
        <div className="thread-list">
          {threads.map((t) => (
            <div
              key={t.id}
              className={[
                'thread-item',
                t.id === activeThread?.id ? 'active' : '',
                running ? 'disabled' : '',
              ].filter(Boolean).join(' ')}
              role="button"
              tabIndex={running ? -1 : 0}
              aria-current={t.id === activeThread?.id ? 'true' : undefined}
              aria-disabled={running}
              onClick={() => {
                if (!running) void openThread(t.id);
              }}
              onKeyDown={onActivateKey(() => {
                if (!running) void openThread(t.id);
              })}
              onContextMenu={(event) => menu.openFromEvent(event, threadSpec(t))}
              onKeyDownCapture={(event) => menu.openFromKeyboard(event, threadSpec(t))}
            >
              [{t.origin === 'check' ? 'check' : t.kind}] {t.title}
            </div>
          ))}
        </div>
      )}

      {chatThreads.length > 0 && (
        <>
          <div className="thread-section-label">角色对话</div>
          <div className="thread-list">
            {chatThreads.map((t) => (
              <div
                key={t.id}
                className={[
                  'thread-item chat',
                  t.id === activeThread?.id ? 'active' : '',
                  running ? 'disabled' : '',
                ].filter(Boolean).join(' ')}
                role="button"
                tabIndex={running ? -1 : 0}
                aria-current={t.id === activeThread?.id ? 'true' : undefined}
                aria-disabled={running}
                onClick={() => {
                  if (!running) void openThread(t.id);
                }}
                onKeyDown={onActivateKey(() => {
                  if (!running) void openThread(t.id);
                })}
                onContextMenu={(event) => menu.openFromEvent(event, threadSpec(t))}
                onKeyDownCapture={(event) => menu.openFromKeyboard(event, threadSpec(t))}
              >
                ◈ {t.title}
                {t.persona?.memoryCutoffChapter !== undefined ? ` @≤${t.persona.memoryCutoffChapter}章` : ''}
              </div>
            ))}
          </div>
        </>
      )}

      {!activeThread && (
        <Empty
          icon={<MousePointerClickIcon size={22} />}
          text="选中正文段落可提问或改写；在「资料 → 角色设定」里可与角色对话。"
        />
      )}

      {activeThread && (
        <>
          <div className="thread-meta">
            <span className="thread-current-title" title={activeThread.title}>
              {activeThread.title}
            </span>
            <label>
              Agent
              <select
                className="agent-select"
                aria-label="Agent"
                value={activeThread.agentId}
                disabled={running || !agentsLoaded}
                onChange={(event) => void setThreadAgent(event.target.value as AgentId)}
              >
                {agents.length === 0 && (
                  <option value={activeThread.agentId}>{activeThread.agentId}</option>
                )}
                {agents.map((agent) => {
                  const usable = agent.ok && agent.supportedProfiles.includes(activeThread.profile);
                  return (
                    <option key={agent.agentId} value={agent.agentId} disabled={!usable}>
                      {agent.agentId}{usable ? '' : '（不可用）'}
                    </option>
                  );
                })}
              </select>
            </label>
            {models !== undefined && (
              <label>
                模型
                <select
                  className="agent-select"
                  aria-label="模型"
                  value={modelSelectValue}
                  disabled={!agentsLoaded}
                  onChange={(event) => onModelChange(activeThread.agentId, event.target.value)}
                >
                  <option value={DEFAULT_MODEL_VALUE}>
                    {catalogDefault ? `默认（${catalogDefault.label}）` : '默认'}
                  </option>
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>{model.label}</option>
                  ))}
                  {currentModel !== '' && !models.some((model) => model.id === currentModel) && (
                    <option value={currentModel}>{currentModel}</option>
                  )}
                  <option value={CUSTOM_MODEL_VALUE}>自定义…</option>
                </select>
              </label>
            )}
            {activeThread.kind === 'chat' && activeThread.persona ? (
              <span className="persona-chip" title="角色对话（写手视角，不知停点之后剧情）">
                ◈ {formatPersonaLabel(activeThread.persona)}
              </span>
            ) : (
              <span>{activeThread.profile}</span>
            )}
          </div>
          {!activeAgentUsable && (
            <div className="agent-status" role="status">
              {agentsLoaded
                ? activeAvailability?.error ?? `该 Agent 不支持 ${activeThread.profile} profile`
                : '正在检查 Agent 可用性…'}
            </div>
          )}
          {runError && (
            <div className="run-error" role="alert">
              {runError}
            </div>
          )}
          <ContextManifestPanel manifest={runManifest} />
          <div
            className="message-list"
            ref={listRef}
            onScroll={(event) => {
              const list = event.currentTarget;
              stickToBottomRef.current =
                list.scrollHeight - list.scrollTop - list.clientHeight < STICK_SLACK_PX;
            }}
          >
            {messages.map((m) => (
              <div
                key={m.id}
                className={`message ${m.role}`}
                tabIndex={0}
                onContextMenu={(event) => menu.openFromEvent(event, messageSpec(m))}
                onKeyDown={(event) => menu.openFromKeyboard(event, messageSpec(m))}
              >
                <div className="message-role">
                  {m.role === 'assistant' && <span className={`agent-dot ${m.agentId ?? 'echo'}`} />}
                  {m.role === 'user'
                    ? '我'
                    : activeThread.kind === 'chat'
                      ? activeThread.persona?.characterName ?? m.agentId ?? 'AI'
                      : m.agentId ?? 'AI'}
                </div>
                {m.role === 'assistant' && activeThread.origin === 'check' ? (
                  <ConflictFindingsPanel
                    response={
                      m.structured && 'findings' in m.structured
                        ? m.structured as ConflictCheckResponse
                        : null
                    }
                    rawText={m.content}
                    onLocateText={revealTextQuote}
                    onOpenCanon={openCanonSource}
                    onRepairCanon={(docId, heading, textQuote) => {
                      void startCanonRewriteFromFinding(docId, heading, textQuote);
                    }}
                  />
                ) : m.role === 'assistant' && !m.structured ? (
                  <div className="message-content markdown">
                    <MarkdownMessage markdown={m.content} />
                  </div>
                ) : (
                  <div className="message-content">
                    {m.structured && 'rewritten_text' in m.structured
                      ? m.structured.notes ?? '已生成结构化改写候选'
                      : m.content}
                  </div>
                )}
                {m.role === 'assistant' && activeThread.kind === 'rewrite' && (m.structured || m.content.trim()) && (
                  <button className="btn rewrite-review-button" onClick={() => openRewriteReview(m.id)}>
                    {m.structured ? '对比并采纳' : '核对原始结果'}
                  </button>
                )}
              </div>
            ))}
            {running && (
              <div className="message assistant">
                <div className="message-role">
                  <span className={`agent-dot ${activeThread.agentId}`} />
                  {activeThread.kind === 'chat'
                    ? activeThread.persona?.characterName ?? activeThread.agentId
                    : activeThread.agentId}
                </div>
                <div
                  className={
                    (activeThread.kind === 'rewrite' || activeThread.origin === 'check') && streamingText
                      ? 'message-content stream-raw'
                      : 'message-content'
                  }
                >
                  {streamingText
                    || (
                      activeThread.origin === 'check'
                        ? '正在核对正典'
                        : activeThread.kind === 'rewrite' ? '正在生成改写候选' : '等待响应'
                    )}
                  <span className="stream-cursor" />
                </div>
                {lastTool && (
                  <div className="tool-activity" role="status">
                    ⚙ {lastTool.tool}（{TOOL_STATUS_LABEL[lastTool.status] ?? lastTool.status}）
                    {runTools.length > 1 ? ` · 共 ${runTools.length} 次工具调用` : ''}
                  </div>
                )}
              </div>
            )}
          </div>
          {showUsage && runUsage && (
            <div className="run-usage" role="status">
              上轮 · 输入 {runUsage.inputTokens.toLocaleString()} · 输出 {runUsage.outputTokens.toLocaleString()} tokens
              {runUsage.costUsd > 0 ? ` · $${runUsage.costUsd.toFixed(4)}` : ''}
            </div>
          )}
          <div className="thread-input">
            <textarea
              ref={composerRef}
              value={input}
              disabled={!activeAgentUsable}
              placeholder={
                activeThread.kind === 'chat'
                  ? `与${activeThread.persona?.characterName ?? '角色'}对话…（Enter 发送，Shift+Enter 换行）`
                  : activeThread.origin === 'check'
                    ? '补充核对要求…（Enter 发送，Shift+Enter 换行）'
                  : activeThread.kind === 'rewrite'
                    ? '描述改写要求…（Enter 发送，Shift+Enter 换行）'
                    : '对选中内容提问…（Enter 发送，Shift+Enter 换行）'
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button
              className="btn-primary"
              disabled={running || !activeAgentUsable || !input.trim()}
              onClick={() => void send()}
            >
              发送 ↵
            </button>
          </div>
        </>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
      <Modal
        open={renamingThread !== null}
        title="重命名线程"
        confirmText="保存"
        confirmDisabled={!renamingThread?.title.trim()}
        onClose={() => setRenamingThread(null)}
        onConfirm={() => void confirmRenameThread()}
      >
        <label className="modal-field">
          <span className="modal-field-label">线程标题</span>
          <input
            className="modal-input"
            maxLength={60}
            value={renamingThread?.title ?? ''}
            onChange={(event) => {
              const title = event.target.value;
              setRenamingThread((current) => current ? { ...current, title } : null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && renamingThread?.title.trim()) {
                event.preventDefault();
                void confirmRenameThread();
              }
            }}
          />
        </label>
      </Modal>
      <Modal
        open={customModel !== null}
        title="自定义模型"
        confirmText="使用此模型"
        confirmDisabled={
          customModel !== null
          && customModel.value.trim() !== ''
          && (
            customModel.value.trim().length > MODEL_ID_MAX
            || !MODEL_ID_RE.test(customModel.value.trim())
          )
        }
        onClose={() => setCustomModel(null)}
        onConfirm={confirmCustomModel}
      >
        <label className="modal-field">
          <span className="modal-field-label">模型 id（原样传给 CLI 的 --model）</span>
          <input
            className="modal-input"
            value={customModel?.value ?? ''}
            maxLength={MODEL_ID_MAX}
            onChange={(event) => {
              const value = event.target.value;
              setCustomModel((current) => current ? { ...current, value } : null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                confirmCustomModel();
              }
            }}
          />
          <span className="model-id-hint">留空将恢复默认模型。</span>
        </label>
      </Modal>
    </div>
  );
}
