/**
 * Right pane: two clear tabs — 资料 (canon reference) and AI (threads).
 * Both bodies stay mounted; CSS toggles visibility so the composer draft and
 * scroll positions survive tab switches. A running run shows a badge on the
 * inactive AI tab.
 */

import { useStudio } from '../store.js';
import { SidebarPanel } from './SidebarPanel.js';
import { ThreadPanel } from './ThreadPanel.js';

export function RightPane(): React.JSX.Element {
  const tab = useStudio((s) => s.rightPaneTab);
  const setTab = useStudio((s) => s.setRightPaneTab);
  const running = useStudio((s) => s.running);

  return (
    <div className="right-pane">
      <div className="right-tabs" role="tablist" aria-label="侧栏">
        <button
          role="tab"
          className={tab === 'canon' ? 'right-tab active' : 'right-tab'}
          aria-selected={tab === 'canon'}
          onClick={() => setTab('canon')}
        >
          资料
        </button>
        <button
          role="tab"
          className={tab === 'ai' ? 'right-tab active' : 'right-tab'}
          aria-selected={tab === 'ai'}
          onClick={() => setTab('ai')}
        >
          AI
          {running && tab !== 'ai' && <span className="right-tab-badge" aria-label="运行中" />}
        </button>
      </div>
      <div className="right-tab-body" hidden={tab !== 'canon'}>
        <SidebarPanel />
      </div>
      <div className="right-tab-body" hidden={tab !== 'ai'}>
        <ThreadPanel />
      </div>
    </div>
  );
}
