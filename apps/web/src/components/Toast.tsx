/**
 * Bottom-right toast stack. Each toast auto-dismisses after a delay with an
 * exit animation; the close button dismisses immediately (also animated).
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Toast } from '../store.js';
import { useStudio } from '../store.js';
import {
  AlertTriangleIcon,
  CheckCircleIcon,
  InfoIcon,
  XCircleIcon,
  XIcon,
} from './icons.js';

const AUTO_DISMISS_MS = 4000;
const EXIT_MS = 180;

const ICONS = {
  success: CheckCircleIcon,
  warning: AlertTriangleIcon,
  danger: XCircleIcon,
  info: InfoIcon,
} as const;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss(id: number): void }): React.JSX.Element {
  const [exiting, setExiting] = useState(false);
  const timers = useRef<number[]>([]);
  const Icon = ICONS[toast.kind];

  useEffect(() => {
    const beginExit = (): void => {
      setExiting(true);
      timers.current.push(window.setTimeout(() => onDismiss(toast.id), EXIT_MS));
    };
    timers.current.push(window.setTimeout(beginExit, AUTO_DISMISS_MS));
    return () => timers.current.forEach(window.clearTimeout);
  }, [toast.id, onDismiss]);

  function closeNow(): void {
    setExiting(true);
    timers.current.push(window.setTimeout(() => onDismiss(toast.id), EXIT_MS));
  }

  const assertive = toast.kind === 'danger' || toast.kind === 'warning';
  return (
    <div
      className={`toast ${toast.kind}${exiting ? ' exiting' : ''}`}
      role={assertive ? 'alert' : 'status'}
    >
      <Icon size={16} className="toast-icon" />
      <span className="toast-text">{toast.text}</span>
      <button className="btn-icon toast-close" aria-label="关闭" onClick={closeNow}>
        <XIcon size={14} />
      </button>
    </div>
  );
}

export function ToastHost(): React.JSX.Element {
  const toasts = useStudio((s) => s.toasts);
  const dismissToast = useStudio((s) => s.dismissToast);

  return createPortal(
    <div className="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>,
    document.body,
  );
}
