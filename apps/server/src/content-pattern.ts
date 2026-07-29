import type { NumberStyle } from '@writing-studio/contract';
export {
  renderNumber,
  renderTitleTemplate,
  renderTitleTemplateExample,
} from '@writing-studio/contract/chapter-label';

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** Parses conventional Chinese lowercase numerals (一, 十二, 一百零三, 一万零一...). */
export function parseCnNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
  if (text === '零') return 0;
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const character of text) {
    if (character in CN_DIGITS) {
      digit = CN_DIGITS[character] ?? 0;
    } else if (character === '十' || character === '百' || character === '千') {
      const unit = character === '十' ? 10 : character === '百' ? 100 : 1_000;
      section += (digit ?? 1) * unit;
      digit = null;
    } else if (character === '万' || character === '亿') {
      const unit = character === '万' ? 10_000 : 100_000_000;
      total += (section + (digit ?? 0)) * unit;
      section = 0;
      digit = null;
    } else {
      return null;
    }
  }
  return total + section + (digit ?? 0);
}

export function parseNumber(text: string, style: NumberStyle): number | null {
  return style === 'arabic'
    ? (/^\d+$/.test(text) ? Number.parseInt(text, 10) : null)
    : parseCnNumber(text);
}

/** Converts a configured `{num}`/`{name}` filename pattern into a regex. */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (match) =>
    match === '{' || match === '}' ? match : `\\${match}`,
  );
  const body = escaped
    .replace('{num}', '(?<num>[0-9一二三四五六七八九十百千万亿零]+)')
    .replace('{name}', '(?<name>.+)');
  return new RegExp(`^${body}$`);
}

export function numberFromPattern(
  value: string,
  pattern: string,
  style: NumberStyle,
): number | null {
  const matched = value.match(patternToRegex(pattern));
  const numberText = matched?.groups?.['num'];
  return numberText === undefined ? null : parseNumber(numberText, style);
}
