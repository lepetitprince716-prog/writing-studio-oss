import type { CanonSectionRef } from '@writing-studio/contract';
import { withDisabledReason, type ContextMenuSpec } from '../ContextMenu.js';

export interface SidebarMenuSource {
  docId: string;
  heading: string;
}

export interface SidebarEntryMenuActions {
  openSource?(source: SidebarMenuSource): void;
  repair(section: CanonSectionRef): void;
  copyName(): void | Promise<void>;
  copyEntry(): void | Promise<void>;
  showMentions?(): void | Promise<void>;
}

export interface SidebarEntryMenuOptions {
  label: string;
  /** Active sidebar source. Empty means its config is unavailable. */
  sourceFile: string;
  sourceRaw?: string;
  source: SidebarMenuSource | null;
  /** DTOs without provenance hide their jump action instead of self-linking. */
  showJump?: boolean;
  repairSection: CanonSectionRef | undefined;
  actions: SidebarEntryMenuActions;
}

/** Pure sidebar-entry menu factory shared by all four structured canon views. */
export function createSidebarEntryMenuSpec(
  options: SidebarEntryMenuOptions,
): ContextMenuSpec {
  const items: ContextMenuSpec['items'] = [];

  if (options.sourceFile && options.showJump !== false) {
    items.push(withDisabledReason({
      id: 'open-canon-source',
      label: '跳转到出处',
      disabled: options.source === null,
      onSelect: () => {
        if (options.source) options.actions.openSource?.(options.source);
      },
    }, options.source === null ? `出处格式无法解析：${options.sourceRaw ?? ''}` : undefined));
  }

  if (options.sourceFile) {
    items.push(withDisabledReason({
      id: 'repair-canon-section',
      label: '修订此节…',
      disabled: options.repairSection === undefined,
      onSelect: () => {
        if (options.repairSection) options.actions.repair(options.repairSection);
      },
    }, options.repairSection === undefined ? '该词条所在分节不可修订' : undefined));
  }

  if (items.length > 0) {
    items.push({ id: 'sidebar-entry-copy-separator', separator: true });
  }
  items.push(
    {
      id: 'copy-sidebar-entry-name',
      label: '复制词条名',
      onSelect: options.actions.copyName,
    },
    {
      id: 'copy-sidebar-entry',
      label: '复制整条',
      onSelect: options.actions.copyEntry,
    },
  );

  if (options.actions.showMentions) {
    items.push({
      id: 'show-character-mentions',
      label: '查看正文提及',
      onSelect: options.actions.showMentions,
    });
  }

  return { label: `${options.label} · 操作`, items };
}
