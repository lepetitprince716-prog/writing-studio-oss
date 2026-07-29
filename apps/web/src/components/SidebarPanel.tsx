/**
 * Canon sidebar: tabbed sources dispatched to structured DTO views by
 * parser/kind. `plain` payloads use a safe token-to-React Markdown renderer;
 * an active query intentionally falls back to exact line matches.
 */

import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useStudio } from '../store.js';
import { SettingIndexView } from './sidebar/SettingIndexView.js';
import { WritingStatusView } from './sidebar/WritingStatusView.js';
import { CharacterCardView } from './sidebar/CharacterCardView.js';
import { ForeshadowView } from './sidebar/ForeshadowView.js';
import { Empty, LoadingSkeleton } from './Empty.js';
import { BookIcon } from './icons.js';
import type { CanonSectionRef } from '@writing-studio/contract';
import { resolveCanonHeading, resolveCanonSource } from '../lib/canonSource.js';
import { CanonRepairButton } from './sidebar/CanonRepairButton.js';
import type { SidebarMenuSource } from './sidebar/sidebar-menu-specs.js';

const LazySafeMarkdown = lazy(async () => {
  const module = await import('./SafeMarkdown.js');
  return { default: module.SafeMarkdown };
});

function PlainView({
  markdown,
  sections,
  onRepair,
}: {
  markdown: string;
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const lines = query
    ? markdown.split('\n').filter((l) => l.toLowerCase().includes(query.toLowerCase()))
    : markdown.split('\n');
  return (
    <div className="dto-root">
      {sections.length > 0 && (
        <div className="canon-section-actions">
          {sections.map((section) => (
            <span key={section.headingPath.join('\u0000')}>
              <span>{section.headingPath.join(' / ')}</span>
              <CanonRepairButton section={section} onRepair={onRepair} />
            </span>
          ))}
        </div>
      )}
      <input
        className="sidebar-search"
        placeholder="筛选（按行匹配）…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query
        ? <pre className="sidebar-plain">{lines.join('\n')}</pre>
        : (
            <div className="md-render">
              <Suspense fallback={<pre className="sidebar-plain">{markdown}</pre>}>
                <LazySafeMarkdown markdown={markdown} />
              </Suspense>
            </div>
          )}
    </div>
  );
}

export function SidebarPanel(): React.JSX.Element {
  const [pendingJump, setPendingJump] = useState<SidebarMenuSource | null>(null);
  const sidebarBodyRef = useRef<HTMLDivElement | null>(null);
  const sidebar = useStudio((s) => s.sidebar);
  const activeSidebarId = useStudio((s) => s.activeSidebarId);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const projectsLoaded = useStudio((s) => s.projectsLoaded);
  const projectDataLoading = useStudio((s) => s.projectDataLoading);
  const project = useStudio((s) =>
    s.projects.find((candidate) => candidate.config.id === activeProjectId),
  );
  const startCanonRewrite = useStudio((s) => s.startCanonRewrite);
  const openCanonSource = useStudio((s) => s.openCanonSource);
  const labels = new Map(
    project?.config.sidebarSources.map((source) => [source.id, source.label] as const) ?? [],
  );

  const active = sidebar.find((p) => p.sourceId === activeSidebarId) ?? sidebar[0];
  const latestChapter = sidebar.find((payload) =>
    payload.parser === 'heading-sections' && payload.kind === 'writingStatus')
    ?.data.stopChapter ?? null;

  useEffect(() => {
    if (!pendingJump) return;
    const source = project?.config.sidebarSources.find(
      (candidate) => candidate.file === pendingJump.docId,
    );
    if (!source || source.id !== activeSidebarId) return;
    const root = sidebarBodyRef.current;
    if (!root) return;

    const scrollToHeading = (): boolean => {
      const candidates = root.querySelectorAll<HTMLElement>(
        '[data-canon-heading], h1, h2, h3, h4, h5, h6',
      );
      const target = [...candidates].find((candidate) =>
        candidate.dataset.canonHeading === pendingJump.heading
        || candidate.textContent?.trim() === pendingJump.heading);
      if (!target) return false;
      target.scrollIntoView({ block: 'center' });
      setPendingJump(null);
      return true;
    };

    if (scrollToHeading()) return;
    // Plain Markdown is lazy-rendered. Observe only the sidebar body and stop
    // as soon as its requested heading appears.
    const observer = new MutationObserver(() => {
      if (scrollToHeading()) {
        observer.disconnect();
        setPendingJump(null);
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => observer.disconnect(), 1_000);
    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [activeSidebarId, pendingJump, project]);

  function renderActive(): React.JSX.Element {
    if (!projectsLoaded || projectDataLoading) {
      return <LoadingSkeleton label="正在加载侧栏" />;
    }
    if (!active) return <Empty icon={<BookIcon size={22} />} text="无侧栏数据源" />;
    const source = project?.config.sidebarSources.find((candidate) => candidate.id === active.sourceId);
    const sourceFile = source?.file ?? '';
    const sections = active.writerSections ?? [];
    const repair = (section: CanonSectionRef): void => {
      if (sourceFile) void startCanonRewrite(sourceFile, section);
    };
    const openSource = (target: SidebarMenuSource): void => {
      setPendingJump(target);
      openCanonSource(target.docId, target.heading);
    };
    const resolveSource = (raw: string): SidebarMenuSource | null => {
      const reference = resolveCanonSource(raw, project?.config.sidebarSources ?? []);
      if (!reference) return null;
      const targetConfig = project?.config.sidebarSources.find(
        (candidate) => candidate.file === reference.docId,
      );
      const targetPayload = targetConfig
        ? sidebar.find((payload) => payload.sourceId === targetConfig.id)
        : undefined;
      const heading = resolveCanonHeading(
        reference.headingPrefix,
        targetPayload?.writerSections ?? [],
      );
      return heading ? { docId: reference.docId, heading } : null;
    };
    switch (active.parser) {
      case 'markdown-table':
        return (
          <SettingIndexView
            entries={active.entries}
            sections={sections}
            onRepair={repair}
            sourceFile={sourceFile}
            onOpenSource={openSource}
            resolveSource={resolveSource}
          />
        );
      case 'heading-sections':
        if (active.kind === 'writingStatus') {
          return (
            <WritingStatusView
              data={active.data}
              sections={sections}
              onRepair={repair}
              sourceFile={sourceFile}
              chapterLeaf={project?.config.contentTree.leaf}
            />
          );
        }
        if (active.kind === 'characters') {
          return (
            <CharacterCardView
              cards={active.data}
              sections={sections}
              onRepair={repair}
              latestChapter={latestChapter}
              sourceFile={sourceFile}
            />
          );
        }
        return (
          <ForeshadowView
            entries={active.data}
            sections={sections}
            onRepair={repair}
            sourceFile={sourceFile}
          />
        );
      case 'plain':
        return <PlainView markdown={active.markdown} sections={sections} onRepair={repair} />;
    }
  }

  return (
    <div className="sidebar-panel">
      <div className="sidebar-tabs" role="tablist">
        {sidebar.map((p) => (
          <button
            key={p.sourceId}
            role="tab"
            aria-selected={p.sourceId === active?.sourceId}
            className={p.sourceId === active?.sourceId ? 'tab active' : 'tab'}
            onClick={() => useStudio.setState({ activeSidebarId: p.sourceId })}
          >
            {labels.get(p.sourceId) ?? p.sourceId}
          </button>
        ))}
      </div>
      <div className="sidebar-body" ref={sidebarBodyRef}>{renderActive()}</div>
    </div>
  );
}
