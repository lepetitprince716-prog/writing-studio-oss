import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { posix, relative, sep } from 'node:path';
import {
  vaultRelativePathSchema,
  type CharacterCard,
  type ChatPersona,
  type ContextManifest,
  type Project,
  type PromptBundle,
  type SidebarPayload,
  type Thread,
  type VaultReadPolicy,
} from '@writing-studio/contract';
import { resolveAnchor } from './anchors.js';
import { StudioError } from './errors.js';
import { SidebarService } from './sidebar/index.js';
import { listChapterDocumentRefs } from './tree.js';
import { readDocument, resolveDocPath } from './vault.js';
import { matchedAliases, writerAliasEntries } from './mentions.js';
import { resolveWriterVisibleCanonSection } from './canon.js';
import { parseCnNumber, renderTitleTemplateExample } from './content-pattern.js';
import { resolvePromptBundle } from './prompts/index.js';

export const MAX_CONTEXT_CHARS = 36_000;
const MAX_DOCUMENT_EXCERPT = 16_000;
const MAX_ENCODED_DOCUMENT_CHARS = 20_000;
const PREVIOUS_CHAPTER_TAIL_CHARS = 2_000;

interface ContextSourceBlock {
  path: string;
  content: string;
  sourceId: string;
  trigger: 'always' | 'mention';
}

export interface ResolvedChatPersona {
  persona: ChatPersona;
  sourceId: string;
  card: CharacterCard;
}

const CHAPTER_REFERENCE_RE = /第\s*([0-9一二三四五六七八九十百千万亿零]+)\s*章/gu;

function referencedChapters(value: string): number[] {
  return [...value.matchAll(CHAPTER_REFERENCE_RE)].flatMap((match) => {
    const chapter = parseCnNumber(match[1]!);
    return chapter === null ? [] : [chapter];
  });
}

function hasChapterAfter(value: string, cutoff: number): boolean {
  return referencedChapters(value).some((chapter) => chapter > cutoff);
}

function filterPersonaCardByChapter(
  card: CharacterCard,
  cutoff: number,
): CharacterCard {
  return {
    ...card,
    sections: card.sections.filter((section) =>
      !hasChapterAfter(`${section.heading}\n${section.body}`, cutoff)),
  };
}

function filterWritingStatusByChapter(
  payload: Extract<SidebarPayload, { kind: 'writingStatus' }>,
  cutoff: number,
): Extract<SidebarPayload, { kind: 'writingStatus' }> {
  const snapshotIsLater = payload.data.stopChapter !== null
    && payload.data.stopChapter > cutoff;
  const keepProgress = (value: string): boolean => {
    const chapters = referencedChapters(value);
    return !hasChapterAfter(value, cutoff) && (!snapshotIsLater || chapters.length > 0);
  };
  return {
    ...payload,
    data: {
      ...payload.data,
      stopChapter:
        payload.data.stopChapter !== null && payload.data.stopChapter <= cutoff
          ? payload.data.stopChapter
          : null,
      stopPoint: keepProgress(payload.data.stopPoint) ? payload.data.stopPoint : '',
      storylines: payload.data.storylines.filter((item) =>
        keepProgress(`${item.name}\n${item.body}`)),
      activeForeshadow: payload.data.activeForeshadow.filter((item) =>
        keepProgress(`${item.id}\n${item.content}\n${item.status}`)),
      characterOneLiners: payload.data.characterOneLiners.filter((item) =>
        keepProgress(`${item.name}\n${item.text}`)),
      redLines: payload.data.redLines.filter((line) => !hasChapterAfter(line, cutoff)),
      expressionBaseline: hasChapterAfter(payload.data.expressionBaseline, cutoff)
        ? ''
        : payload.data.expressionBaseline,
    },
  };
}

function globPattern(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
        continue;
      }
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'su');
}

function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(path));
}

function policyFold(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US');
}

type CanonicalDocIdResult =
  | { state: 'existing'; docId: string }
  | { state: 'missing' }
  | { state: 'unsafe' };

function canonicalExistingDocId(project: Project, docId: string): CanonicalDocIdResult {
  try {
    const path = resolveDocPath(project.vaultRoot, docId);
    if (!existsSync(path)) return { state: 'missing' };
    const canonical = relative(
      realpathSync.native(project.vaultRoot),
      realpathSync.native(path),
    ).split(sep).join('/');
    return vaultRelativePathSchema.safeParse(canonical).success
      ? { state: 'existing', docId: canonical }
      : { state: 'unsafe' };
  } catch {
    return { state: 'unsafe' };
  }
}

function containsGlob(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

function existingPolicyDocId(project: Project, pattern: string): string | null {
  const resolved = canonicalExistingDocId(project, pattern);
  return resolved.state === 'existing' ? resolved.docId : null;
}

function matchesReadable(project: Project, path: string, patterns: string[]): boolean {
  if (matchesAny(path, patterns)) return true;
  return patterns.some((pattern) =>
    !containsGlob(pattern) && existingPolicyDocId(project, pattern) === path);
}

function matchesForbidden(project: Project, path: string, patterns: string[]): boolean {
  if (matchesAny(path, patterns)) return true;
  const foldedPath = policyFold(path);
  if (patterns.some((pattern) => globPattern(policyFold(pattern)).test(foldedPath))) {
    return true;
  }
  return patterns.some((pattern) =>
    !containsGlob(pattern) && existingPolicyDocId(project, pattern) === path);
}

/**
 * Read-only excerpts use the profile's vault policy without the additional
 * "may be the raw thread document" restriction applied to writer threads.
 * This keeps source navigation fail-closed while allowing a configured canon
 * file to be returned as a bounded excerpt instead of full agent context.
 */
export function isProfileReadablePath(
  project: Project,
  profileName: Thread['profile'],
  docId: string,
): boolean {
  if (!vaultRelativePathSchema.safeParse(docId).success) return false;
  const profile = project.config.aiProfiles[profileName];
  const resolved = canonicalExistingDocId(project, docId);
  if (resolved.state === 'unsafe') return false;
  const canonicalDocId = resolved.state === 'existing' ? resolved.docId : docId;
  return (
    matchesReadable(project, canonicalDocId, profile.readable)
    && !matchesForbidden(project, canonicalDocId, profile.forbidden)
  );
}

/**
 * A writer thread may only be attached to a manuscript or draft Markdown
 * document. Sidebar/canon files can be readable as contextual excerpts, but
 * must never become the raw current document whose full text is injected.
 */
export function isWriterThreadDocumentAllowed(project: Project, docId: string): boolean {
  if (!docId.endsWith('.md')) return false;
  const below = (directory: string): boolean => docId.startsWith(`${directory}/`);
  return below(project.config.contentTree.root) || below(project.config.draftsDir);
}

export function isProfilePathAllowed(
  project: Project,
  profileName: Thread['profile'],
  docId: string,
): boolean {
  return (
    (profileName !== 'writer' || isWriterThreadDocumentAllowed(project, docId))
    && isProfileReadablePath(project, profileName, docId)
  );
}

function charactersSourceForDoc(project: Project, docId: string) {
  return project.config.sidebarSources.filter((source) =>
    source.file === docId
    && source.parser === 'heading-sections'
    && source.parserConfig.kind === 'characters');
}

/**
 * Resolve a roleplay persona only from the writer projection. The raw
 * character Markdown and planner payload never cross this boundary.
 */
export function resolveChatPersona(
  project: Project,
  sidebars: SidebarService,
  docId: string,
  persona: ChatPersona,
): ResolvedChatPersona {
  const sources = charactersSourceForDoc(project, docId);
  const matches: ResolvedChatPersona[] = [];
  for (const source of sources) {
    let payload: SidebarPayload | undefined;
    try {
      payload = sidebars.getSource(project, source.id, 'writer');
    } catch {
      throw new StudioError('VALIDATION', 'chat persona is unavailable');
    }
    if (
      !payload
      || payload.parser !== 'heading-sections'
      || payload.kind !== 'characters'
    ) continue;
    for (const card of payload.data) {
      if (card.name === persona.characterName) {
        matches.push({
          persona: {
            characterName: card.name,
            ...(persona.memoryCutoffChapter === undefined
              ? {}
              : { memoryCutoffChapter: persona.memoryCutoffChapter }),
          },
          sourceId: source.id,
          card,
        });
      }
    }
  }
  if (matches.length !== 1) {
    // One generic error prevents the API from becoming an oracle for
    // author-only, missing, or duplicate character cards.
    throw new StudioError('VALIDATION', 'chat persona is unavailable');
  }
  return matches[0]!;
}

function serializeContext(profile: Thread['profile'], sources: ContextSourceBlock[]): string {
  // Manifest metadata is diagnostic-only. Preserve the model-facing
  // payload byte-for-byte when every source uses the default `always` policy.
  return JSON.stringify({
    type: 'thread-context',
    profile,
    sources: sources.map(({ path, content }) => ({ path, content })),
  });
}

/**
 * Fit one source by measuring the final serialized context, not its raw text.
 * JSON escaping can expand quotes, slashes and control characters, so raw
 * string lengths are not a safe proxy for the process input budget.
 */
function fitSourceContent(
  profile: Thread['profile'],
  sources: ContextSourceBlock[],
  sourceIndex: number,
  fullContent: string,
  maxSerializedLength: number,
): { originalChars: number; injectedChars: number; truncated: boolean } {
  sources[sourceIndex]!.content = fullContent;
  if (serializeContext(profile, sources).length <= maxSerializedLength) {
    return { originalChars: fullContent.length, injectedChars: fullContent.length, truncated: false };
  }

  const marker = '\n[truncated]';
  let low = 0;
  let high = fullContent.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    sources[sourceIndex]!.content = `${fullContent.slice(0, middle)}${marker}`;
    if (serializeContext(profile, sources).length <= maxSerializedLength) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  sources[sourceIndex]!.content = low > 0 ? `${fullContent.slice(0, low)}${marker}` : '';
  return {
    originalChars: fullContent.length,
    injectedChars: sources[sourceIndex]!.content.length,
    truncated: true,
  };
}

function isWholeDocumentRewrite(thread: Thread): boolean {
  return thread.kind === 'rewrite' && thread.anchor === null;
}

function previousChapterSource(project: Project, thread: Thread): ContextSourceBlock | null {
  if (thread.profile !== 'writer') {
    throw new StudioError('VALIDATION', 'chapter generation requires the writer profile');
  }
  const chapters = listChapterDocumentRefs(project.vaultRoot, project.config);
  const current = chapters.find((chapter) => chapter.docId === thread.docId);
  if (!current?.chapterNo || current.chapterNo <= 1) return null;
  const candidates = chapters.filter((chapter) =>
    chapter.chapterNo === current.chapterNo! - 1
    && (
      project.config.contentTree.leaf.numberingScope === 'book'
      || posix.dirname(chapter.docId) === posix.dirname(current.docId)
    ));
  if (candidates.length !== 1) return null;
  const previous = candidates[0]!;
  if (!isProfileReadablePath(project, 'writer', previous.docId)) return null;
  const content = readDocument(project.vaultRoot, project.config, previous.docId).content;
  return {
    path: `previous-chapter:${previous.docId}`,
    content: content.slice(-PREVIOUS_CHAPTER_TAIL_CHARS),
    sourceId: `previous-chapter:${previous.docId}`,
    trigger: 'always',
  };
}

function documentExcerpt(
  thread: Thread,
  content: string,
  prompts: PromptBundle,
): string {
  if (!thread.anchor) return content.slice(0, MAX_DOCUMENT_EXCERPT);
  const resolution = resolveAnchor(thread.anchor, content);
  if (resolution.status === 'lost') {
    return `${prompts.lostSelectionNotice}\n${thread.anchor.exact}`;
  }
  const radius = Math.max(1_500, Math.floor((MAX_DOCUMENT_EXCERPT - (resolution.end - resolution.start)) / 2));
  const start = Math.max(0, resolution.start - radius);
  const end = Math.min(content.length, resolution.end + radius);
  return [
    content.slice(start, resolution.start),
    '<selected-text>',
    content.slice(resolution.start, resolution.end),
    '</selected-text>',
    content.slice(resolution.end, end),
  ].join('');
}

export interface BuiltThreadContext {
  contextBlock: string;
  allowVaultBrowsing: boolean;
  vaultReadPolicy: VaultReadPolicy | null;
  systemPrompt: string;
  manifest: ContextManifest;
}

function manifestEntry(
  source: ContextSourceBlock,
  quotaChars: number,
  result: ReturnType<typeof fitSourceContent>,
): ContextManifest[number] {
  return {
    sourceId: source.sourceId,
    originalChars: result.originalChars,
    injectedChars: result.injectedChars,
    truncated: result.truncated,
    quotaChars,
    trigger: source.trigger,
  };
}

function matchingCharacterOneLiner(
  payload: Extract<SidebarPayload, { kind: 'writingStatus' }>,
  characterName: string,
) {
  const shortName = characterName.replace(/[（(].*$/u, '').trim();
  const matches = payload.data.characterOneLiners.filter((item) =>
    item.name === characterName || item.name === shortName);
  return matches.length === 1 ? matches[0] : null;
}

/** Keep mention payloads narrowly scoped to the writer-safe matched entries. */
function filterPayloadForMentions(
  payload: SidebarPayload,
  selected: Map<string, Set<string>>,
): SidebarPayload | null {
  if (payload.parser === 'markdown-table') {
    const entries = payload.entries.filter((entry) => selected.has(entry.term));
    return entries.length > 0 ? { ...payload, entries } : null;
  }
  if (payload.parser === 'heading-sections' && payload.kind === 'characters') {
    const data = payload.data.flatMap((card) => {
      const headings = selected.get(card.name);
      if (!headings) return [];
      const sections = card.sections.filter((section) => headings.has(section.heading));
      return sections.length > 0 ? [{ ...card, sections }] : [];
    });
    return data.length > 0 ? { ...payload, data } : null;
  }
  if (payload.parser === 'heading-sections' && payload.kind === 'foreshadowing') {
    const data = payload.data.filter((entry) => selected.has(entry.title));
    return data.length > 0 ? { ...payload, data } : null;
  }
  return null;
}

function withoutWriterSectionAnchors(payload: SidebarPayload): SidebarPayload {
  const { writerSections: _writerSections, ...contextPayload } = payload;
  return contextPayload as SidebarPayload;
}

function buildChatThreadContext(
  project: Project,
  thread: Thread,
  prompts: PromptBundle,
): BuiltThreadContext {
  if (thread.profile !== 'writer' || !thread.persona) {
    throw new StudioError('VALIDATION', 'chat thread has no writer-safe persona');
  }
  const sidebars = new SidebarService();
  const resolved = resolveChatPersona(
    project,
    sidebars,
    thread.docId,
    thread.persona,
  );
  const cutoff = resolved.persona.memoryCutoffChapter;
  const personaCard = cutoff === undefined
    ? resolved.card
    : filterPersonaCardByChapter(resolved.card, cutoff);
  const sourceContents: ContextSourceBlock[] = [{
    path: `persona:${resolved.sourceId}`,
    content: JSON.stringify(personaCard),
    sourceId: `persona:${resolved.sourceId}`,
    trigger: 'always',
  }];

  for (const sourceId of project.config.aiProfiles.writer.contextSources ?? []) {
    const source = project.config.sidebarSources.find((candidate) => candidate.id === sourceId);
    if (
      !source
      || source.parser !== 'heading-sections'
      || source.parserConfig.kind !== 'writingStatus'
    ) continue;
    if (!isProfileReadablePath(project, 'writer', source.file)) {
      throw new StudioError(
        'VALIDATION',
        `configured writer context source is not readable: ${sourceId}`,
      );
    }
    const rawPayload = sidebars.getSource(project, sourceId, 'writer');
    if (
      !rawPayload
      || rawPayload.parser !== 'heading-sections'
      || rawPayload.kind !== 'writingStatus'
    ) continue;
    const payload = cutoff === undefined
      ? rawPayload
      : filterWritingStatusByChapter(rawPayload, cutoff);
    sourceContents.push({
      path: `sidebar:${sourceId}`,
      content: JSON.stringify({
        stopChapter: payload.data.stopChapter,
        stopPoint: payload.data.stopPoint,
        characterOneLiner: matchingCharacterOneLiner(
          payload,
          resolved.persona.characterName,
        ),
      }),
      sourceId: `sidebar:${sourceId}`,
      trigger: 'always',
    });
  }

  const sources = sourceContents.map((source) => ({ ...source, content: '' }));
  if (serializeContext('writer', sources).length > MAX_CONTEXT_CHARS) {
    throw new StudioError('VALIDATION', 'configured chat context metadata exceeds the context budget');
  }
  const manifest: ContextManifest = [];
  sourceContents.forEach((source, index) => {
    const currentLength = serializeContext('writer', sources).length;
    const remaining = sourceContents.length - index;
    const fairTarget = currentLength
      + Math.floor((MAX_CONTEXT_CHARS - currentLength) / remaining);
    const quotaChars = Math.max(0, fairTarget - currentLength);
    manifest.push(manifestEntry(
      source,
      quotaChars,
      fitSourceContent('writer', sources, index, source.content, fairTarget),
    ));
  });

  return {
    contextBlock: serializeContext('writer', sources),
    allowVaultBrowsing: false,
    vaultReadPolicy: null,
    systemPrompt: [
      prompts.chatPersonaSystemIntro,
      prompts.chatPersonaContextBoundary,
      prompts.contextSourceSafety,
      prompts.chatPersonaCanonBoundary,
      prompts.chatPersonaAuthorBoundary,
      ...(cutoff === undefined
        ? []
        : [prompts.chatPersonaMemoryCutoff.replaceAll('{cutoff}', () => String(cutoff))]),
    ].join('\n'),
    manifest,
  };
}

/** Build the only context writer-profile CLI processes are allowed to see. */
export function buildThreadContext(
  project: Project,
  thread: Thread,
  documentContent: string,
  userMessage: string,
): BuiltThreadContext {
  const prompts = resolvePromptBundle(project.config);
  if (thread.kind === 'chat') return buildChatThreadContext(project, thread, prompts);
  if (thread.origin === 'canon') {
    if (!thread.canon || !thread.anchor || thread.profile !== 'writer') {
      throw new StudioError('VALIDATION', 'canon repair thread is invalid');
    }
    const sidebars = new SidebarService();
    const currentSha = createHash('sha256').update(documentContent).digest('hex');
    const target = resolveWriterVisibleCanonSection(
      project,
      sidebars,
      thread.docId,
      documentContent,
      currentSha,
      thread.canon.headingPath,
    );
    const resolution = resolveAnchor(thread.anchor, documentContent);
    if (
      resolution.status !== 'exact'
      || documentContent.slice(resolution.start, resolution.end) !== target.anchor.exact
    ) {
      throw new StudioError('STALE_WRITE', 'canon repair section changed; reopen the repair');
    }
    const sources: ContextSourceBlock[] = [{
      path: `canon-section:${thread.docId}#${thread.canon.headingPath.join(' / ')}`,
      content: target.anchor.exact,
      sourceId: `canon-section:${thread.docId}`,
      trigger: 'always',
    }];
    if (thread.canon.evidence) {
      const evidence = readDocument(
        project.vaultRoot,
        project.config,
        thread.canon.evidence.docId,
      );
      if (!evidence.content.includes(thread.canon.evidence.textQuote)) {
        throw new StudioError('VALIDATION', 'canon evidence is unavailable');
      }
      sources.push({
        path: `manuscript-evidence:${thread.canon.evidence.docId}`,
        content: thread.canon.evidence.textQuote,
        sourceId: `evidence:${thread.canon.evidence.docId}`,
        trigger: 'always',
      });
    }
    const contextBlock = serializeContext('writer', sources);
    if (contextBlock.length > MAX_CONTEXT_CHARS) {
      throw new StudioError('VALIDATION', 'canon repair section exceeds the context budget');
    }
    return {
      contextBlock,
      allowVaultBrowsing: false,
      vaultReadPolicy: null,
      systemPrompt: [
        prompts.canonRepairSystemIntro,
        prompts.canonRepairVaultBoundary,
        prompts.canonRepairHeadingRule,
        prompts.canonRepairOutputRule,
      ].join('\n'),
      manifest: sources.map((source) => ({
        sourceId: source.sourceId,
        originalChars: source.content.length,
        injectedChars: source.content.length,
        truncated: false,
        quotaChars: source.content.length,
        trigger: source.trigger,
      })),
    };
  }
  const profile = project.config.aiProfiles[thread.profile];
  if (!isProfilePathAllowed(project, thread.profile, thread.docId)) {
    throw new StudioError(
      'VALIDATION',
      `document is not readable by the ${thread.profile} profile: ${thread.docId}`,
    );
  }
  const sourceContents: ContextSourceBlock[] = [];
  const mentionText = `${documentExcerpt(thread, documentContent, prompts)}\n${userMessage}`;
  const mentions = matchedAliases(
    writerAliasEntries(project),
    mentionText,
    project.config.context?.excludeTerms ?? [],
  );
  const mentionedBySource = new Map<string, Map<string, Set<string>>>();
  for (const mention of mentions) {
    const canonicals = mentionedBySource.get(mention.sourceId) ?? new Map<string, Set<string>>();
    const headings = canonicals.get(mention.canonical) ?? new Set<string>();
    headings.add(mention.sourceHeading);
    canonicals.set(mention.canonical, headings);
    mentionedBySource.set(mention.sourceId, canonicals);
  }

  if (thread.profile === 'writer') {
    const sidebars = new SidebarService();
    for (const sourceId of profile.contextSources ?? []) {
      const source = project.config.sidebarSources.find((candidate) => candidate.id === sourceId);
      if (!source || source.parser === 'plain') continue;
      if (!isProfileReadablePath(project, 'writer', source.file)) {
        throw new StudioError(
          'VALIDATION',
          `configured writer context source is not readable: ${sourceId}`,
        );
      }
      const payload = sidebars.getSource(project, sourceId, 'writer');
      if (!payload) continue;
      const selected = mentionedBySource.get(sourceId) ?? new Map<string, Set<string>>();
      const isCheckStatus = (
        thread.origin === 'check'
        && payload.parser === 'heading-sections'
        && payload.kind === 'writingStatus'
      );
      // Conflict checks need only entities actually present in the chapter,
      // regardless of their ordinary sidebar injection policy. Writing status
      // remains an always-on writer-safe snapshot.
      const trigger = thread.origin === 'check' && !isCheckStatus
        ? 'mention'
        : source.injection ?? 'always';
      if (trigger === 'mention' && selected.size === 0) continue;
      const injectedPayload = trigger === 'mention'
        ? filterPayloadForMentions(payload, selected)
        : payload;
      if (!injectedPayload) continue;
      // Section anchors are an editor capability, not model context. In
      // particular, an unfiltered anchor list could reveal exact text from
      // writer-visible entities that were not selected by mention matching.
      const contextPayload = withoutWriterSectionAnchors(injectedPayload);
      sourceContents.push({
        path: thread.origin === 'check' ? `canon:${source.file}` : `sidebar:${sourceId}`,
        content: JSON.stringify(
          thread.origin === 'check'
            ? { canonSource: { docId: source.file }, payload: contextPayload }
            : contextPayload,
        ),
        sourceId: `sidebar:${sourceId}`,
        trigger,
      });
    }
  }

  if (thread.origin === 'generate') {
    const previous = previousChapterSource(project, thread);
    if (previous) sourceContents.push(previous);
    const sources = sourceContents.map((source) => ({ ...source, content: '' }));
    if (serializeContext('writer', sources).length > MAX_CONTEXT_CHARS) {
      throw new StudioError('VALIDATION', 'configured generation context metadata exceeds the context budget');
    }
    const manifest: ContextManifest = [];
    sourceContents.forEach((source, index) => {
      const currentLength = serializeContext('writer', sources).length;
      const remaining = sourceContents.length - index;
      const fairTarget = currentLength
        + Math.floor((MAX_CONTEXT_CHARS - currentLength) / remaining);
      manifest.push(manifestEntry(
        source,
        Math.max(0, fairTarget - currentLength),
        fitSourceContent('writer', sources, index, source.content, fairTarget),
      ));
    });
    return {
      contextBlock: serializeContext('writer', sources),
      allowVaultBrowsing: false,
      vaultReadPolicy: null,
      systemPrompt: [
        prompts.generationSystemIntro,
        prompts.contextSourceSafety,
        prompts.generationChapterInstruction.replaceAll(
          '{titleExample}',
          () => renderTitleTemplateExample(project.config.contentTree.leaf.titleTemplate),
        ),
        prompts.generationEvidenceRule,
      ].join('\n'),
      manifest,
    };
  }

  const fullSidebarContents = sourceContents.map((source) => source.content);
  const sources: ContextSourceBlock[] = [
    { path: thread.docId, content: '', sourceId: `document:${thread.docId}`, trigger: 'always' },
    ...sourceContents.map((source) => ({ ...source, content: '' })),
  ];
  const emptyLength = serializeContext(thread.profile, sources).length;
  if (emptyLength > MAX_CONTEXT_CHARS) {
    throw new StudioError('VALIDATION', 'configured context source metadata exceeds the context budget');
  }

  if (isWholeDocumentRewrite(thread)) {
    const withFullDocument = serializeContext(thread.profile, [
      {
        path: thread.docId,
        content: documentContent,
        sourceId: `document:${thread.docId}`,
        trigger: 'always',
      },
      ...sourceContents.map((source) => ({ ...source, content: '' })),
    ]);
    if (
      withFullDocument.length > MAX_CONTEXT_CHARS
      || withFullDocument.length - emptyLength > MAX_ENCODED_DOCUMENT_CHARS
    ) {
      throw new StudioError(
        'VALIDATION',
        'whole-document rewrite exceeds the complete context limit; select a passage or shorten the document',
      );
    }
  }

  const fullDocument = isWholeDocumentRewrite(thread)
    ? documentContent
    : documentExcerpt(thread, documentContent, prompts);

  const manifest: ContextManifest = [];
  manifest.push(manifestEntry(
    sources[0]!,
    Math.min(MAX_CONTEXT_CHARS, emptyLength + MAX_ENCODED_DOCUMENT_CHARS) - emptyLength,
    fitSourceContent(
    thread.profile,
    sources,
    0,
    fullDocument,
    Math.min(MAX_CONTEXT_CHARS, emptyLength + MAX_ENCODED_DOCUMENT_CHARS),
    ),
  ));

  // Give every configured writer source an encoded fair share. Short sources
  // return unused capacity to the sources that follow, while no large early
  // source can starve the rest of the configured context.
  for (const [sidebarIndex, fullContent] of fullSidebarContents.entries()) {
    const sourceIndex = sidebarIndex + 1;
    const currentLength = serializeContext(thread.profile, sources).length;
    const remainingSources = fullSidebarContents.length - sidebarIndex;
    const fairTarget = currentLength
      + Math.floor((MAX_CONTEXT_CHARS - currentLength) / remainingSources);
    manifest.push(manifestEntry(
      sources[sourceIndex]!,
      Math.max(0, fairTarget - currentLength),
      fitSourceContent(thread.profile, sources, sourceIndex, fullContent, fairTarget),
    ));
  }

  const contextBlock = serializeContext(thread.profile, sources);
  const systemPrompt = thread.origin === 'check'
    ? [
        prompts.conflictCheckSystemIntro,
        prompts.contextSourceSafety,
        prompts.conflictCheckInstruction,
        prompts.conflictCheckJsonRule,
        prompts.conflictCheckCanonSourceRule,
        prompts.conflictCheckEmptyRule,
      ].join('\n')
    : thread.profile === 'writer'
    ? [
        prompts.writerSystemIntro,
        prompts.contextSourceSafety,
        prompts.writerAnswerRule,
      ].join('\n')
    : [
        prompts.plannerSystemIntro,
        prompts.plannerFactRule,
      ].join('\n');

  return {
    contextBlock,
    allowVaultBrowsing: thread.profile === 'planner' && profile.allowVaultBrowsing,
    vaultReadPolicy: thread.profile === 'planner' && profile.allowVaultBrowsing
      ? { readable: [...profile.readable], forbidden: [...profile.forbidden] }
      : null,
    systemPrompt,
    manifest,
  };
}
