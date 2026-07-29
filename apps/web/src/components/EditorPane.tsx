/**
 * CodeMirror 6 wrapper: raw Markdown editing with a manuscript feel (serif,
 * centered measure, active line + selection highlight, heading decorations).
 * Captures selection with quote-context for anchors, Cmd/Ctrl+S save with
 * toast feedback, adjustable font size, optional typewriter scrolling, and a
 * word-count status bar.
 */

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { api } from '../api.js';
import type { LintFinding, LintResponse } from '@writing-studio/contract';
import { useStudio, EDITOR_FS_MIN, EDITOR_FS_MAX } from '../store.js';
import type { RewriteReview } from '../store.js';
import { countWords } from '../lib/wordCount.js';
import { conflictCheckButtonState } from '../lib/conflict-check.js';
import { mdDecorations } from '../lib/mdDecorations.js';
import {
  lintHoverTooltip,
  lintStateField,
  setLintFindings,
} from '../lib/lintDecorations.js';
import { BookIcon, MinusIcon, PlusIcon, TypewriterIcon } from './icons.js';
import { EditorChapterBadge } from './ChapterLabels.js';

const CONTEXT_CHARS = 32;

function locateRewriteRange(content: string, request: RewriteReview): { from: number; to: number } | null {
  const { originalText, preferredStart } = request;
  const positions: number[] = [];
  let cursor = content.indexOf(originalText);
  while (cursor !== -1) {
    positions.push(cursor);
    cursor = content.indexOf(originalText, cursor + 1);
  }
  if (positions.length === 0) return null;
  const scored = positions.map((from) => {
    const before = content.slice(Math.max(0, from - request.prefix.length), from);
    const after = content.slice(from + originalText.length, from + originalText.length + request.suffix.length);
    let prefixScore = 0;
    while (
      prefixScore < before.length
      && prefixScore < request.prefix.length
      && before[before.length - 1 - prefixScore] === request.prefix[request.prefix.length - 1 - prefixScore]
    ) prefixScore += 1;
    let suffixScore = 0;
    while (
      suffixScore < after.length
      && suffixScore < request.suffix.length
      && after[suffixScore] === request.suffix[suffixScore]
    ) suffixScore += 1;
    return { from, contextScore: prefixScore + suffixScore, distance: Math.abs(from - preferredStart) };
  }).sort((a, b) => b.contextScore - a.contextScore || a.distance - b.distance);

  const best = scored[0]!;
  const second = scored[1];
  const requiredContext = Math.min(8, request.prefix.length + request.suffix.length);
  const unchangedSingle = positions.length === 1 && best.from === preferredStart;
  if (
    (!unchangedSingle && best.contextScore < requiredContext)
    || (second && best.contextScore === second.contextScore && best.distance === second.distance)
  ) {
    return null;
  }
  return { from: best.from, to: best.from + originalText.length };
}

export function EditorPane(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const bubbleRafRef = useRef<number | null>(null);
  const doc = useStudio((s) => s.doc);
  const docContent = useStudio((s) => s.docContent);
  const editorLoadVersion = useStudio((s) => s.editorLoadVersion);
  const editorDirty = useStudio((s) => s.editorDirty);
  const pendingRevealHeading = useStudio((s) => s.pendingRevealHeading);
  const pendingRevealQuote = useStudio((s) => s.pendingRevealQuote);
  const clearRevealHeading = useStudio((s) => s.clearRevealHeading);
  const clearRevealQuote = useStudio((s) => s.clearRevealQuote);
  const fontSize = useStudio((s) => s.editorFontSize);
  const typewriter = useStudio((s) => s.typewriterMode);
  const setEditorFontSize = useStudio((s) => s.setEditorFontSize);
  const toggleTypewriter = useStudio((s) => s.toggleTypewriter);
  const rewriteApplyRequest = useStudio((s) => s.rewriteApplyRequest);
  const clearRewriteApplyRequest = useStudio((s) => s.clearRewriteApplyRequest);
  const revisionRestoreRequest = useStudio((s) => s.revisionRestoreRequest);
  const clearRevisionRestoreRequest = useStudio((s) => s.clearRevisionRestoreRequest);
  const setRevisionHistoryOpen = useStudio((s) => s.setRevisionHistoryOpen);
  const [fullCount, setFullCount] = useState(0);
  const [selCount, setSelCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [lintLoading, setLintLoading] = useState(false);
  const [lintPanelOpen, setLintPanelOpen] = useState(false);
  const [lintResponse, setLintResponse] = useState<LintResponse | null>(null);
  const [lintError, setLintError] = useState<string | null>(null);
  const [lintStale, setLintStale] = useState(false);
  const lintResponseRef = useRef<LintResponse | null>(null);
  const lintRequestSeqRef = useRef(0);
  const savingRef = useRef(false);
  /** Floating quick-action bar near the current selection (pane-relative px). */
  const [bubble, setBubble] = useState<{ left: number; top: number } | null>(null);
  const running = useStudio((s) => s.running);
  const conflictCheckStarting = useStudio((s) => s.conflictCheckStarting);
  const runConflictCheck = useStudio((s) => s.runConflictCheck);
  const agents = useStudio((s) => s.agents);
  const agentsLoaded = useStudio((s) => s.agentsLoaded);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const chapterLeaf = useStudio((s) =>
    s.projects.find((project) => project.config.id === s.activeProjectId)
      ?.config.contentTree.leaf);
  const defaultProfile = useStudio((s) =>
    s.projects.find((project) => project.config.id === activeProjectId)
      ?.config.aiProfiles.defaultProfile ?? 'writer',
  );
  const createThreadFromSelection = useStudio((s) => s.createThreadFromSelection);
  const canQuickThread = !running && agentsLoaded && agents.some(
    (agent) => agent.ok && agent.supportedProfiles.includes(defaultProfile),
  );

  useEffect(() => {
    setFullCount(countWords(docContent));
    setSelCount(0);
  }, [docContent]);

  // Measure the selection-head coordinates outside the CM update cycle
  // (layout reads are not allowed inside an update listener).
  const scheduleBubbleMeasure = (): void => {
    if (bubbleRafRef.current !== null) cancelAnimationFrame(bubbleRafRef.current);
    bubbleRafRef.current = requestAnimationFrame(() => {
      bubbleRafRef.current = null;
      const view = viewRef.current;
      const pane = paneRef.current;
      if (!view || !pane) return;
      const main = view.state.selection.main;
      if (main.empty) {
        setBubble(null);
        return;
      }
      const coords = view.coordsAtPos(main.head);
      if (!coords) {
        setBubble(null);
        return;
      }
      const rect = pane.getBoundingClientRect();
      const left = Math.min(Math.max(coords.left - rect.left - 8, 8), Math.max(8, rect.width - 170));
      const above = coords.top - rect.top - 46;
      // Flip below the selection when the line sits under the toolbar.
      const top = above < 44 ? coords.bottom - rect.top + 10 : above;
      setBubble({ left, top });
    });
  };

  const cancelBubble = (): void => {
    if (bubbleRafRef.current !== null) {
      cancelAnimationFrame(bubbleRafRef.current);
      bubbleRafRef.current = null;
    }
    setBubble(null);
  };

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const state = EditorState.create({
      doc: docContent,
      extensions: [
        history(),
        keymap.of([
          {
            key: 'Mod-s',
            run: (view) => {
              void save(view);
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown(),
        mdDecorations,
        lintStateField,
        lintHoverTooltip,
        highlightActiveLine(),
        drawSelection(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          const store = useStudio.getState();
          if (update.docChanged) {
            const content = update.state.doc.toString();
            store.markDirty(content);
            setFullCount(countWords(content));
            if (lintResponseRef.current) setLintStale(true);
          }
          if (update.selectionSet) {
            const { from, to } = update.state.selection.main;
            const text = update.state.doc.toString();
            setSelCount(from === to ? 0 : countWords(text.slice(from, to)));
            store.setSelection(
              from === to
                ? null
                : {
                    start: from,
                    end: to,
                    prefix: text.slice(Math.max(0, from - CONTEXT_CHARS), from),
                    exact: text.slice(from, to),
                    suffix: text.slice(to, Math.min(text.length, to + CONTEXT_CHARS)),
                  },
            );
            if (from === to) cancelBubble();
            else scheduleBubbleMeasure();
          } else if (update.docChanged) {
            cancelBubble();
          }
          if (
            (update.docChanged || update.selectionSet) &&
            useStudio.getState().typewriterMode &&
            update.view.hasFocus
          ) {
            const head = update.state.selection.main.head;
            // Defer: dispatching inside an update is not allowed.
            requestAnimationFrame(() => {
              viewRef.current?.dispatch({ effects: EditorView.scrollIntoView(head, { y: 'center' }) });
            });
          }
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    // Scrolling invalidates the measured bubble position; hide instead of
    // chasing the selection while the user scrolls.
    const hideBubbleOnScroll = (): void => cancelBubble();
    view.scrollDOM.addEventListener('scroll', hideBubbleOnScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', hideBubbleOnScroll);
      cancelBubble();
      view.destroy();
      viewRef.current = null;
    };
    // Recreate the editor when a different document (or fresh content) loads.
  }, [doc?.docId, docContent, editorLoadVersion]);

  useEffect(() => {
    lintRequestSeqRef.current += 1;
    lintResponseRef.current = null;
    setLintResponse(null);
    setLintError(null);
    setLintStale(false);
    setLintPanelOpen(false);
  }, [doc?.docId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !doc || !pendingRevealHeading) return;
    clearRevealHeading();
    const expected = pendingRevealHeading.normalize('NFKC').trim();
    const matches: Array<{ from: number; to: number }> = [];
    for (let number = 1; number <= view.state.doc.lines; number += 1) {
      const line = view.state.doc.line(number);
      const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.text);
      if (match?.[1]?.normalize('NFKC').trim() === expected) {
        matches.push({ from: line.from, to: line.to });
      }
    }
    if (matches.length !== 1) {
      useStudio.getState().pushToast(
        'warning',
        matches.length === 0 ? `未找到标题：${expected}` : `标题重复，无法唯一定位：${expected}`,
      );
      return;
    }
    const target = matches[0]!;
    view.dispatch({
      selection: { anchor: target.from, head: target.to },
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    });
    view.focus();
  }, [clearRevealHeading, doc, pendingRevealHeading]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !doc || !pendingRevealQuote) return;
    clearRevealQuote();
    const content = view.state.doc.toString();
    const from = content.indexOf(pendingRevealQuote);
    if (from < 0) {
      useStudio.getState().pushToast('warning', '正文中未找到该引用；章节可能已被修改');
      return;
    }
    view.dispatch({
      selection: { anchor: from, head: from + pendingRevealQuote.length },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }, [clearRevealQuote, doc, pendingRevealQuote]);

  useEffect(() => {
    const request = rewriteApplyRequest;
    const view = viewRef.current;
    if (!request || !view) return;
    clearRewriteApplyRequest();
    const store = useStudio.getState();
    if (
      store.activeProjectId !== request.projectId
      || store.doc?.docId !== request.docId
      || store.activeThread?.id !== request.threadId
    ) {
      store.pushToast('warning', '文档或线程已经切换，未采纳该改写');
      return;
    }
    const current = view.state.doc.toString();
    if (
      request.wholeDoc
      && (
        request.wholeDocBaseSha === null
        || store.baseSha !== request.wholeDocBaseSha
        || current !== request.originalText
      )
    ) {
      store.pushToast('warning', '正文已在生成整章改写后变化，未采纳；请重新创建整章线程');
      return;
    }
    // Document-level candidates replace the whole buffer; fuzzy range location
    // only applies to anchored selections.
    const range = request.wholeDoc
      ? { from: 0, to: current.length }
      : locateRewriteRange(current, request);
    if (!range) {
      store.pushToast('warning', '原选区已被修改，无法安全定位；请重新选择后发起改写');
      return;
    }
    const candidate = `${current.slice(0, range.from)}${request.rewrittenText}${current.slice(range.to)}`;
    if (candidate === current) {
      store.pushToast('info', '改写结果与当前选区相同');
      return;
    }

    // Establish both immutable rollback points before touching the editor.
    // If the user types while the snapshots are being stored, the final
    // identity/content check below aborts instead of applying at a stale range.
    void (async () => {
      if (request.wholeDoc) {
        const durable = await api.getDocument(request.projectId, request.docId);
        const latest = useStudio.getState();
        if (
          durable.doc.sha256 !== request.wholeDocBaseSha
          || durable.content !== request.originalText
          || latest.baseSha !== request.wholeDocBaseSha
          || view.state.doc.toString() !== current
        ) {
          latest.pushToast('warning', '正文已被保存或外部修改，未采纳整章改写；请重新创建线程');
          return;
        }
      }
      await Promise.all([
        api.createRevision(request.projectId, request.docId, {
          kind: 'manual_snapshot',
          content: current,
          sourceThreadId: request.threadId,
          label: '改写前',
        }),
        api.createRevision(request.projectId, request.docId, {
          kind: 'ai_original',
          content: candidate,
          sourceThreadId: request.threadId,
          label: 'AI 改写候选',
        }),
      ]);
      const latest = useStudio.getState();
      if (
        viewRef.current !== view
        || latest.activeProjectId !== request.projectId
        || latest.doc?.docId !== request.docId
        || latest.activeThread?.id !== request.threadId
        || view.state.doc.toString() !== current
      ) {
        latest.pushToast('warning', '编辑器内容已经变化，未采纳该改写；版本快照已保留');
        return;
      }
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: request.rewrittenText },
        selection: { anchor: range.from + request.rewrittenText.length },
        scrollIntoView: true,
      });
      latest.setSelection(null);
      latest.setAppliedRewriteSource(request.threadId);
      if (request.canon) {
        const saved = await latest.saveDocument(candidate);
        if (saved === 'conflict') {
          latest.pushToast('warning', '设定文件已被外部修改；修补候选仍保留在编辑器，请合并后重试');
        } else if (saved === 'saved-with-new-edits') {
          latest.pushToast('info', '设定修补已保存；采纳期间的新编辑仍未保存');
        }
      } else {
        latest.pushToast('success', '改写已采纳到编辑器，尚未保存');
      }
    })().catch((err) => {
      useStudio.getState().pushToast(
        'danger',
        `版本快照失败，未采纳改写：${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, [clearRewriteApplyRequest, rewriteApplyRequest]);

  useEffect(() => {
    const request = revisionRestoreRequest;
    const view = viewRef.current;
    if (!request || !view) return;
    clearRevisionRestoreRequest();
    const store = useStudio.getState();
    if (store.activeProjectId !== request.projectId || store.doc?.docId !== request.docId) {
      store.pushToast('warning', '文档已经切换，未恢复该版本');
      return;
    }
    const current = view.state.doc.toString();
    if (current === request.content) {
      store.pushToast('info', '所选版本与当前编辑器内容相同');
      return;
    }
    void api.createRevision(request.projectId, request.docId, {
      kind: 'manual_snapshot',
      content: current,
      label: '版本恢复前',
    }).then(() => {
      const latest = useStudio.getState();
      if (
        viewRef.current !== view
        || latest.activeProjectId !== request.projectId
        || latest.doc?.docId !== request.docId
        || view.state.doc.toString() !== current
      ) {
        latest.pushToast('warning', '编辑器内容已经变化，未恢复版本；快照已保留');
        return;
      }
      view.dispatch({
        changes: { from: 0, to: current.length, insert: request.content },
        selection: { anchor: 0 },
        scrollIntoView: true,
      });
      latest.setSelection(null);
      latest.setAppliedRewriteSource(null);
      latest.pushToast('success', '版本已恢复到编辑器，尚未保存');
    }).catch((err) => {
      useStudio.getState().pushToast(
        'danger',
        `恢复前快照失败，未修改编辑器：${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }, [clearRevisionRestoreRequest, revisionRestoreRequest]);

  async function save(view: EditorView): Promise<void> {
    if (savingRef.current) return;
    const { saveDocument, pushToast } = useStudio.getState();
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveDocument(view.state.doc.toString());
      if (result === 'conflict') {
        pushToast('warning', '保存冲突：文件已被外部修改。已保留你的编辑，请复制后重新打开文档合并。');
      } else if (result === 'saved-with-new-edits') {
        pushToast('info', '已保存发起时的版本；保存期间的新编辑仍未保存');
      } else if (result === 'saved') {
        pushToast('success', '已保存');
      }
    } catch (err) {
      pushToast('danger', `保存失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function runLint(): Promise<void> {
    const view = viewRef.current;
    if (!view || !doc || !activeProjectId || lintLoading) return;
    const expectedProjectId = activeProjectId;
    const expectedDocId = doc.docId;
    const snapshot = view.state.doc.toString();
    const requestSeq = ++lintRequestSeqRef.current;
    setLintLoading(true);
    setLintPanelOpen(true);
    setLintError(null);
    try {
      const response = await api.lintDocument(expectedProjectId, expectedDocId);
      if (requestSeq !== lintRequestSeqRef.current) return;
      const current = useStudio.getState();
      if (
        current.activeProjectId !== expectedProjectId
        || current.doc?.docId !== expectedDocId
        || response.docId !== expectedDocId
      ) return;
      lintResponseRef.current = response;
      setLintResponse(response);
      const fresh = (
        current.baseSha === response.sha256
        && viewRef.current === view
        && view.state.doc.toString() === snapshot
        && current.editorContent === snapshot
      );
      setLintStale(!fresh);
      view.dispatch({
        effects: setLintFindings.of(fresh ? response.findings : []),
      });
    } catch (err) {
      if (requestSeq === lintRequestSeqRef.current) {
        lintResponseRef.current = null;
        setLintResponse(null);
        setLintError(err instanceof Error ? err.message : String(err));
        view.dispatch({ effects: setLintFindings.of([]) });
      }
    } finally {
      if (requestSeq === lintRequestSeqRef.current) setLintLoading(false);
    }
  }

  function jumpToFinding(finding: LintFinding): void {
    const view = viewRef.current;
    if (!view) return;
    if (lintStale) {
      useStudio.getState().pushToast('warning', '体检结果已过期，请重新体检后定位');
      return;
    }
    const from = Math.min(view.state.doc.length, finding.offset);
    const to = Math.min(view.state.doc.length, finding.offset + finding.length);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    view.focus();
  }

  function bumpFont(delta: number): void {
    setEditorFontSize(fontSize + delta);
    viewRef.current?.requestMeasure();
  }

  if (!doc) {
    return <div className="editor-empty">从左侧选择章节，或新建草稿开始写作</div>;
  }

  const saveState = saving ? 'saving' : editorDirty ? 'dirty' : 'saved';
  const saveLabel = saving ? '保存中' : editorDirty ? '未保存' : '已保存';
  const conflictButton = conflictCheckButtonState({
    hasDocument: doc !== null,
    starting: conflictCheckStarting,
    running,
  });
  const lintGroups = (() => {
    const groups = new Map<string, LintFinding[]>();
    for (const finding of lintResponse?.findings ?? []) {
      const entries = groups.get(finding.ruleId) ?? [];
      entries.push(finding);
      groups.set(finding.ruleId, entries);
    }
    return [...groups.entries()];
  })();

  return (
    <div className="editor-pane" ref={paneRef}>
      {bubble && canQuickThread && (
        <div className="selection-bubble" style={{ left: bubble.left, top: bubble.top }}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              cancelBubble();
              void createThreadFromSelection('ask');
            }}
          >
            提问
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              cancelBubble();
              void createThreadFromSelection('rewrite');
            }}
          >
            改写
          </button>
        </div>
      )}
      <div className="editor-toolbar">
        <div className="editor-title">
          <span className="editor-title-text">{doc.title}</span>
          {doc.chapterNo !== null && (
            <EditorChapterBadge chapterNo={doc.chapterNo} chapterLeaf={chapterLeaf} />
          )}
        </div>
        <div className="editor-toolbar-tools">
          <button
            className={lintPanelOpen ? 'btn active' : 'btn'}
            disabled={lintLoading}
            onClick={() => void runLint()}
          >
            {lintLoading ? '体检中…' : '体检'}
          </button>
          <button
            className="btn"
            disabled={conflictButton.disabled}
            title="AI 语义初筛，可能漏检误报"
            onClick={() => void runConflictCheck()}
          >
            {conflictButton.label}
          </button>
          <button
            className="btn-icon"
            title="减小字号"
            aria-label="减小字号"
            disabled={fontSize <= EDITOR_FS_MIN}
            onClick={() => bumpFont(-1)}
          >
            <MinusIcon />
          </button>
          <span className="font-size-value" title="正文字号">
            {fontSize}
          </span>
          <button
            className="btn-icon"
            title="增大字号"
            aria-label="增大字号"
            disabled={fontSize >= EDITOR_FS_MAX}
            onClick={() => bumpFont(1)}
          >
            <PlusIcon />
          </button>
          <button
            className={typewriter ? 'btn-icon active' : 'btn-icon'}
            title="打字机模式（当前行居中）"
            aria-label="打字机模式"
            aria-pressed={typewriter}
            onClick={() => toggleTypewriter()}
          >
            <TypewriterIcon />
          </button>
          <button
            className="btn-icon"
            title="版本历史"
            aria-label="版本历史"
            onClick={() => setRevisionHistoryOpen(true)}
          >
            <BookIcon />
          </button>
          <button
            className="btn-primary"
            disabled={saving}
            onClick={() => viewRef.current && void save(viewRef.current)}
          >
            保存 ⌘S
          </button>
        </div>
      </div>
      {lintPanelOpen && (
        <section className="lint-panel" aria-label="体检结果">
          <div className="lint-panel-header">
            <strong>体检结果</strong>
            <span>
              {lintResponse ? `${lintResponse.findings.length} 处` : lintLoading ? '正在检查已保存正文…' : ''}
            </span>
            <button
              type="button"
              className="lint-panel-close"
              aria-label="关闭体检结果"
              onClick={() => setLintPanelOpen(false)}
            >
              ×
            </button>
          </div>
          {lintStale && (
            <div className="lint-stale">
              结果已过期，重新体检
              <button className="btn" disabled={lintLoading} onClick={() => void runLint()}>
                重新体检
              </button>
            </div>
          )}
          {lintError && <div className="project-error">体检失败：{lintError}</div>}
          {!lintLoading && !lintError && lintResponse && lintGroups.length === 0 && (
            <div className="lint-empty">未发现问题</div>
          )}
          {lintGroups.map(([ruleId, findings]) => (
            <div className="lint-group" key={ruleId}>
              <div className="lint-group-title">
                <span className={`lint-category ${findings[0]!.category}`}>
                  {findings[0]!.category === 'sensitive' ? '敏感词' : '文风'}
                </span>
                <code>{ruleId}</code>
                <span>{findings.length} 处</span>
              </div>
              <p>{findings[0]!.message}</p>
              <div className="lint-occurrences">
                {findings.map((finding, index) => (
                  <button
                    type="button"
                    key={`${finding.offset}-${index}`}
                    disabled={lintStale}
                    onClick={() => jumpToFinding(finding)}
                  >
                    #{index + 1} · 位置 {finding.offset}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
      <div
        ref={hostRef}
        className="editor-host"
        style={{ ['--editor-fs']: `${fontSize}px` } as CSSProperties}
      />
      <div className="editor-statusbar">
        <span>
          全文 <strong>{fullCount}</strong> 字
          {selCount > 0 && (
            <span className="count-selected">
              {' · '}选中 <strong>{selCount}</strong> 字
            </span>
          )}
        </span>
        <span className="editor-statusbar-right">
          <span className="save-state">
            <span className={`save-dot ${saveState}`} />
            {saveLabel}
          </span>
        </span>
      </div>
    </div>
  );
}
