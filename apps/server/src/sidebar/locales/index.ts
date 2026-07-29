import type { ProjectConfig } from '@writing-studio/contract';
import { EN_WRITING_STATUS_HEADINGS } from './en.js';
import type { WritingStatusSectionHeadings } from './types.js';
import { ZH_CN_WRITING_STATUS_HEADINGS } from './zh-CN.js';

export function writingStatusHeadings(
  localePreset: ProjectConfig['localePreset'],
): WritingStatusSectionHeadings {
  const resolvedLocale = localePreset ?? 'zh-CN';
  switch (resolvedLocale) {
    case 'en':
      return EN_WRITING_STATUS_HEADINGS;
    case 'zh-CN':
      return ZH_CN_WRITING_STATUS_HEADINGS;
    default: {
      // Unreachable by type; keep the zh-CN fallback should it ever be
      // reached at runtime past the schema boundary.
      const exhaustive: never = resolvedLocale;
      void exhaustive;
      return ZH_CN_WRITING_STATUS_HEADINGS;
    }
  }
}
