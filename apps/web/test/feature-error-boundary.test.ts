import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, lazy, Suspense } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FeatureErrorBoundary } from '../src/components/FeatureErrorBoundary.js';

test('feature errors stay local and expose retry/close actions', () => {
  const boundary = new FeatureErrorBoundary({
    featureName: '关系图',
    onRetry: () => undefined,
    onClose: () => undefined,
    closeLabel: '关闭关系图',
    children: createElement('span', null, '编辑器仍在这里'),
  });
  boundary.state = { failed: true };

  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /role="alert"/);
  assert.match(html, /关系图加载失败/);
  assert.match(html, />重试<\/button>/);
  assert.match(html, />关闭关系图<\/button>/);
  assert.doesNotMatch(html, /编辑器仍在这里/);
});

test('healthy feature renders its children unchanged', () => {
  const boundary = new FeatureErrorBoundary({
    featureName: '版本历史',
    children: createElement('span', null, '版本内容'),
  });

  assert.equal(renderToStaticMarkup(boundary.render()), '<span>版本内容</span>');
  assert.deepEqual(FeatureErrorBoundary.getDerivedStateFromError(new Error('chunk rejected')), {
    failed: true,
  });
});

test('rejected lazy content can stay as a caller-owned plain-text pre', () => {
  const original = '**原始消息**\n<script>alert(1)</script>';
  const RejectedMarkdown = lazy(async () => {
    throw new Error('markdown chunk rejected');
  });
  const fallback = createElement('pre', { className: 'message-plain' }, original);
  const boundary = new FeatureErrorBoundary({
    featureName: '消息 Markdown',
    fallback,
    children: createElement(
      Suspense,
      { fallback },
      createElement(RejectedMarkdown, { markdown: original }),
    ),
  });

  // Error boundaries are client-side recovery; model the state React derives
  // after the lazy promise rejects, then verify only the message fallback is
  // rendered and the text remains escaped by React.
  boundary.state = FeatureErrorBoundary.getDerivedStateFromError(
    new Error('markdown chunk rejected'),
  );
  const html = renderToStaticMarkup(boundary.render());
  assert.equal(html, '<pre class="message-plain">**原始消息**\n&lt;script&gt;alert(1)&lt;/script&gt;</pre>');
});
