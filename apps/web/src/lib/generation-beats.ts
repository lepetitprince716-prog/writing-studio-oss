export interface ParsedOutlineBeats {
  beats: string[];
  gated: boolean;
}

const BEAT_SEPARATOR = /^[\t ]*---[\t ]*$/u;

/**
 * Split only on a standalone Markdown horizontal-rule line. Empty segments
 * created by leading, trailing, or consecutive separators are ignored.
 *
 * With no separator, preserve the input byte-for-byte so the legacy
 * single-turn generation request remains unchanged.
 */
export function parseOutlineBeats(outline: string): ParsedOutlineBeats {
  const lines = outline.split(/\r?\n/u);
  if (!lines.some((line) => BEAT_SEPARATOR.test(line))) {
    return { beats: [outline], gated: false };
  }

  const beats: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const beat = current.join('\n').trim();
    if (beat) beats.push(beat);
    current = [];
  };
  for (const line of lines) {
    if (BEAT_SEPARATOR.test(line)) flush();
    else current.push(line);
  }
  flush();
  return { beats, gated: true };
}

export function buildBeatPrompt(beat: string, beatIndex: number): string {
  if (beatIndex === 0) {
    return `【本拍章纲】\n${beat}\n\n【写作要求】只写到本拍情节结束即停笔，不要预写后续拍。`;
  }
  return `【前文已定稿，从此处继续】\n\n【本拍章纲】\n${beat}\n\n【写作要求】紧接前文续写，只完成本拍，不要重复前文，不要预写后续拍。`;
}

export function buildBeatRewritePrompt(beat: string, beatIndex: number, feedback: string): string {
  return `【作者意见】\n${feedback.trim()}\n\n${buildBeatPrompt(beat, beatIndex)}`;
}

export function composeBeatTexts(beatTexts: string[]): string {
  return beatTexts.join('\n\n');
}
