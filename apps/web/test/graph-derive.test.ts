import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoryPoint, WorldGraphSnapshot } from '@writing-studio/contract';
import {
  currentDocumentSeeds,
  filterGraph,
  localGraph,
  matchingNodes,
  sampleGlobalGraph,
} from '../src/graph/derive.js';

const chapter1: StoryPoint = { docId: 'manuscript/ch-1.md', order: 1, label: 'Chapter 1', chapterNo: 1 };
const chapter2: StoryPoint = { docId: 'manuscript/ch-2.md', order: 2, label: 'Chapter 2', chapterNo: 2 };
const chapter3: StoryPoint = { docId: 'manuscript/ch-3.md', order: 3, label: 'Chapter 3', chapterNo: 3 };

function snapshot(): WorldGraphSnapshot {
  return {
    view: 'planner',
    version: 'test',
    stopState: 'resolved',
    stopPoint: chapter3,
    storyPoints: [chapter1, chapter2, chapter3],
    nodeTypes: [{ id: 'character', name: 'Character', visualFamily: 'character' }],
    relationTypes: [{
      id: 'knows',
      name: 'Knows',
      visualFamily: 'custom',
      directed: true,
      reverseName: 'Known by',
    }],
    nodes: [
      {
        id: 'char:a', name: 'Character A', aliases: ['RoleA'], typeId: 'character',
        activeFrom: '@start', revealedAt: chapter1, inactiveFrom: null,
        visibility: 'public', confidence: 'confirmed',
        sources: [{ docId: chapter1.docId, heading: 'Character A', label: null }], implicit: false,
      },
      {
        id: 'char:b', name: 'Character B', aliases: [], typeId: 'character',
        activeFrom: chapter1, revealedAt: chapter1, inactiveFrom: chapter3,
        visibility: 'public', confidence: 'confirmed', sources: [], implicit: false,
      },
      {
        id: 'char:c', name: 'Character C', aliases: [], typeId: 'character',
        activeFrom: null, revealedAt: null, inactiveFrom: null,
        visibility: 'authorOnly', confidence: 'question', sources: [], implicit: false,
      },
    ],
    edges: [
      {
        id: 'rel:ab', sourceId: 'char:a', relationTypeId: 'knows', targetId: 'char:b',
        activeFrom: chapter1, revealedAt: chapter1, inactiveFrom: chapter3,
        visibility: 'public', confidence: 'confirmed', sources: [],
      },
      {
        id: 'rel:bc', sourceId: 'char:b', relationTypeId: 'knows', targetId: 'char:c',
        activeFrom: null, revealedAt: null, inactiveFrom: null,
        visibility: 'authorOnly', confidence: 'question', sources: [],
      },
    ],
    counts: { nodeTypes: 1, relationTypes: 1, nodes: 3, edges: 2 },
    diagnostics: [],
    diagnosticCount: 0,
  };
}

function allFilters(throughOrder: number, showUnknownTime = false) {
  return {
    nodeTypeIds: new Set(['character']),
    relationTypeIds: new Set(['knows']),
    confidences: new Set(['confirmed', 'inferred', 'question'] as const),
    visibilities: new Set(['public', 'authorOnly'] as const),
    throughOrder,
    showUnknownTime,
    showIsolated: true,
  };
}

test('time slicing treats inactiveFrom as exclusive and hides unknown time by default', () => {
  const atTwo = filterGraph(snapshot(), allFilters(2));
  assert.deepEqual(atTwo.edges.map((edge) => edge.id), ['rel:ab']);
  assert.deepEqual(atTwo.nodes.map((node) => node.id), ['char:a', 'char:b']);

  const atThree = filterGraph(snapshot(), allFilters(3));
  assert.deepEqual(atThree.edges, []);
  assert.deepEqual(atThree.nodes.map((node) => node.id), ['char:a']);

  const withUnknown = filterGraph(snapshot(), allFilters(2, true));
  assert.equal(withUnknown.nodes.some((node) => node.id === 'char:c'), true);
  assert.equal(withUnknown.edges.some((edge) => edge.id === 'rel:bc'), true);
});

test('local graph expands exact adjacency depth without inventing a center', () => {
  const base = filterGraph(snapshot(), allFilters(2, true));
  assert.deepEqual(localGraph(base, [], 2), { nodes: [], edges: [] });
  const depthOne = localGraph(base, ['char:a'], 1);
  assert.deepEqual(depthOne.nodes.map((node) => node.id), ['char:a', 'char:b']);
  assert.deepEqual(depthOne.edges.map((edge) => edge.id), ['rel:ab']);
  const depthTwo = localGraph(base, ['char:a'], 2);
  assert.deepEqual(depthTwo.nodes.map((node) => node.id), ['char:a', 'char:b', 'char:c']);
});

test('current document seeds use exact source refs and normalized names', () => {
  const base = filterGraph(snapshot(), allFilters(2, true));
  assert.deepEqual(currentDocumentSeeds(base, chapter1.docId, ''), ['char:a']);
  assert.deepEqual(currentDocumentSeeds(base, null, 'sample document text mentioning Character B'), ['char:b']);
});

test('global sampling is deterministic and keeps only selected endpoints', () => {
  const base = filterGraph(snapshot(), allFilters(2, true));
  const first = sampleGlobalGraph(base, 2, 1);
  const second = sampleGlobalGraph(base, 2, 1);
  assert.equal(first.sampled, true);
  assert.deepEqual(first, second);
  const ids = new Set(first.graph.nodes.map((node) => node.id));
  assert.equal(first.graph.edges.every((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId)), true);
});

test('global sampling retains a searched or selected low-degree node', () => {
  const base = snapshot();
  const nodes = Array.from({ length: 1_001 }, (_, index) => ({
    ...base.nodes[0]!,
    id: `node:${index.toString().padStart(4, '0')}`,
    name: `Node ${index}`,
    aliases: [],
    sources: [],
  }));
  const edges = Array.from({ length: 1_000 }, (_, index) => ({
    ...base.edges[0]!,
    id: `edge:${index.toString().padStart(4, '0')}`,
    sourceId: nodes[index]!.id,
    targetId: nodes[(index + 1) % 1_000]!.id,
  }));
  const pinnedId = nodes.at(-1)!.id;
  const sampled = sampleGlobalGraph({ nodes, edges }, 1_000, 3_000, [pinnedId]);
  assert.equal(sampled.sampled, true);
  assert.equal(sampled.graph.nodes.some((node) => node.id === pinnedId), true);
  assert.equal(sampled.graph.nodes.length, 1_000);
});

test('search matches the localized node type name as well as IDs and aliases', () => {
  const graph = {
    nodes: [{ ...snapshot().nodes[0]!, id: 'char:a', name: '阿尔法', typeId: 'character' }],
    edges: [],
  };
  assert.deepEqual(
    matchingNodes(graph, '人物', new Map([['character', '人物']])).map((item) => item.id),
    ['char:a'],
  );
});
