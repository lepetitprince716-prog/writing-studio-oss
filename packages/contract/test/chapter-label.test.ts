import assert from 'node:assert/strict';
import test from 'node:test';
import {
  renderNumber,
  renderTitleTemplate,
  renderTitleTemplateExample,
} from '@writing-studio/contract/chapter-label';

test('chapter-label subpath renders configured and default templates literally', () => {
  assert.equal(renderNumber(12, 'arabic'), '12');
  assert.equal(renderNumber(12, 'cnLower'), '十二');
  assert.equal(
    renderTitleTemplate('Chapter {num} {title}', 12, "Opening $& $' $` $1$2 $$", 'arabic'),
    "Chapter 12 Opening $& $' $` $1$2 $$",
  );
  assert.equal(renderTitleTemplateExample('Chapter {num}: {title}'), 'Chapter X: 标题');
});

test('default title template follows the configured number style', () => {
  assert.equal(renderTitleTemplate(undefined, 12, '章节标题A', 'arabic'), '第12章 章节标题A');
  assert.equal(renderTitleTemplate(undefined, 12, '章节标题A', 'cnLower'), '第十二章 章节标题A');
});

test('chapter-label rejects numbers outside the established Chinese renderer range', () => {
  assert.throws(
    () => renderTitleTemplate(undefined, Number.MAX_SAFE_INTEGER, '越界', 'arabic'),
    RangeError,
  );
});
