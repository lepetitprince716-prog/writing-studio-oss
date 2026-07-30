import type { ProjectConfig } from '@writing-studio/contract';
import { EN_WRITING_STATUS_FORESHADOW_COLUMNS, EN_WRITING_STATUS_HEADINGS } from './en.js';
import type {
  WritingStatusForeshadowColumns,
  WritingStatusSectionHeadings,
} from './types.js';
import {
  ZH_CN_WRITING_STATUS_FORESHADOW_COLUMNS,
  ZH_CN_WRITING_STATUS_HEADINGS,
} from './zh-CN.js';

interface WritingStatusLocalePack {
  headings: WritingStatusSectionHeadings;
  foreshadowColumns: WritingStatusForeshadowColumns;
}

const ZH_CN_PACK: WritingStatusLocalePack = {
  headings: ZH_CN_WRITING_STATUS_HEADINGS,
  foreshadowColumns: ZH_CN_WRITING_STATUS_FORESHADOW_COLUMNS,
};

const EN_PACK: WritingStatusLocalePack = {
  headings: EN_WRITING_STATUS_HEADINGS,
  foreshadowColumns: EN_WRITING_STATUS_FORESHADOW_COLUMNS,
};

function writingStatusPack(
  localePreset: ProjectConfig['localePreset'],
): WritingStatusLocalePack {
  const resolvedLocale = localePreset ?? 'zh-CN';
  switch (resolvedLocale) {
    case 'en':
      return EN_PACK;
    case 'zh-CN':
      return ZH_CN_PACK;
    default: {
      // Unreachable by type; keep the zh-CN fallback should it ever be
      // reached at runtime past the schema boundary.
      const exhaustive: never = resolvedLocale;
      void exhaustive;
      return ZH_CN_PACK;
    }
  }
}

export function writingStatusHeadings(
  localePreset: ProjectConfig['localePreset'],
): WritingStatusSectionHeadings {
  return writingStatusPack(localePreset).headings;
}

/** Fallback column labels, used only where the vault's table has no header cell of its own. */
export function writingStatusForeshadowColumns(
  localePreset: ProjectConfig['localePreset'],
): WritingStatusForeshadowColumns {
  return writingStatusPack(localePreset).foreshadowColumns;
}
