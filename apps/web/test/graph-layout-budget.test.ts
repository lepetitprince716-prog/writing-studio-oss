// This wall-clock benchmark needs exclusive CPU, so shared test runs register an
// explicit opt-in skip instead of treating scheduler contention as a regression.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { forceCenter, forceLink, forceManyBody, forceSimulation } from 'd3-force-3d';
import type { ForceNode, LinkDatum } from 'd3-force-3d';

const performanceSkipReason = process.env['WRITING_STUDIO_PERF'] === '1'
  ? false
  : '性能基准需独占 CPU，设 WRITING_STUDIO_PERF=1 启用';

interface BenchmarkNode extends ForceNode {
  id: string;
}

interface BenchmarkLink extends LinkDatum<BenchmarkNode> {}

interface TrialResult {
  p95: number;
  elapsed: number;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function runTrial(): TrialResult {
  const nodes: BenchmarkNode[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `node:${index.toString().padStart(4, '0')}`,
  }));
  const links: BenchmarkLink[] = Array.from({ length: 3_000 }, (_, index) => ({
    source: nodes[index % nodes.length]!.id,
    target: nodes[(index * 37 + 17) % nodes.length]!.id,
  }));
  const simulation = forceSimulation(nodes, 3)
    .alpha(0.9)
    .alphaMin(0.01)
    .velocityDecay(0.38)
    .force('center', forceCenter<BenchmarkNode>(0, 0, 0).strength(0.75))
    .force('charge', forceManyBody<BenchmarkNode>().strength(-70))
    .force(
      'link',
      forceLink<BenchmarkNode, BenchmarkLink>(links)
        .id((node) => node.id)
        .distance(48)
        .strength(0.62),
    )
    .stop();

  const startedAt = performance.now();
  const tickDurations: number[] = [];
  while (simulation.alpha() >= simulation.alphaMin()) {
    const tickStartedAt = performance.now();
    simulation.tick();
    tickDurations.push(performance.now() - tickStartedAt);
  }
  const elapsed = performance.now() - startedAt;
  return { p95: percentile(tickDurations, 0.95), elapsed };
}

test('1000/3000 force layout stays within the accepted local rendering budget', { skip: performanceSkipReason }, () => {
  // Let V8 optimize the hot D3 path before measuring. Three independent trials
  // then use the median so a scheduler pause cannot turn one noisy tick into a
  // false regression while the 8ms product budget remains unchanged.
  runTrial();
  const trials = [runTrial(), runTrial(), runTrial()];
  const p95 = percentile(trials.map((trial) => trial.p95), 0.5);
  const elapsed = percentile(trials.map((trial) => trial.elapsed), 0.5);
  assert.ok(p95 <= 8, `layout tick p95 ${p95.toFixed(2)}ms exceeds 8ms`);
  assert.ok(elapsed <= 4_000, `layout settled in ${elapsed.toFixed(0)}ms, exceeding 4s`);
});
