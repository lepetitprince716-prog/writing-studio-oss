import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGraphMarkdown } from '../src/graph/parser.js';

test('graph preflight counts a pipe preceded by an even backslash run as a delimiter', () => {
  const rows = Array.from({ length: 5_001 }, (_, index) =>
    `| node:${index} | Node ${index} | | character | @start | 1 | | public | confirmed | ignored | ignored | |`,
  );
  const markdown = [
    '# World graph',
    '## Node Types',
    '| ID | Name | Visual Family |',
    '| - | - | - |',
    '| character | Character | character |',
    '## Nodes',
    '| ID | Name | Aliases | Type | Active From | Revealed At | Inactive From | Visibility | Confidence | Dummy\\\\| Extra | Sources |',
    '| - | - | - | - | - | - | - | - | - | - | - | - |',
    ...rows,
  ].join('\n');

  assert.throws(
    () => parseGraphMarkdown('关系网.md', markdown),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && (error as Error & { code: string }).code === 'GRAPH_TOO_LARGE',
  );
});

test('graph parser preserves an escaped pipe preceded by an odd backslash run', () => {
  const markdown = [
    '# World graph',
    '## Node Types',
    '| ID | Name | Visual Family |',
    '| - | - | - |',
    '| character | Character \\| Person | character |',
    '## Relations',
    '| ID | Source | Relation | Target | Active From | Revealed At | Inactive From | Visibility | Confidence | Sources |',
    '| - | - | - | - | - | - | - | - | - | - |',
  ].join('\n');

  const parsed = parseGraphMarkdown('关系网.md', markdown);
  assert.equal(parsed.nodeTypes[0]?.name, 'Character | Person');
});
