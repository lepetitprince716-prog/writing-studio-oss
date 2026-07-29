/** Immutable revision browser. Restoring only changes the editor buffer. */

import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { MergeView } from '@codemirror/merge';
import type { Revision, RevisionWithContent } from '@writing-studio/contract';
import { api } from '../api.js';
import { buildProvenanceMarkdown } from '../lib/provenanceMarkdown.js';
import { useStudio } from '../store.js';
import { Modal } from './Modal.js';

const KIND_LABEL: Record<Revision['kind'], string> = {
  ai_original: 'AI 候选',
  user_edit: '保存版本',
  manual_snapshot: '手动快照',
};

export function RevisionHistory(): React.JSX.Element {
  const open = useStudio((state) => state.revisionHistoryOpen);
  const setOpen = useStudio((state) => state.setRevisionHistoryOpen);
  const requestRestore = useStudio((state) => state.requestRevisionRestore);
  const projectId = useStudio((state) => state.activeProjectId);
  const doc = useStudio((state) => state.doc);
  const currentContent = useStudio((state) => state.editorContent);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<RevisionWithContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const mergeHostRef = useRef<HTMLDivElement | null>(null);
  const inspectSeqRef = useRef(0);

  useEffect(() => {
    if (!open || !projectId || !doc) return undefined;
    inspectSeqRef.current += 1;
    let active = true;
    setLoading(true);
    setError(null);
    setSelected(null);
    void api.listRevisions(projectId, doc.docId).then((items) => {
      if (active) setRevisions([...items].reverse());
    }).catch((err) => {
      if (active) setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      inspectSeqRef.current += 1;
    };
  }, [doc, open, projectId]);

  useEffect(() => {
    if (!selected || !mergeHostRef.current) return undefined;
    const readOnly = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
    ];
    const merge = new MergeView({
      a: { doc: currentContent, extensions: readOnly },
      b: { doc: selected.content, extensions: readOnly },
      parent: mergeHostRef.current,
      orientation: 'a-b',
      highlightChanges: true,
      gutter: true,
    });
    return () => merge.destroy();
  }, [currentContent, selected]);

  async function inspect(revision: Revision): Promise<void> {
    if (!projectId || !doc) return;
    const expectedProjectId = projectId;
    const expectedDocId = doc.docId;
    const requestSeq = ++inspectSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const full = await api.getRevision(revision.id);
      const current = useStudio.getState();
      if (
        requestSeq !== inspectSeqRef.current
        || !current.revisionHistoryOpen
        || current.activeProjectId !== expectedProjectId
        || current.doc?.docId !== expectedDocId
      ) return;
      if (full.projectId !== expectedProjectId || full.docId !== expectedDocId) {
        throw new Error('版本不属于当前文档');
      }
      setSelected(full);
    } catch (err) {
      if (requestSeq === inspectSeqRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestSeq === inspectSeqRef.current) setLoading(false);
    }
  }

  function restore(): void {
    if (!projectId || !doc || !selected) return;
    const current = useStudio.getState();
    if (
      !current.revisionHistoryOpen
      || current.activeProjectId !== projectId
      || current.doc?.docId !== doc.docId
      || selected.projectId !== projectId
      || selected.docId !== doc.docId
    ) {
      setSelected(null);
      setError('所选版本不属于当前文档，请重新选择');
      return;
    }
    requestRestore({
      projectId,
      docId: doc.docId,
      revisionId: selected.id,
      content: selected.content,
    });
  }

  async function exportProvenance(): Promise<void> {
    if (!projectId || !doc || exporting) return;
    const expectedProjectId = projectId;
    const expectedDocId = doc.docId;
    setExporting(true);
    setError(null);
    try {
      const provenance = await api.getProvenance(projectId, doc.docId);
      const current = useStudio.getState();
      if (
        !current.revisionHistoryOpen
        || current.activeProjectId !== expectedProjectId
        || current.doc?.docId !== expectedDocId
      ) return;
      const blob = new Blob([buildProvenanceMarkdown(provenance)], {
        type: 'text/markdown;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      const safeTitle = provenance.title.replace(/[/\\:*?"<>|]/g, '_').trim() || '文档';
      anchor.href = url;
      anchor.download = `${safeTitle}-编辑自证包.md`;
      anchor.click();
      URL.revokeObjectURL(url);
      current.pushToast('success', '编辑自证包已导出');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Modal
      open={open}
      title="版本历史"
      className="revision-modal"
      cancelText="关闭"
      onClose={() => setOpen(false)}
    >
      <div className="revision-actions">
        <p className="muted">修订记录只读；导出文件不包含正文内容。</p>
        <button className="btn" disabled={exporting} onClick={() => void exportProvenance()}>
          {exporting ? '正在导出…' : '导出自证包'}
        </button>
      </div>
      <div className="revision-layout">
        <div className="revision-list" aria-label="版本列表">
          {loading && revisions.length === 0 && <div className="muted">正在加载版本…</div>}
          {!loading && revisions.length === 0 && !error && <div className="muted">尚无版本快照</div>}
          {revisions.map((revision) => (
            <button
              key={revision.id}
              className={selected?.id === revision.id ? 'revision-item active' : 'revision-item'}
              onClick={() => void inspect(revision)}
            >
              <span className="revision-item-title">
                {revision.label ?? KIND_LABEL[revision.kind]}
                {revision.sha256 === doc?.sha256 && <span className="revision-current">当前已保存</span>}
              </span>
              <span>{KIND_LABEL[revision.kind]} · {new Date(revision.createdAt).toLocaleString()}</span>
              <code>{revision.sha256.slice(0, 10)}</code>
            </button>
          ))}
        </div>
        <div className="revision-preview">
          {error && <div className="project-error">版本读取失败：{error}</div>}
          {!selected && !error && <div className="muted">选择一个版本与当前编辑器内容对比</div>}
          {selected && (
            <>
              <div className="revision-labels" aria-hidden="true">
                <span>当前编辑器</span>
                <span>所选版本</span>
              </div>
              <div className="revision-merge" ref={mergeHostRef} />
              <button className="btn-primary revision-restore" disabled={loading} onClick={restore}>
                恢复到编辑器
              </button>
              <p className="rewrite-hint">恢复后仍需点击保存才会写回正文。</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
