/** Empty-state placeholder: a muted icon over a one-line prompt. */

import type { ReactNode } from 'react';

export function Empty({ icon, text }: { icon?: ReactNode; text: string }): React.JSX.Element {
  return (
    <div className="empty-state">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-text">{text}</div>
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
