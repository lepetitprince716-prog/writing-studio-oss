import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SafeMarkdown } from '../src/components/SafeMarkdown.js';

function render(markdown: string): string {
  return renderToStaticMarkup(createElement(SafeMarkdown, { markdown }));
}

test('plain Markdown renders headings, inline text, quotes, tables, and code', () => {
  const html = render([
    '# 标题',
    '',
    '正文含 **重点** 与 `代码`。',
    '',
    '> 引用',
    '',
    '| 名称 | 状态 |',
    '| --- | --- |',
    '| 角色A | 已定 |',
    '',
    '```ts',
    'const safe = true;',
    '```',
  ].join('\n'));

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /class="md-table-wrap"/);
  assert.match(html, /<code class="language-ts">const safe = true;<\/code>/);
});

test('raw HTML, active links, and remote images stay inert', () => {
  const html = render([
    '<img src=x onerror="alert(1)">',
    '',
    '[危险链接](javascript:alert(1))',
    '',
    '![远程图片](https://example.com/tracker.png)',
  ].join('\n'));

  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /［图片：远程图片］/);
});

test('safe links retain navigation metadata', () => {
  const html = render('[文档](./notes) [官网](https://example.com)');

  assert.match(html, /href="\.\/notes"/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test('GFM task items render exactly one inert checkbox', () => {
  const html = render('- [x] 已完成');

  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(html, /checked=""/);
  assert.match(html, /aria-label="已完成"/);
});
