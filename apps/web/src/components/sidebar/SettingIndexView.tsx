/**
 * 设定索引 view: markdown-table entries grouped by section, with a search box
 * and collapsible sections. Each entry is a card: bold term + status chip.
 */

import { useMemo, useState } from 'react';
import type { CanonSectionRef, SettingIndexEntry } from '@writing-studio/contract';
import { copyText } from '../../lib/clipboard.js';
import { ContextMenu, isContextMenuOpenKey, useContextMenu } from '../ContextMenu.js';
import { ChevronRightIcon } from '../icons.js';
import { CanonRepairButton } from './CanonRepairButton.js';
import {
  createSidebarEntryMenuSpec,
  type SidebarMenuSource,
} from './sidebar-menu-specs.js';

function statusClass(status: string): string {
  const s = status.trim();
  if (!s) return 'other';
  if (s.includes('暂') || s.includes('待')) return 'tentative';
  if (s.includes('定') || s.includes('确')) return 'done';
  return 'other';
}

function Section({
  name,
  entries,
  repairSection,
  onRepair,
  sourceFile,
  onOpenSource,
  resolveSource,
  openEntryMenu,
}: {
  name: string;
  entries: SettingIndexEntry[];
  repairSection: CanonSectionRef | undefined;
  onRepair: (section: CanonSectionRef) => void;
  sourceFile: string;
  onOpenSource: (source: SidebarMenuSource) => void;
  resolveSource: (raw: string) => SidebarMenuSource | null;
  openEntryMenu: (
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const entrySpec = (entry: SettingIndexEntry) => createSidebarEntryMenuSpec({
    label: entry.term,
    sourceFile,
    sourceRaw: entry.source,
    source: resolveSource(entry.source),
    repairSection,
    actions: {
      openSource: onOpenSource,
      repair: onRepair,
      copyName: async () => {
        await copyText(entry.term, '词条名已复制');
      },
      copyEntry: async () => {
        await copyText(
          `${entry.term}${entry.serial ? `（${entry.serial}）` : ' '}· ${entry.status}\n`
          + `出处：${entry.source}\n首次出现：${entry.firstAppearance}`,
          '词条已复制',
        );
      },
    },
  });
  return (
    <div className="dto-section" data-canon-heading={name.split(' > ').at(-1) ?? name}>
      <div className="dto-section-head">
        <button className="dto-section-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={open ? 'tree-dir-caret open' : 'tree-dir-caret'}>
            <ChevronRightIcon size={13} />
          </span>
          {name || '未分节'}
          <span className="dto-section-count">{entries.length}</span>
        </button>
        <CanonRepairButton section={repairSection} onRepair={onRepair} />
      </div>
      {open &&
        entries.map((e, i) => (
          <div
            className="dto-card"
            key={`${e.term}-${i}`}
            tabIndex={0}
            onContextMenu={(event) => openEntryMenu(event, entrySpec(e))}
            onKeyDown={(event) => {
              if (!isContextMenuOpenKey(event)) return;
              openEntryMenu(event, entrySpec(e));
            }}
          >
            <div>
              <span className="dto-term">{e.term}</span>
              {e.serial && <span className="dto-serial">{e.serial}</span>}
              {e.status && <span className={`status-chip ${statusClass(e.status)}`}>{e.status}</span>}
            </div>
            {e.source && <div className="dto-line">出处：{e.source}</div>}
            {e.firstAppearance && <div className="dto-line">首次出现：{e.firstAppearance}</div>}
            {e.blankLink && <div className="dto-line">关联留白：{e.blankLink}</div>}
          </div>
        ))}
    </div>
  );
}

export function SettingIndexView({
  entries,
  sections,
  onRepair,
  sourceFile,
  onOpenSource,
  resolveSource,
}: {
  entries: SettingIndexEntry[];
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
  sourceFile: string;
  onOpenSource: (source: SidebarMenuSource) => void;
  resolveSource: (raw: string) => SidebarMenuSource | null;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const menu = useContextMenu();

  function openEntryMenu(
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ): void {
    if ('clientX' in event) menu.openFromEvent(event, spec);
    else menu.openFromKeyboard(event, spec);
  }

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) =>
          [e.term, e.source, e.section, e.status, e.blankLink].some((v) => v.toLowerCase().includes(q)),
        )
      : entries;
    const map = new Map<string, SettingIndexEntry[]>();
    for (const e of filtered) {
      const list = map.get(e.section) ?? [];
      list.push(e);
      map.set(e.section, list);
    }
    return [...map.entries()];
  }, [entries, query]);

  return (
    <div className="dto-root">
      <input
        className="sidebar-search"
        placeholder="搜索术语 / 出处 / 分节…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {grouped.length === 0 ? (
        <div className="muted">无匹配词条</div>
      ) : (
        grouped.map(([section, list]) => (
          <Section
            key={section}
            name={section}
            entries={list}
            repairSection={sections.find((candidate) => candidate.headingPath.join(' > ') === section)}
            onRepair={onRepair}
            sourceFile={sourceFile}
            onOpenSource={onOpenSource}
            resolveSource={resolveSource}
            openEntryMenu={openEntryMenu}
          />
        ))
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
