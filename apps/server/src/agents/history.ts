import type { Message, PromptBundle } from '@writing-studio/contract';

const MAX_MESSAGES = 40;
const MAX_TOKENS = 12_000;

function estimateTokens(text: string): number {
  let cjk = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x3400 && codePoint <= 0x4dbf)
      || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    ) cjk += 1;
  }
  // Chinese prose is close to one token per Han character, while Latin text
  // is usually near four UTF-16 code units per token. This intentionally
  // errs on the conservative side for the writing corpus.
  return cjk + Math.ceil(Math.max(0, text.length - cjk) / 4);
}

/** Bounded panel-history replay for a fresh CLI session. */
export function replayHistory(
  history: Message[],
  prompts: PromptBundle,
): { text: string; omitted: number } {
  let kept = history.slice(-MAX_MESSAGES);
  let tokens = kept.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  while (kept.length > 0 && tokens > MAX_TOKENS) {
    const removed = kept.shift();
    if (removed) tokens -= estimateTokens(removed.content);
  }
  const omitted = history.length - kept.length;
  const prefix = omitted > 0
    ? prompts.historyOmittedNotice.replaceAll('{omitted}', () => String(omitted))
    : '';
  return {
    text: prefix + kept.map((message) =>
      `${message.role === 'user' ? prompts.historyUserLabel : prompts.historyAssistantLabel}${message.content}`)
      .join('\n\n'),
    omitted,
  };
}

export function replayLatestCandidate(
  history: Message[],
  prompts: PromptBundle,
): { text: string; omitted: number } {
  let latest: Message | undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'assistant') {
      latest = history[index];
      break;
    }
  }
  if (!latest) return { text: '', omitted: history.length };
  const content = latest.structured && 'rewritten_text' in latest.structured
    ? latest.structured.rewritten_text
    : latest.content;
  return {
    text: `${prompts.historyLatestCandidateLabel}\n${content}`,
    omitted: history.length - 1,
  };
}

export function buildPrompt(input: {
  history: Message[];
  replay: boolean;
  replayMode?: 'bounded' | 'latest-candidate' | undefined;
  contextBlock: string;
  systemPrompt: string | null;
  userMessage: string;
  structured: boolean;
  // Required so a new assembly call site cannot silently drop project overrides.
  prompts: PromptBundle;
}): string {
  const prompts = input.prompts;
  const sections: string[] = [];
  if (input.systemPrompt) sections.push(`${prompts.historySystemLabel}\n${input.systemPrompt}`);
  if (input.contextBlock) sections.push(`${prompts.historyContextLabel}\n${input.contextBlock}`);
  if (input.replay) {
    const history = input.replayMode === 'latest-candidate'
      ? replayLatestCandidate(input.history, prompts)
      : replayHistory(input.history, prompts);
    if (history.text) sections.push(`${prompts.historyConversationLabel}\n${history.text}`);
  }
  sections.push(`${prompts.historyCurrentUserLabel}\n${input.userMessage}`);
  if (input.structured) {
    sections.push(prompts.structuredOutputInstruction);
  }
  return sections.join('\n\n');
}
