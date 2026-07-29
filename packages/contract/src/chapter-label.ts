// This import must stay type-only: the contract test script runs under
// Node's native type stripping (no tsx), which cannot resolve a runtime
// import of './models.js' from this zero-dependency leaf module.
import type { NumberStyle } from './models.js';

const CN_RENDER_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;
const CN_SMALL_UNITS = ['', '十', '百', '千'] as const;
const CN_SECTION_UNITS = ['', '万', '亿'] as const;

const DEFAULT_TITLE_TEMPLATE = '第{num}章 {title}';

function renderCnSection(section: number): string {
  let value = section;
  let output = '';
  let pendingZero = false;
  for (let position = 3; position >= 0; position -= 1) {
    const unitValue = 10 ** position;
    const digit = Math.floor(value / unitValue);
    value %= unitValue;
    if (digit === 0) {
      if (output && value > 0) pendingZero = true;
      continue;
    }
    if (pendingZero) output += '零';
    pendingZero = false;
    output += `${CN_RENDER_DIGITS[digit]}${CN_SMALL_UNITS[position]}`;
  }
  return output;
}

function renderCnNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000_000_000) {
    throw new RangeError('Chinese number must be a non-negative safe integer below one trillion');
  }
  if (value === 0) return '零';
  const sections: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    sections.push(remaining % 10_000);
    remaining = Math.floor(remaining / 10_000);
  }
  let output = '';
  let bridgeZero = false;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index] ?? 0;
    if (section === 0) {
      if (output) bridgeZero = true;
      continue;
    }
    if (output && (bridgeZero || section < 1_000)) output += '零';
    output += `${renderCnSection(section)}${CN_SECTION_UNITS[index] ?? ''}`;
    bridgeZero = false;
  }
  return output.startsWith('一十') ? output.slice(1) : output;
}

export function renderNumber(value: number, style: NumberStyle): string {
  return style === 'arabic' ? String(value) : renderCnNumber(value);
}

function replaceTitleTemplate(
  template: string | null | undefined,
  values: { num: string; numCn: string; title: string },
): string {
  return (template ?? DEFAULT_TITLE_TEMPLATE)
    .replaceAll('{num}', () => values.num)
    .replaceAll('{numCn}', () => values.numCn)
    .replaceAll('{title}', () => values.title);
}

export function renderTitleTemplate(
  template: string | null | undefined,
  chapterNo: number,
  title: string,
  numberStyle: NumberStyle,
): string {
  return replaceTitleTemplate(template, {
    num: renderNumber(chapterNo, numberStyle),
    numCn: renderCnNumber(chapterNo),
    title,
  });
}

export function renderTitleTemplateExample(template: string | null | undefined): string {
  return replaceTitleTemplate(template, { num: 'X', numCn: 'X', title: '标题' });
}
