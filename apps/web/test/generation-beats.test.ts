import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBeatPrompt,
  buildBeatRewritePrompt,
  composeBeatTexts,
  parseOutlineBeats,
} from '../src/lib/generation-beats.js';

test('outline beats split only on standalone separators and ignore empty boundary segments', () => {
  assert.deepEqual(parseOutlineBeats('第一拍\n---\n第二拍'), {
    beats: ['第一拍', '第二拍'],
    gated: true,
  });
  assert.deepEqual(parseOutlineBeats('  ---  \n第一拍\n---\n---\n第二拍\n\t---\t'), {
    beats: ['第一拍', '第二拍'],
    gated: true,
  });
  assert.deepEqual(parseOutlineBeats('---\n---'), { beats: [], gated: true });
  assert.deepEqual(parseOutlineBeats('正文里的 --- 不是独行'), {
    beats: ['正文里的 --- 不是独行'],
    gated: false,
  });
});

test('outline without a stop preserves the exact legacy request bytes', () => {
  const outline = '  第一幕\r\n第二幕  \n';
  assert.deepEqual(parseOutlineBeats(outline), { beats: [outline], gated: false });
});

test('beat prompts follow first, continuation, and rewrite protocols', () => {
  assert.equal(
    buildBeatPrompt('相遇', 0),
    '【本拍章纲】\n相遇\n\n【写作要求】只写到本拍情节结束即停笔，不要预写后续拍。',
  );
  assert.equal(
    buildBeatPrompt('交锋', 1),
    '【前文已定稿，从此处继续】\n\n【本拍章纲】\n交锋\n\n【写作要求】紧接前文续写，只完成本拍，不要重复前文，不要预写后续拍。',
  );
  assert.equal(
    buildBeatRewritePrompt('交锋', 1, '  对话更克制  '),
    '【作者意见】\n对话更克制\n\n【前文已定稿，从此处继续】\n\n【本拍章纲】\n交锋\n\n【写作要求】紧接前文续写，只完成本拍，不要重复前文，不要预写后续拍。',
  );
});

test('completed beat text composes with one blank line and preserves beat bytes', () => {
  assert.equal(composeBeatTexts(['第一拍\n末句', '第二拍', '第三拍']), '第一拍\n末句\n\n第二拍\n\n第三拍');
});
