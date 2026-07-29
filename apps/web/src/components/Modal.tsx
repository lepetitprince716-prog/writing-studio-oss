/**
 * Generic modal: title, body (children), confirm/cancel footer. Closes on Esc
 * or backdrop click; focus is moved in on open, trapped while open, and
 * restored on close. Rendered through a portal so it escapes pane overflow.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './icons.js';

interface ModalProps {
  open: boolean;
  title: string;
  className?: string;
  onClose(): void;
  onConfirm?(): void;
  confirmText?: string;
  cancelText?: string;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
}

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  className = '',
  onClose,
  onConfirm,
  confirmText = '确认',
  cancelText = '取消',
  confirmDisabled = false,
  children,
}: ModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Keep the latest onClose without making it an effect dependency: an inline
  // arrow from the parent changes identity every render and would otherwise
  // re-run the focus/select setup on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Prefer the primary field so the user can type immediately; fall back to
    // the first focusable, then the dialog itself.
    const field = dialog?.querySelector<HTMLElement>('input, textarea, select');
    const first = field ?? dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    if (field instanceof HTMLInputElement) field.select();

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === 'Tab' && dialog) {
        const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const firstEl = items[0]!;
        const lastEl = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
    // Only re-run on open/close transitions; onClose is read via ref.
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={['modal', className].filter(Boolean).join(' ')}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="btn-icon" aria-label="关闭" onClick={onClose}>
            <XIcon size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>
            {cancelText}
          </button>
          {onConfirm && (
            <button className="btn-primary" disabled={confirmDisabled} onClick={onConfirm}>
              {confirmText}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
