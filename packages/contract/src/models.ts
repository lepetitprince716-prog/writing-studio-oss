/**
 * Core domain models shared between the server and the web client.
 * Contract change policy: any edit to this file requires both sides to
 * compile in the same PR. See repository README.
 */

import type { ProjectGraphConfig } from './graph.js';
import type { PromptBundleOverride } from './prompts.js';
import type { AgentId } from './agent-ids.js';
export type { AgentId } from './agent-ids.js';

// ---------- Project ----------

/** Number rendering style used in directory / file name patterns. */
export type NumberStyle = 'arabic' | 'cnLower';

export interface ContentTreeLevel {
  /** UI label for this level, e.g. "part" / "arc". */
  levelName: string;
  /** Directory name pattern with `{num}` and `{name}` placeholders, e.g. `第{num}部_{name}`. */
  dirPattern: string;
  numberStyle: NumberStyle;
  /** Index file inside this level's directory, if any (e.g. `README.md`). */
  indexFile: string | null;
}

export interface ContentTreeLeaf {
  /**
   * Chapter file pattern with `{num}` placeholder, e.g. `第{num}章.md`.
   * Only the first `{num}` occurrence is substituted.
   */
  filePattern: string;
  numberStyle: NumberStyle;
  /**
   * H1 title text template. Placeholders: `{num}` (chapter number rendered per
   * `numberStyle`), `{numCn}` (forced Chinese lowercase numerals), `{title}`
   * (the chapter title). Unknown placeholders are preserved verbatim. Omitted
   * configs preserve the legacy Chinese heading (`第{numCn}章 {title}`).
   */
  titleTemplate?: string | null | undefined;
  /** Whether chapter numbers are continuous across the whole book or restart per level. */
  numberingScope: 'book' | 'perLevel';
  /** Regex (string) stripped from the first H1 to obtain the display title; null keeps H1 as-is. */
  titleStripRegex: string | null;
}

export interface ContentTree {
  /** Manuscript root directory relative to vault root, e.g. `正文`. */
  root: string;
  /** 0 entries = flat; 1 = two-level; 2 = three-level (part/arc/chapter). */
  levels: ContentTreeLevel[];
  leaf: ContentTreeLeaf;
}

export type SidebarParser = 'markdown-table' | 'heading-sections' | 'plain';

/** The server-side parser used by a sidebar source. */
export type SidebarHeadingSectionsKind = 'writingStatus' | 'characters' | 'foreshadowing';

export interface MarkdownTableSidebarConfig {
  sectionHeadingLevels: number[];
  columnAliases: {
    term: string[];
    source: string[];
    firstAppearance: string[];
    blankLink: string[];
    status: string[];
    serial: string[];
  };
  /** Fields cleared from writer DTOs. Defaults to the author-side blankLink. */
  writerHiddenFields?: Array<keyof MarkdownTableSidebarConfig['columnAliases']> | undefined;
}

export interface CharactersSidebarConfig {
  kind: 'characters';
  cardHeadingLevel: number;
  sectionHeadingLevel: number;
  authorOnlyMarkers: string[];
}

/** Fully resolved writing-status section labels after locale and project overrides. */
export interface WritingStatusSectionHeadings {
  stopPoint: string;
  storylines: string;
  activeForeshadow: string;
  characterOneLiners: string;
  redLines: string;
  expressionBaseline: string;
}

export type WritingStatusSectionHeadingOverrides = {
  [Key in keyof WritingStatusSectionHeadings]?: string | undefined;
};

/**
 * Column labels of the active-foreshadow table, taken from the table's own header
 * row when it has one and falling back to the locale pack otherwise.
 */
export interface WritingStatusForeshadowColumns {
  id: string;
  content: string;
  status: string;
}

export interface WritingStatusSidebarConfig {
  kind: 'writingStatus';
  lastRefreshedRegex: string;
  stopChapterRegex: string;
  /** Optional localized section labels; omitted keys fall back to the built-in pack selected by the project's `localePreset`. */
  sectionHeadings?: WritingStatusSectionHeadingOverrides | undefined;
}

export interface ForeshadowingSidebarConfig {
  kind: 'foreshadowing';
  itemHeadingLevel: number;
  itemIdRegex: string;
  statusFieldRegex: string;
  /** Full tracker visibility in writer view. Defaults to false (fail closed). */
  writerVisible?: boolean | undefined;
}

interface SidebarSourceBase {
  /** Stable id, e.g. `setting_index`. */
  id: string;
  label: string;
  /** File path relative to vault root. */
  file: string;
  order: number;
  /** Context injection policy. Omitted project configs keep the legacy always-on behavior. */
  injection?: 'always' | 'mention' | undefined;
}

/**
 * Parser configuration is deliberately a discriminated union. `yaml-card` is
 * not implemented and must not be accepted as a config value.
 */
export type SidebarSource = SidebarSourceBase & (
  | {
      parser: 'markdown-table';
      parserConfig: MarkdownTableSidebarConfig;
    }
  | {
      parser: 'heading-sections';
      parserConfig: WritingStatusSidebarConfig | CharactersSidebarConfig | ForeshadowingSidebarConfig;
    }
  | {
      parser: 'plain';
      parserConfig: Record<never, never>;
    }
);

/** Which files an AI profile may have injected into its context. */
export interface AiProfile {
  description: string;
  /** Paths or globs (relative to vault root) allowed as context sources. */
  readable: string[];
  /** Paths or globs that must NEVER enter this profile's context. Takes precedence. */
  forbidden: string[];
  /** Structured sidebar source ids automatically injected into a writer turn. */
  contextSources?: string[] | undefined;
  /** Whether threads under this profile may let the agent browse the vault with read tools. */
  allowVaultBrowsing: boolean;
}

export interface AiProfiles {
  writer: AiProfile;
  planner: AiProfile;
  defaultProfile: 'writer' | 'planner';
}

/** Optional context matching controls. Defaults deliberately match nothing. */
export interface ProjectContextConfig {
  /** Exact aliases that must never trigger mention-based context injection. */
  excludeTerms: string[];
}

/** One project-defined regex lint rule. Custom rules are always style findings. */
export interface LintStyleRuleConfig {
  ruleId: string;
  pattern: string;
  message: string;
  severity: LintSeverity;
  category: 'style';
}

/** Optional project-level additions and overrides for deterministic lint. */
export interface ProjectLintConfig {
  /** Regex rules merged with the selected built-in pack by ruleId. */
  styleRules?: LintStyleRuleConfig[] | undefined;
  /** Built-in ruleIds omitted before custom rules are merged. Unknown ids are harmless. */
  disableBuiltinStyleRules?: string[] | undefined;
  /** Replacement list for the built-in same-sentence idiom-stack detector. */
  idiomStackList?: string[] | undefined;
}

/**
 * Authoritative project config, stored INSIDE the vault at
 * `.writing-studio/project.json`. The panel-side registry only keeps pointers.
 */
export interface ProjectConfig {
  schemaVersion: 1;
  id: string;
  displayName: string;
  /** Built-in labels used by localized server-side parsers. Omission preserves zh-CN behavior. */
  localePreset?: 'zh-CN' | 'en' | undefined;
  /** Optional per-key model prompt overrides layered over the locale bundle. */
  prompts?: {
    overrides?: PromptBundleOverride | undefined;
  } | undefined;
  /** Optional deterministic lint additions and built-in rule controls. */
  lint?: ProjectLintConfig | undefined;
  contentTree: ContentTree;
  /** Draft directory relative to vault root, e.g. `草稿`. Created on demand. */
  draftsDir: string;
  sidebarSources: SidebarSource[];
  /** Optional WorldGraph Module configuration; omission hides the feature completely. */
  graph?: ProjectGraphConfig | undefined;
  /** Mention-triggered context settings. */
  context?: ProjectContextConfig | undefined;
  aiProfiles: AiProfiles;
  /** Default agent for new threads. */
  defaultAgentId: AgentId;
  /** Optional external review script hooks (impact scan, mechanical review); validated if present but not yet consumed by the server or web app. */
  reviewScripts?:
    | {
        pythonExecutable: string;
        impactScan?: string | undefined;
        mechanicalReview?: string | undefined;
      }
    | undefined;
}

/** Runtime project handle returned by the API (config + resolved paths). */
export interface Project {
  config: ProjectConfig;
  /** Absolute vault root path. */
  vaultRoot: string;
  /** Absolute panel data dir for this project (outside the vault). */
  dataDir: string;
}

/**
 * Item returned by `GET /api/projects`.
 *
 * A project with an unreadable or invalid vault config is intentionally not
 * represented as a partial `Project`: callers must branch on `status` before
 * navigating into config-dependent views.
 */
export type ProjectListItem =
  | { status: 'ready'; project: Project }
  | {
      status: 'invalid';
      /** Registry id, retained so the UI can identify the broken entry. */
      id: string;
      displayName: string;
      vaultRoot: string;
      dataDir: string;
      error: string;
    };

// ---------- Documents ----------

export type DocKind = 'chapter' | 'draft' | 'canon';

export interface DocumentMeta {
  /** Stable id = vault-relative path (POSIX separators). */
  docId: string;
  projectId: string;
  kind: DocKind;
  /** Display title (first H1 with titleStripRegex applied, else file name). */
  title: string;
  /** Chapter number when derivable from the file pattern. */
  chapterNo: number | null;
  sha256: string;
  bytes: number;
  mtimeMs: number;
}

export interface ChapterTreeNode {
  /** Directory display name, e.g. `第二部_部名`. */
  name: string;
  levelName: string;
  children: ChapterTreeNode[];
  chapters: DocumentMeta[];
}

export interface ChapterTree {
  root: ChapterTreeNode;
}

// ---------- Threads / Messages ----------

export type ThreadKind = 'ask' | 'rewrite' | 'chat';

/**
 * Durable record of one agent turn. This is deliberately terminal-state
 * recoverable over REST, because a WebSocket client may miss its final event.
 */
export interface Run {
  id: string;
  projectId: string;
  threadId: string;
  agentId: AgentId;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  /** Stable public error classification. */
  errorCode: string | null;
  /** Bounded, ANSI-free diagnostic emitted by the CLI itself. */
  errorDetail?: string | null;
  /** Actual model id reported by the agent CLI, when its stream provides one. */
  modelId?: string | undefined;
  createdAt: number;
  finishedAt: number | null;
}

/** One source actually injected into a thread-context payload. */
export interface ContextManifestEntry {
  sourceId: string;
  originalChars: number;
  injectedChars: number;
  truncated: boolean;
  quotaChars: number;
  trigger: 'always' | 'mention';
}

/** Diagnostic-only context injection record; never part of the public Run DTO. */
export type ContextManifest = ContextManifestEntry[];

/**
 * Selection anchor (W3C TextQuoteSelector style). `start`/`end` are hints;
 * the quote triple is the durable truth used for re-anchoring.
 */
export interface Anchor {
  /** Document sha256 at anchor creation time (drift detection). */
  docSha: string;
  /** Start offset in JavaScript UTF-16 code units. */
  start: number;
  /** End offset in JavaScript UTF-16 code units (exclusive). */
  end: number;
  /** ~32 chars of context before the selection. */
  prefix: string;
  /** The selected text itself. */
  exact: string;
  /** ~32 chars of context after the selection. */
  suffix: string;
}

export type AnchorResolution =
  | { status: 'exact'; start: number; end: number }
  | {
      status: 'fuzzy';
      start: number;
      end: number;
      /** Similarity score in the inclusive range 0..1. */
      score: number;
    }
  | { status: 'lost' };

/**
 * Re-anchoring rule: if `exact` has multiple occurrences, select the one
 * whose start offset is nearest to the previous `Anchor.start` before using
 * prefix/suffix or fuzzy matching.
 */
export type AnchorDuplicateMatchRule = 'nearest-previous-start';

/**
 * Roleplay persona bound to a `chat` thread. The server assembles the persona
 * context from the character's writer-view card (author-only sections are
 * stripped at the source), so a chat thread can never leak future plot.
 */
export interface ChatPersona {
  /** Character card heading name in the project's characters sidebar source. */
  characterName: string;
  /**
   * Optional inclusive chapter boundary for the character's knowledge.
   * Omitted means the existing untruncated writer-safe projection.
   */
  memoryCutoffChapter?: number | undefined;
}

/** Optional manuscript evidence attached to a canon repair request. */
export interface CanonEvidence {
  /** Writer-readable manuscript/draft containing the quoted evidence. */
  docId: string;
  /** Exact excerpt carried from a conflict finding. */
  textQuote: string;
}

/** Durable section identity for a canon repair thread. */
export interface CanonThreadTarget {
  /** Exact H2/H3 ancestry, from outer heading to the target heading. */
  headingPath: string[];
  /** Omitted for a manual repair launched directly from the canon sidebar. */
  evidence?: CanonEvidence | null | undefined;
}

export interface Thread {
  id: string;
  projectId: string;
  docId: string;
  kind: ThreadKind;
  anchor: Anchor | null;
  /** Present only on `chat` threads. */
  persona?: ChatPersona | null | undefined;
  /** Marks a specialized thread lifecycle. */
  origin?: 'generate' | 'check' | 'canon' | null | undefined;
  /** Present only when origin=`canon`; the anchor remains the write boundary. */
  canon?: CanonThreadTarget | null | undefined;
  /** Agent currently selected for this thread (switchable per message). */
  agentId: AgentId;
  /** AI profile governing context injection for this thread. */
  profile: 'writer' | 'planner';
  title: string;
  status: 'open' | 'resolved';
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  /** Which agent produced an assistant message. */
  agentId: AgentId | null;
  content: string;
  /** Parsed structured payload for a rewrite/check run; null for ordinary messages or invalid output. */
  structured: import('./agent.js').RewriteResponse | import('./agent.js').ConflictCheckResponse | null;
  createdAt: number;
}

// ---------- Revisions ----------

export type RevisionKind = 'ai_original' | 'user_edit' | 'manual_snapshot';

export interface Revision {
  id: string;
  /** Owning project; global revision ids must still be authorized against this value. */
  projectId: string;
  docId: string;
  kind: RevisionKind;
  sha256: string;
  /** Thread that produced this snapshot, if any. */
  sourceThreadId: string | null;
  label: string | null;
  createdAt: number;
}

/** Revision with full content (single-revision fetch only). */
export interface RevisionWithContent extends Revision {
  content: string;
}

// ---------- Deterministic lint ----------

export type LintCategory = 'style' | 'sensitive';
export type LintSeverity = 'info' | 'warning' | 'error';

export interface LintFinding {
  ruleId: string;
  category: LintCategory;
  message: string;
  /** JavaScript UTF-16 offset, aligned with CodeMirror document positions. */
  offset: number;
  length: number;
  severity: LintSeverity;
}

export interface LintResponse {
  docId: string;
  sha256: string;
  findings: LintFinding[];
}

// ---------- Revision provenance ----------

export interface ProvenanceRevision {
  revisionId: string;
  kind: RevisionKind;
  createdAt: number;
  wordCount: number;
  addedChars: number;
  deletedChars: number;
}

export interface ProvenanceSummary {
  aiDraftWordCount: number;
  authorChangedChars: number;
  revisionCount: number;
  /** Milliseconds between the first and last revision; zero for fewer than two. */
  timeSpanMs: number;
}

export interface ProvenanceResponse {
  docId: string;
  title: string;
  summary: ProvenanceSummary;
  revisions: ProvenanceRevision[];
}

// ---------- Git ----------

export interface GitStatus {
  branch: string;
  dirty: Array<{ path: string; status: string }>;
}
