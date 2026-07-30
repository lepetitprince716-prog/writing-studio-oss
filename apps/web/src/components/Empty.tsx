/**
 * The three states an async region can be in besides having data.
 *
 * Which one to reach for is decided by the shape of the region, not by taste:
 * a region whose final layout is knowable (a list, a tree, a panel body) loads
 * with `LoadingSkeleton`; one that is a single line, inline, or a canvas loads
 * with plain text carrying `role="status"`, because a skeleton there would
 * misrepresent what is coming. `Empty` is a successful request with nothing to
 * show, so it is ordinary content and takes no ARIA role. `ErrorState` is a
 * failed one, and interrupts.
 */

import type { ReactNode } from 'react';

export function Empty({ icon, text }: { icon?: ReactNode; text: string }): React.JSX.Element {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-text">{text}</div>
    </div>
  );
}

/**
 * Failed request. `onRetry` is only for callers that already have a retry
 * action — this component is not a reason to wire one up where none exists.
 */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="empty-state empty-state-error" role="alert">
      <div className="empty-text">{message}</div>
      {onRetry && <button type="button" className="btn-ghost" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function LoadingSkeleton({ label = '正在加载' }: { label?: string }): React.JSX.Element {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      <span className="skeleton-bar" aria-hidden="true" />
      <span className="skeleton-bar" aria-hidden="true" />
      <span className="skeleton-bar" aria-hidden="true" />
    </div>
  );
}
