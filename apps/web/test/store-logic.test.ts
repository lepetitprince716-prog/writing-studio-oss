import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialPaneState,
  LatestRequestGate,
  togglePane,
  transitionViewport,
} from '../src/store-logic.js';
import { deferred } from './support.js';

test('the shared sidebar request gate keeps the newest successful planner payload', async () => {
  const gate = new LatestRequestGate();
  const applied: string[] = [];
  const slow = deferred<string>();
  const fast = deferred<string>();

  const slowToken = gate.begin();
  const slowRun = slow.promise.then((value) => {
    if (gate.accept(slowToken)) applied.push(value);
  });
  const fastToken = gate.begin();
  const fastRun = fast.promise.then((value) => {
    if (gate.accept(fastToken)) applied.push(value);
  });

  fast.resolve('fresh');
  await fastRun;
  slow.resolve('stale');
  await slowRun;
  assert.deepEqual(applied, ['fresh']);

  const retryGate = new LatestRequestGate();
  const older = retryGate.begin();
  retryGate.begin(); // A newer request starts but never produces a usable result.
  assert.equal(retryGate.accept(older), true);
});

test('isSuperseded reports staleness without blocking an in-flight older success', () => {
  const gate = new LatestRequestGate();
  const older = gate.begin();
  const newer = gate.begin();

  // Probing must not mutate: an older success can still land afterwards.
  assert.equal(gate.isSuperseded(older), false);
  assert.equal(gate.accept(older), true);

  assert.equal(gate.accept(newer), true);
  assert.equal(gate.isSuperseded(older), true);
  assert.equal(gate.isSuperseded(newer), true);
  assert.equal(gate.isSuperseded(gate.begin()), false);
});

test('desktop to narrow to desktop closes overlays, keeps one drawer, and restores preferences', () => {
  const desktop = {
    isNarrow: false,
    leftCollapsed: false,
    rightCollapsed: false,
  };
  const narrow = transitionViewport(desktop, true, {
    leftCollapsed: false,
    rightCollapsed: true,
  });
  assert.deepEqual(narrow, {
    isNarrow: true,
    leftCollapsed: true,
    rightCollapsed: true,
  });

  const leftOpen = togglePane(narrow!, 'left');
  assert.deepEqual(leftOpen, { leftCollapsed: false, rightCollapsed: true });
  const rightOpen = togglePane({ ...narrow!, ...leftOpen }, 'right');
  assert.deepEqual(rightOpen, { leftCollapsed: true, rightCollapsed: false });

  assert.deepEqual(
    transitionViewport({ ...narrow!, ...rightOpen }, false, {
      leftCollapsed: false,
      rightCollapsed: true,
    }),
    { isNarrow: false, leftCollapsed: false, rightCollapsed: true },
  );
  assert.equal(
    transitionViewport(
      { isNarrow: false, leftCollapsed: false, rightCollapsed: true },
      false,
      { leftCollapsed: true, rightCollapsed: true },
    ),
    null,
  );
});

test('a narrow first load closes both drawers even when desktop preferences expand them', () => {
  assert.deepEqual(
    initialPaneState(true, { leftCollapsed: false, rightCollapsed: false }),
    { isNarrow: true, leftCollapsed: true, rightCollapsed: true },
  );
  assert.deepEqual(
    initialPaneState(false, { leftCollapsed: false, rightCollapsed: true }),
    { isNarrow: false, leftCollapsed: false, rightCollapsed: true },
  );
});
