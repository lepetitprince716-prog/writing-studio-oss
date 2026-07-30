import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  STOP_POINT_UNSET_MESSAGE,
  StopPointUnsetNotice,
} from '../src/graph/StopPointUnsetNotice.js';

test('unset stop point renders a planner notice and a writer empty-state return action', () => {
  const planner = renderToStaticMarkup(createElement(StopPointUnsetNotice, {
    view: 'planner',
  }));
  assert.match(planner, /role="status"/);
  assert.match(planner, new RegExp(STOP_POINT_UNSET_MESSAGE));
  assert.doesNotMatch(planner, /返回作者全图/);

  const writer = renderToStaticMarkup(createElement(StopPointUnsetNotice, {
    view: 'writer',
    onReturnToPlanner: () => undefined,
  }));
  assert.match(writer, /graph-unset-empty/);
  // Both branches say the same thing; only the planner one used to say it out
  // loud, so the writer projection silently emptied for anyone not looking.
  assert.match(writer, /role="status"/);
  assert.match(writer, new RegExp(STOP_POINT_UNSET_MESSAGE));
  assert.match(writer, />返回作者全图<\/button>/);
});
