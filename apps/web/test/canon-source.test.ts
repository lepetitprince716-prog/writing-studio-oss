import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonSectionRef, SidebarSource } from '@writing-studio/contract';
import {
  resolveCanonHeading,
  resolveCanonSource,
} from '../src/lib/canonSource.js';

function plainSource(file: string): SidebarSource {
  return {
    id: file,
    label: file,
    file,
    order: 1,
    parser: 'plain',
    parserConfig: {},
  };
}

const sources = [
  plainSource('世界观.md'),
  plainSource('角色设定.md'),
  plainSource('伏笔追踪.md'),
  plainSource('世界地图_制图规范.md'),
];

test('resolveCanonSource covers every supported vault source shape', () => {
  assert.deepEqual(resolveCanonSource('世界观.md §0', sources), {
    docId: '世界观.md',
    headingPrefix: '0',
  });
  assert.deepEqual(resolveCanonSource('世界观.md §1', sources), {
    docId: '世界观.md',
    headingPrefix: '1',
  });
  assert.deepEqual(resolveCanonSource('世界观.md §3.2', sources), {
    docId: '世界观.md',
    headingPrefix: '3.2',
  });
  assert.deepEqual(resolveCanonSource('世界观.md §6.3', sources), {
    docId: '世界观.md',
    headingPrefix: '6.3',
  });
  assert.deepEqual(resolveCanonSource('世界观.md §1（时代总览）', sources), {
    docId: '世界观.md',
    headingPrefix: '1',
  });
  assert.deepEqual(resolveCanonSource('世界观.md §0/§1', sources), {
    docId: '世界观.md',
    headingPrefix: '0',
  });
  assert.deepEqual(resolveCanonSource('角色设定.md §角色A', sources), {
    docId: '角色设定.md',
    headingPrefix: '角色A',
  });
  assert.deepEqual(resolveCanonSource('角色设定.md §王国势力', sources), {
    docId: '角色设定.md',
    headingPrefix: '王国势力',
  });
  assert.deepEqual(resolveCanonSource('角色设定.md §事物A相关/§B 小队', sources), {
    docId: '角色设定.md',
    headingPrefix: '事物A相关',
  });
  assert.deepEqual(
    resolveCanonSource('世界观.md §12 / 伏笔追踪.md F06', [
      plainSource('伏笔追踪.md'),
    ]),
    { docId: '伏笔追踪.md', headingPrefix: 'F06' },
  );
  assert.deepEqual(
    resolveCanonSource(
      '角色设定.md §角色B / 伏笔追踪.md F08（典礼当夜为关键时间节点）',
      [plainSource('伏笔追踪.md')],
    ),
    { docId: '伏笔追踪.md', headingPrefix: 'F08' },
  );
  assert.deepEqual(
    resolveCanonSource('未配置.md §2 / 世界观.md §3.2 / 制图规范.md §13', sources),
    { docId: '世界观.md', headingPrefix: '3.2' },
  );
  assert.deepEqual(resolveCanonSource('制图规范.md §13', sources), {
    docId: '世界地图_制图规范.md',
    headingPrefix: '13',
  });
});

test('resolveCanonSource short-name matching is bounded and picks the shortest match', () => {
  const ambiguous = [
    plainSource('archive/制图规范.md'),
    plainSource('世界地图_制图规范.md'),
    plainSource('伪制图规范.md'),
  ];
  assert.deepEqual(resolveCanonSource('制图规范.md §13', ambiguous), {
    docId: '世界地图_制图规范.md',
    headingPrefix: '13',
  });
  assert.equal(
    resolveCanonSource('制图规范.md §13', [plainSource('伪制图规范.md')]),
    null,
    'an arbitrary filename suffix must not count as a short-name match',
  );
});

test('resolveCanonSource fails closed for malformed source strings', () => {
  for (const raw of [
    '',
    '§3.2',
    '世界观.txt §3.2',
    '世界观.md §',
    '世界观.md / 伏笔追踪.md',
  ]) {
    assert.equal(resolveCanonSource(raw, sources), null, raw);
  }
});

test('resolveCanonHeading accepts approved numeric and semantic prefix boundaries', () => {
  const section = (heading: string): CanonSectionRef => ({
    headingPath: [heading],
    anchor: {
      docSha: 'a'.repeat(64),
      start: 0,
      end: 1,
      prefix: '',
      exact: 'x',
      suffix: '',
    },
  });
  const sections = [
    section('0. 使用规则'),
    section('1. 一页总览'),
    section('3.2 大地理结构'),
    section('3.20 不应误配'),
    section('6.3 地点E'),
    section('10. 技术、经济与日常尺度'),
    section('角色A（Role A）'),
    section('王国势力'),
    section('F06：地点D的方向指引'),
    section('角色B（Role B）'),
  ];

  assert.equal(resolveCanonHeading('0', sections), '0. 使用规则');
  assert.equal(resolveCanonHeading('3.2', sections), '3.2 大地理结构');
  assert.equal(resolveCanonHeading('6.3', sections), '6.3 地点E');
  assert.equal(resolveCanonHeading('1', [sections[5]!]), null, '§1 must not match §10');
  assert.equal(resolveCanonHeading('3.2', [sections[3]!]), null, '§3.2 must not match §3.20');
  assert.equal(resolveCanonHeading('角色A', sections), '角色A（Role A）');
  assert.equal(resolveCanonHeading('王国势力', sections), '王国势力');
  assert.equal(resolveCanonHeading('F06', sections), 'F06：地点D的方向指引');
  assert.equal(resolveCanonHeading('角色B', sections), '角色B（Role B）');
  assert.equal(resolveCanonHeading('9', sections), null);
});
