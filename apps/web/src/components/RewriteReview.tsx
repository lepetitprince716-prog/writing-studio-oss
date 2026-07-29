/** Chunk-level rewrite review. Applying remains an explicit user action. */

import { useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { unifiedMergeView } from '@codemirror/merge';
import { useStudio } from '../store.js';
import { hasAcceptedRewrite } from '../lib/rewrite-review.js';
import { Modal } from './Modal.js';

export function RewriteReview(): React.JSX.Element {
  const review = useStudio((state) => state.rewriteReview);
  const close = useStudio((state) => state.closeRewriteReview);
  const apply = useStudio((state) => state.requestRewriteApply);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [composedText, setComposedText] = useState('');

  useEffect(() => {
    if (!review || !hostRef.current) return undefined;
    setComposedText(review.rewrittenText);
    const extensions = [
      EditorView.lineWrapping,
      unifiedMergeView({
        original: review.originalText,
        highlightChanges: true,
        gutter: true,
        allowInlineDiffs: true,
        mergeControls: (type, action) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = type === 'accept' ? 'btn-primary rewrite-chunk-action' : 'btn rewrite-chunk-action';
          button.textContent = type === 'accept' ? '接受此段' : '拒绝此段';
          button.setAttribute('aria-label', button.textContent);
          button.onmousedown = action;
          return button;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) setComposedText(update.state.doc.toString());
      }),
    ];
    if (!review.rawFallback) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    }
    const view = new EditorView({
      state: EditorState.create({ doc: review.rewrittenText, extensions }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [review]);

  const accepted = Boolean(review && hasAcceptedRewrite(review.originalText, composedText));

  function applySelection(): void {
    const current = viewRef.current?.state.doc.toString() ?? composedText;
    if (!review || !hasAcceptedRewrite(review.originalText, current)) {
      close();
      return;
    }
    apply(current);
  }

  return (
    <Modal
      open={review !== null}
      title={review?.wholeDoc ? '整章对比' : '改写对比'}
      className="rewrite-modal"
      cancelText="取消"
      confirmText="采纳所选改写"
      confirmDisabled={!accepted}
      onClose={close}
      onConfirm={applySelection}
    >
      <p className="rewrite-instructions">
        对每个差异段选择“接受此段”或“拒绝此段”。未操作的差异默认保留 AI 候选。
      </p>
      <div className="rewrite-merge" ref={hostRef} />
      {review?.rawFallback && <p className="rewrite-notes">结构化解析失败：候选区可直接编辑后再采纳。</p>}
      {review?.notes && <p className="rewrite-notes">说明：{review.notes}</p>}
      <p className="rewrite-hint">
        {accepted
          ? '采纳只修改当前编辑器缓冲区；仍需点击保存才会写回正文。'
          : '所有差异均已拒绝；关闭窗口即可保留原文。'}
      </p>
    </Modal>
  );
}
