/**
 * 伏笔 view: an accordion per foreshadow entry with an F-number badge and a
 * status colour dot; expanding reveals the body.
 */

import { useState } from 'react';
import type { CanonSectionRef, ForeshadowEntry } from '@writing-studio/contract';
import { copyText } from '../../lib/clipboard.js';
import { ContextMenu, useContextMenu } from '../ContextMenu.js';
import { Empty } from '../Empty.js';
import { ChevronRightIcon } from '../icons.js';
import { CanonRepairButton } from './CanonRepairButton.js';
import {
  createSidebarEntryMenuSpec,
} from './sidebar-menu-specs.js';

function statusClass(status: string | null): string {
  if (!status) return 'other';
  const s = status.trim();
  if (s.includes('回收') || s.includes('已')) return 'done';
  if (s.includes('活跃') || s.includes('埋') || s.includes('待')) return 'tentative';
  return 'other';
}

function Entry({
  entry,
  defaultOpen,
  section,
  onRepair,
  sourceFile,
  openEntryMenu,
}: {
  entry: ForeshadowEntry;
  defaultOpen: boolean;
  section: CanonSectionRef | undefined;
  onRepair: (section: CanonSectionRef) => void;
  sourceFile: string;
  openEntryMenu: (
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const heading = section?.headingPath.at(-1) ?? `${entry.id}：${entry.title}`;
  const entrySpec = createSidebarEntryMenuSpec({
    label: `${entry.id}：${entry.title}`,
    sourceFile,
    source: null,
    showJump: false,
    repairSection: section,
    actions: {
      repair: onRepair,
      copyName: async () => {
        await copyText(entry.title, '词条名已复制');
      },
      copyEntry: async () => {
        await copyText(
          `${entry.id}：${entry.title}${entry.status ? ` · ${entry.status}` : ''}\n${entry.body}`,
          '词条已复制',
        );
      },
    },
  });
  return (
    <div
      className="dto-card"
      data-canon-heading={heading}
      tabIndex={0}
      onContextMenu={(event) => openEntryMenu(event, entrySpec)}
      onKeyDown={(event) => openEntryMenu(event, entrySpec)}
    >
      <div className="character-card-head">
        <button className="dto-accordion-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={open ? 'tree-dir-caret open' : 'tree-dir-caret'}>
            <ChevronRightIcon size={13} />
          </span>
          <span className="foreshadow-id">{entry.id}</span>
          <span className="foreshadow-title">{entry.title}</span>
          {entry.status && <span className={`status-dot ${statusClass(entry.status)}`} title={entry.status} />}
        </button>
        <CanonRepairButton section={section} onRepair={onRepair} />
      </div>
      {open && <div className="dto-body dto-subsection">{entry.body}</div>}
    </div>
  );
}

export function ForeshadowView({
  entries,
  sections,
  onRepair,
  sourceFile,
}: {
  entries: ForeshadowEntry[];
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
  sourceFile: string;
}): React.JSX.Element {
  const menu = useContextMenu();

  function openEntryMenu(
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ): void {
    if ('clientX' in event) menu.openFromEvent(event, spec);
    else menu.openFromKeyboard(event, spec);
  }

  if (entries.length === 0) return <Empty text="暂无伏笔" />;
  return (
    <div className="dto-root">
      {entries.map((entry, i) => (
        <Entry
          key={entry.id}
          entry={entry}
          defaultOpen={i === 0}
          section={sections.find((section) => {
            const heading = section.headingPath.at(-1) ?? '';
            return heading.includes(entry.id) && heading.includes(entry.title);
          })}
          onRepair={onRepair}
          sourceFile={sourceFile}
          openEntryMenu={openEntryMenu}
        />
      ))}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
