/** Diagnostic-only view of the sources actually injected into the latest run. */

import type { ContextManifest } from '@writing-studio/contract';

export function ContextManifestPanel({
  manifest,
}: {
  manifest: ContextManifest | null;
}): React.JSX.Element | null {
  if (!manifest || manifest.length === 0) return null;
  return (
    <details className="context-manifest">
      <summary>本轮注入（{manifest.length}）</summary>
      <div className="context-manifest-list">
        {manifest.map((entry) => (
          <div className="context-manifest-row" key={`${entry.trigger}:${entry.sourceId}`}>
            <span className="context-manifest-source" title={entry.sourceId}>{entry.sourceId}</span>
            <span>{entry.injectedChars.toLocaleString()}/{entry.originalChars.toLocaleString()}</span>
            {entry.truncated && <span className="context-manifest-truncated">已截断</span>}
            <span className={`context-manifest-trigger ${entry.trigger}`}>{entry.trigger}</span>
            <span>quota {entry.quotaChars.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
