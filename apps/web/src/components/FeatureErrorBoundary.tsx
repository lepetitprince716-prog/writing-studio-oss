import { Component, type ReactNode } from 'react';

export interface FeatureErrorBoundaryProps {
  children: ReactNode;
  /** Human-readable feature name used by the local fallback. */
  featureName: string;
  /** Optional stable fallback for callers that own a more specific recovery UI. */
  fallback?: ReactNode;
  /** Optional class for a feature-specific layout (for example the graph shell). */
  fallbackClassName?: string;
  onError?(error: unknown): void;
  onRetry?(): void;
  onClose?(): void;
  closeLabel?: string;
}

interface FeatureErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a rejected lazy feature local to its mount point.
 *
 * Suspense owns the pending state. This boundary only handles a rejected
 * import (or a render error from the feature) and gives the user an explicit
 * way to recreate the lazy component or dismiss it.
 */
export class FeatureErrorBoundary extends Component<
  FeatureErrorBoundaryProps,
  FeatureErrorBoundaryState
> {
  state: FeatureErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(_error: unknown): FeatureErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  private retry = (): void => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  private close = (): void => {
    this.props.onClose?.();
  };

  render(): React.JSX.Element | ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    const className = ['feature-error', this.props.fallbackClassName]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={className} role="alert" aria-live="assertive">
        <p>{this.props.featureName}加载失败</p>
        <div>
          {this.props.onRetry && (
            <button type="button" className="btn-primary" onClick={this.retry}>
              重试
            </button>
          )}
          {this.props.onClose && (
            <button type="button" className="btn" onClick={this.close}>
              {this.props.closeLabel ?? '关闭'}
            </button>
          )}
        </div>
      </div>
    );
  }
}
