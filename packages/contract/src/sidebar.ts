/**
 * Sidebar DTOs. Parsing happens server-side; the web app renders these
 * shapes directly. writerSafeMode filtering (author-only sections) is
 * applied at the server before DTOs leave the process.
 */

import type {
  Anchor,
  WritingStatusForeshadowColumns,
  WritingStatusSectionHeadings,
} from './models.js';

/** Sidebar safety context selected by `view` query parameter. */
export type SidebarView = 'writer' | 'planner';

/** One complete writer-visible H2/H3 section eligible for anchored canon repair. */
export interface CanonSectionRef {
  headingPath: string[];
  anchor: Anchor;
}

/** One row of 设定索引.md (normalized across sections with varying columns). */
export interface SettingIndexEntry {
  /** Section path, e.g. "一、地理 > 1.2 主要水系". */
  section: string;
  term: string;
  /** 定义出处 column. */
  source: string;
  /** 首次正文出现 column. */
  firstAppearance: string;
  /** 关联留白/AUTHOR_ONLY column. */
  blankLink: string;
  status: string;
  /** Optional 编号 column present in some sections. */
  serial: string | null;
}

export interface WritingStatusDto {
  /** Resolved H2 labels used to parse this payload and identify canon-repair anchors. */
  sectionHeadings: WritingStatusSectionHeadings;
  /** 最后刷新 date + stop-point chapter parsed from the header blockquote. */
  lastRefreshed: string | null;
  stopChapter: number | null;
  /** ## 停点 section body. */
  stopPoint: string;
  /** ## 故事线 entries: bolded line name → body. */
  storylines: Array<{ name: string; body: string }>;
  /** ## 活跃伏笔速览 table rows. */
  activeForeshadow: Array<{ id: string; content: string; status: string }>;
  /** Header labels of that table, so the panel can caption it with the vault's own words. */
  activeForeshadowColumns: WritingStatusForeshadowColumns;
  /** ## 角色一句话状态 list items. */
  characterOneLiners: Array<{ name: string; text: string }>;
  /** ## 写作红线 numbered items. */
  redLines: string[];
  /** ## 表达基线 body. */
  expressionBaseline: string;
}

export interface CharacterCardSection {
  heading: string;
  body: string;
  /** True when the heading carries 作者侧/未公开 markers. Filtered out in writer-safe DTOs. */
  authorOnly: boolean;
}

export interface CharacterCard {
  /** H2 heading, e.g. "角色A（RoleA）". */
  name: string;
  sections: CharacterCardSection[];
}

export interface ForeshadowEntry {
  /** e.g. "F07". */
  id: string;
  title: string;
  body: string;
  /** Extracted 回收状态 field when present. */
  status: string | null;
}

export type SidebarPayload =
  | { sourceId: string; parser: 'markdown-table'; entries: SettingIndexEntry[]; writerSections?: CanonSectionRef[] }
  | { sourceId: string; parser: 'heading-sections'; kind: 'writingStatus'; data: WritingStatusDto; writerSections?: CanonSectionRef[] }
  | { sourceId: string; parser: 'heading-sections'; kind: 'characters'; data: CharacterCard[]; writerSections?: CanonSectionRef[] }
  | { sourceId: string; parser: 'heading-sections'; kind: 'foreshadowing'; data: ForeshadowEntry[]; writerSections?: CanonSectionRef[] }
  | { sourceId: string; parser: 'plain'; markdown: string; writerSections?: CanonSectionRef[] };
