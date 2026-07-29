import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectConfig, SidebarSource } from '@writing-studio/contract';
import { SidebarService } from '../src/sidebar/index.js';

// Probe whether chokidar can observe filesystem events in this environment
// (same pattern as apps/server/test/ws-watch.test.ts). The sha-based watcher
// tests below register a skip reason at registration time when it cannot.
let sidebarWatchSkipReason: string | false = false;
{
  const probeDir = await mkdtemp(join(tmpdir(), 'sidebar-watch-probe-'));
  const watcherOk = await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    const watcher = chokidar.watch(probeDir, { ignoreInitial: true });
    watcher.on('error', () => settle(false));
    setTimeout(() => { watcher.close().then(() => settle(true), () => settle(false)); }, 50);
  });
  await rm(probeDir, { recursive: true, force: true });
  if (!watcherOk) {
    sidebarWatchSkipReason = 'chokidar watcher probe failed in this environment';
  }
}

async function withVault(run: (vaultRoot: string) => Promise<void>): Promise<void> {
  const vaultRoot = await mkdtemp(join(tmpdir(), 'writing-studio-sidebar-'));
  try {
    await run(vaultRoot);
  } finally {
    await rm(vaultRoot, { recursive: true, force: true });
  }
}

function project(
  vaultRoot: string,
  sidebarSources: SidebarSource[],
  localePreset?: ProjectConfig['localePreset'],
) {
  return { vaultRoot, config: { sidebarSources, localePreset } };
}

function withoutWriterSections<T extends { writerSections?: unknown } | undefined>(payload: T) {
  if (!payload) return payload;
  const { writerSections: _writerSections, ...rest } = payload;
  return rest;
}

test('markdown-table uses source column aliases and q only matches term/source', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'index.md'), [
      '## 地理',
      '| 编号 | 术语 | 定义出处 | 首次 | AUTHOR | 状态 |',
      '| - | - | - | - | - | - |',
      '| 01 | 地点B | 世界观.md | 第1章 | — | 已定 |',
    ].join('\n'));
    const source: SidebarSource = {
      id: 'setting_index', label: '设定', file: 'index.md', parser: 'markdown-table', order: 1,
      parserConfig: {
        sectionHeadingLevels: [2],
        columnAliases: {
          term: ['术语'], source: ['定义出处'], firstAppearance: ['首次'],
          blankLink: ['AUTHOR'], status: ['状态'], serial: ['编号'],
        },
      },
    };
    const service = new SidebarService();
    const payload = service.getSource(project(vaultRoot, [source]), source.id, 'planner');
    assert.deepEqual(withoutWriterSections(payload), {
      sourceId: 'setting_index', parser: 'markdown-table', entries: [{
        section: '地理', term: '地点B', source: '世界观.md', firstAppearance: '第1章',
        blankLink: '—', status: '已定', serial: '01',
      }],
    });
    const beforeFirstAppearance = service.getSource(project(vaultRoot, [source]), source.id, 'planner', '第1章');
    assert.equal(beforeFirstAppearance?.parser, 'markdown-table');
    if (beforeFirstAppearance?.parser === 'markdown-table') assert.equal(beforeFirstAppearance.entries.length, 0);
    const atFirstAppearance = service.getSource(project(vaultRoot, [source]), source.id, 'planner', '世界观');
    assert.equal(atFirstAppearance?.parser, 'markdown-table');
    if (atFirstAppearance?.parser === 'markdown-table') assert.equal(atFirstAppearance.entries.length, 1);
    const writerPayload = service.getSource(project(vaultRoot, [source]), source.id, 'writer');
    assert.equal(writerPayload?.parser, 'markdown-table');
    if (writerPayload?.parser === 'markdown-table') assert.equal(writerPayload.entries[0]?.blankLink, '');
    const genericSource: SidebarSource = {
      ...source,
      parserConfig: { ...source.parserConfig, writerHiddenFields: [] },
    };
    const genericWriter = service.getSource(project(vaultRoot, [genericSource]), source.id, 'writer');
    assert.equal(genericWriter?.parser, 'markdown-table');
    if (genericWriter?.parser === 'markdown-table') assert.equal(genericWriter.entries[0]?.blankLink, '—');
  });
});

test('writer character DTO removes marked headings, paragraphs, and list items without cache pollution', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'characters.md'), [
      '## 公开角色',
      '### 身份',
      '公开事实。',
      '- 可公开装备',
      '- 作者侧·未公开：秘密装备',
      '### 作者侧·未公开',
      '绝不可泄露的终局。',
      '## 作者侧·未公开角色',
      '### 身份',
      '绝不可泄露。',
    ].join('\n'));
    const source: SidebarSource = {
      id: 'characters', label: '角色', file: 'characters.md', parser: 'heading-sections', order: 1,
      parserConfig: {
        kind: 'characters', cardHeadingLevel: 2, sectionHeadingLevel: 3,
        authorOnlyMarkers: ['作者侧·未公开'],
      },
    };
    const service = new SidebarService();
    const writerFirst = service.getSource(project(vaultRoot, [source]), source.id, 'writer');
    assert.equal(JSON.stringify(writerFirst).includes('作者侧·未公开'), false);
    assert.deepEqual(withoutWriterSections(writerFirst), {
      sourceId: 'characters', parser: 'heading-sections', kind: 'characters', data: [{
        name: '公开角色', sections: [{ heading: '身份', body: '公开事实。\n可公开装备', authorOnly: false }],
      }],
    });
    const plannerAfterWriter = service.getSource(project(vaultRoot, [source]), source.id, 'planner');
    assert.equal(JSON.stringify(plannerAfterWriter).includes('秘密装备'), true);
    const writerAfterPlanner = service.getSource(project(vaultRoot, [source]), source.id, 'writer');
    assert.equal(JSON.stringify(writerAfterPlanner).includes('终局'), false);
  });
});

test('heading-section kinds derive writing status and foreshadowing from configured patterns', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'status.md'), [
      '> 最后刷新：2026-07-22；对应停点第75章',
      '## 停点', '地点G。',
      '## 故事线', '- **主线**：占位情节内容',
      '## 活跃伏笔速览', '| 编号 | 内容 | 状态 |', '| - | - | - |', '| F07 | 追踪 | 推进 |',
      '## 角色一句话状态', '- **角色A**：安全',
      '## 写作红线', '1. 不预告。',
      '## 表达基线', '写准。',
    ].join('\n'));
    await writeFile(join(vaultRoot, 'foreshadow.md'), [
      '## 伏笔清单', '### F01：融合', '- 内容：已出现', '- **回收状态**：推进中',
    ].join('\n'));
    const statusSource = {
      id: 'writing_status', label: '状态', file: 'status.md', parser: 'heading-sections', order: 1,
      parserConfig: {
        kind: 'writingStatus', lastRefreshedRegex: '最后刷新：([0-9-]+)', stopChapterRegex: '对应停点第(\\d+)章',
      },
    } as unknown as SidebarSource;
    const foreshadowSource = {
      id: 'foreshadowing', label: '伏笔', file: 'foreshadow.md', parser: 'heading-sections', order: 2,
      parserConfig: {
        kind: 'foreshadowing', itemHeadingLevel: 3, itemIdRegex: '^(F\\d+)：(.+)$',
        statusFieldRegex: '\\*\\*回收状态\\*\\*[:：]\\s*(.+)$',
      },
    } as unknown as SidebarSource;
    const service = new SidebarService();
    const status = service.getSource(project(vaultRoot, [statusSource, foreshadowSource]), 'writing_status');
    assert.deepEqual(withoutWriterSections(status), {
      sourceId: 'writing_status', parser: 'heading-sections', kind: 'writingStatus', data: {
        sectionHeadings: {
          stopPoint: '停点', storylines: '故事线', activeForeshadow: '活跃伏笔速览',
          characterOneLiners: '角色一句话状态', redLines: '写作红线', expressionBaseline: '表达基线',
        },
        lastRefreshed: '2026-07-22', stopChapter: 75, stopPoint: '地点G。',
        storylines: [{ name: '主线', body: '占位情节内容' }],
        activeForeshadow: [{ id: 'F07', content: '追踪', status: '推进' }],
        characterOneLiners: [{ name: '角色A', text: '安全' }],
        redLines: ['不预告。'], expressionBaseline: '写准。',
      },
    });
    const foreshadow = service.getSource(
      project(vaultRoot, [statusSource, foreshadowSource]), 'foreshadowing', 'planner',
    );
    assert.deepEqual(withoutWriterSections(foreshadow), {
      sourceId: 'foreshadowing', parser: 'heading-sections', kind: 'foreshadowing', data: [{
        id: 'F01', title: '融合', body: '内容：已出现\n回收状态：推进中', status: '推进中',
      }],
    });
    const writerForeshadow = service.getSource(
      project(vaultRoot, [statusSource, foreshadowSource]), 'foreshadowing', 'writer',
    );
    assert.deepEqual(withoutWriterSections(writerForeshadow), {
      sourceId: 'foreshadowing', parser: 'heading-sections', kind: 'foreshadowing', data: [],
    });
    const writerVisibleSource = {
      ...foreshadowSource,
      parserConfig: { ...foreshadowSource.parserConfig, writerVisible: true },
    } as unknown as SidebarSource;
    const visibleForeshadow = service.getSource(
      project(vaultRoot, [writerVisibleSource]), 'foreshadowing', 'writer',
    );
    assert.equal(
      visibleForeshadow?.parser === 'heading-sections'
        && visibleForeshadow.kind === 'foreshadowing'
        && visibleForeshadow.data.length,
      1,
    );
  });
});

test('writing-status section labels are project-localizable', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'status-en.md'), [
      'Refreshed: 2026-07-22; Chapter 3',
      '## Stop point', 'Example stop point.',
      '## Storylines', '- **Main**: Example storyline progress',
      '## Active clues', '| ID | Content | Status |', '| - | - | - |', '| C1 | Clue | Open |',
      '## Characters', '- **Character A**: Waiting',
      '## Guardrails', '1. No spoilers.',
      '## Style', 'Be precise.',
    ].join('\n'));
    const sectionHeadings = {
      stopPoint: 'Stop point', storylines: 'Storylines', activeForeshadow: 'Active clues',
      characterOneLiners: 'Characters', redLines: 'Guardrails', expressionBaseline: 'Style',
    };
    const source: SidebarSource = {
      id: 'status_en', label: 'Status', file: 'status-en.md', parser: 'heading-sections', order: 1,
      parserConfig: {
        kind: 'writingStatus', lastRefreshedRegex: 'Refreshed: ([0-9-]+)',
        stopChapterRegex: 'Chapter (\\d+)',
        sectionHeadings,
      },
    };
    const payload = new SidebarService().getSource(project(vaultRoot, [source]), source.id, 'writer');
    assert.equal(payload?.parser, 'heading-sections');
    if (payload?.parser === 'heading-sections' && payload.kind === 'writingStatus') {
      assert.deepEqual(payload.data.sectionHeadings, sectionHeadings);
      assert.deepEqual(
        payload.writerSections?.map((section) => section.headingPath),
        [['Stop point'], ['Style']],
      );
      assert.equal(payload.data.stopPoint, 'Example stop point.');
      assert.deepEqual(payload.data.storylines, [{ name: 'Main', body: 'Example storyline progress' }]);
      assert.equal(payload.data.activeForeshadow[0]?.id, 'C1');
      assert.equal(payload.data.characterOneLiners[0]?.name, 'Character A');
      assert.deepEqual(payload.data.redLines, ['No spoilers.']);
      assert.equal(payload.data.expressionBaseline, 'Be precise.');
    }
  });
});

test('en locale preset parses all writing-status sections without explicit headings', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'status-en.md'), [
      '> Last refreshed: 2026-07-22',
      '> Story stop: Chapter 1',
      '## Stop point', 'The first line has been written.',
      '## Storylines', '- **Main**: Continue the opening',
      '## Active foreshadow overview',
      '| ID | Content | Status |', '| - | - | - |', '| F1 | A clue | Open |',
      '## Character one-line status', '- **Character A**: Waiting',
      '## Writing red lines', '1. No spoilers.',
      '## Expression baseline', 'Be precise.',
    ].join('\n'));
    const source: SidebarSource = {
      id: 'status_en', label: 'Status', file: 'status-en.md', parser: 'heading-sections', order: 1,
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: 'Last refreshed: ([0-9-]+)',
        stopChapterRegex: 'Story stop: Chapter (\\d+)',
      },
    };

    const payload = new SidebarService().getSource(
      project(vaultRoot, [source], 'en'),
      source.id,
      'writer',
    );
    assert.equal(payload?.parser, 'heading-sections');
    if (payload?.parser !== 'heading-sections') return;
    // Assert the discriminant instead of guarding with `if`: a kind regression
    // must fail the test, not silently skip its six assertions.
    assert.equal(payload.kind, 'writingStatus');
    if (payload.kind !== 'writingStatus') return;
    assert.deepEqual(payload.data.sectionHeadings, {
      stopPoint: 'Stop point',
      storylines: 'Storylines',
      activeForeshadow: 'Active foreshadow overview',
      characterOneLiners: 'Character one-line status',
      redLines: 'Writing red lines',
      expressionBaseline: 'Expression baseline',
    });
    assert.deepEqual(
      payload.writerSections?.map((section) => section.headingPath),
      [['Stop point'], ['Expression baseline']],
    );
    assert.equal(payload.data.stopPoint, 'The first line has been written.');
    assert.deepEqual(payload.data.storylines, [{ name: 'Main', body: 'Continue the opening' }]);
    assert.equal(payload.data.activeForeshadow[0]?.id, 'F1');
    assert.equal(payload.data.characterOneLiners[0]?.name, 'Character A');
    assert.deepEqual(payload.data.redLines, ['No spoilers.']);
    assert.equal(payload.data.expressionBaseline, 'Be precise.');
  });
});

test('explicit writing-status heading overrides the en locale preset', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'status-mixed.md'), [
      '## 停点', '中文显式标题优先。',
      '## Storylines', '- **Main**: Continue',
      '## Active foreshadow overview',
      '| ID | Content | Status |', '| - | - | - |', '| F1 | A clue | Open |',
      '## Character one-line status', '- **Character A**: Waiting',
      '## Writing red lines', '1. No spoilers.',
      '## Expression baseline', 'Be precise.',
    ].join('\n'));
    const source: SidebarSource = {
      id: 'status_mixed', label: 'Status', file: 'status-mixed.md',
      parser: 'heading-sections', order: 1,
      parserConfig: {
        kind: 'writingStatus',
        lastRefreshedRegex: 'Last refreshed: ([0-9-]+)',
        stopChapterRegex: 'Story stop: Chapter (\\d+)',
        sectionHeadings: { stopPoint: '停点' },
      },
    };
    const payload = new SidebarService().getSource(
      project(vaultRoot, [source], 'en'),
      source.id,
      'writer',
    );
    assert.equal(payload?.parser, 'heading-sections');
    if (payload?.parser !== 'heading-sections') return;
    assert.equal(payload.kind, 'writingStatus');
    if (payload.kind !== 'writingStatus') return;
    assert.deepEqual(payload.data.sectionHeadings, {
      stopPoint: '停点',
      storylines: 'Storylines',
      activeForeshadow: 'Active foreshadow overview',
      characterOneLiners: 'Character one-line status',
      redLines: 'Writing red lines',
      expressionBaseline: 'Expression baseline',
    });
    assert.equal(payload.data.stopPoint, '中文显式标题优先。');
    // The keys NOT explicitly overridden must still resolve through the en
    // locale pack — a partial override must not disable the preset.
    assert.deepEqual(payload.data.storylines, [{ name: 'Main', body: 'Continue' }]);
    assert.deepEqual(payload.data.redLines, ['No spoilers.']);
  });
});

test('watcher emits only on sha changes and has an explicit close lifecycle', { skip: sidebarWatchSkipReason }, async () => {
  await withVault(async (vaultRoot) => {
    const file = join(vaultRoot, 'plain.md');
    await writeFile(file, 'A');
    const source: SidebarSource = {
      id: 'plain', label: '原文', file: 'plain.md', parser: 'plain', parserConfig: {}, order: 1,
    };
    const service = new SidebarService();
    const updates: string[] = [];
    service.startWatching(project(vaultRoot, [source]), (sourceId) => updates.push(sourceId));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const now = new Date();
    await utimes(file, now, now);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    // Pin the generic: strict deepEqual's `asserts actual is T` would otherwise
    // narrow `updates` to never[] for the rest of this control flow.
    assert.deepEqual<string[]>(updates, []);
    await writeFile(file, 'B');
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('sidebar update was not observed within 1 second')), 1000);
      const poll = setInterval(() => {
        if (updates.includes('plain')) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolvePromise();
        }
      }, 20);
    });
    assert.deepEqual(updates, ['plain']);
    await service.close();
  });
});

test('watcher observes only source parents and does not recurse through the vault', async () => {
  await withVault(async (vaultRoot) => {
    await writeFile(join(vaultRoot, 'plain.md'), 'A');
    await mkdir(join(vaultRoot, 'unrelated', 'deep'), { recursive: true });
    await writeFile(join(vaultRoot, 'unrelated', 'deep', 'large-tree.md'), 'unrelated');
    const source: SidebarSource = {
      id: 'plain', label: '原文', file: 'plain.md', parser: 'plain', parserConfig: {}, order: 1,
    };
    const service = new SidebarService();
    service.startWatching(project(vaultRoot, [source]), () => undefined);
    const watcher = (service as unknown as { watcher: FSWatcher }).watcher;
    await new Promise<void>((resolvePromise) => watcher.once('ready', resolvePromise));
    const watchedDirectories = Object.keys(watcher.getWatched());
    assert.equal(
      watchedDirectories.some((path) => path.includes(join('unrelated', 'deep'))),
      false,
    );
    await service.close();
  });
});

test('watcher recovers a configured source across missing and replaced parent directories', { skip: sidebarWatchSkipReason }, async () => {
  await withVault(async (vaultRoot) => {
    const source: SidebarSource = {
      id: 'nested', label: '嵌套', file: 'canon/sidebar.md', parser: 'plain', parserConfig: {}, order: 1,
    };
    const service = new SidebarService();
    const updates: string[] = [];
    service.startWatching(project(vaultRoot, [source]), (sourceId) => updates.push(sourceId));
    const waitForUpdates = async (count: number): Promise<void> => {
      const deadline = Date.now() + 1_000;
      while (updates.length < count && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
      }
      assert.equal(updates.length, count);
    };

    await mkdir(join(vaultRoot, 'canon'), { recursive: true });
    await writeFile(join(vaultRoot, 'canon', 'sidebar.md'), 'first');
    await waitForUpdates(1);

    await rm(join(vaultRoot, 'canon'), { recursive: true, force: true });
    await mkdir(join(vaultRoot, 'canon'), { recursive: true });
    await writeFile(join(vaultRoot, 'canon', 'sidebar.md'), 'second');
    await waitForUpdates(2);
    assert.deepEqual(updates, ['nested', 'nested']);
    await service.close();
  });
});

const realVault = process.env['WRITING_STUDIO_LOCAL_VAULT'] ?? '';

function configuredStrings(parserConfig: unknown, field: string): string[] {
  const record = parserConfig && typeof parserConfig === 'object' ? parserConfig as Record<string, unknown> : {};
  const value = record[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// Opt-in smoke test against whatever real local vault the developer points
// WRITING_STUDIO_LOCAL_VAULT at. It must hold for ANY vault's own config and
// content, not just one author's -- so every assertion below is derived from
// the vault's own project.json rather than a hardcoded id, term, or count.
test('a real local vault\'s writer sidebar projection is safe and structurally sound', {
  skip: !realVault || !existsSync(join(realVault, '.writing-studio', 'project.json')),
}, () => {
  const rawConfig = JSON.parse(
    readFileSync(join(realVault, '.writing-studio', 'project.json'), 'utf8'),
  ) as { sidebarSources: unknown[] };
  const sources = rawConfig.sidebarSources as SidebarSource[];
  const service = new SidebarService();
  const plannerPayloads = service.getAll(project(realVault, sources), 'planner');
  const writerPayloads = service.getAll(project(realVault, sources), 'writer');

  // Every configured source parses into exactly one payload, with unique ids.
  assert.equal(writerPayloads.length, sources.length);
  const sourceIds = writerPayloads.map((payload) => payload.sourceId);
  assert.equal(new Set(sourceIds).size, sourceIds.length);

  // Any heading carrying a project's own authorOnlyMarkers text must be fully
  // stripped from the writer projection -- the marker string itself must not
  // survive anywhere in the serialized output.
  const writerJson = JSON.stringify(writerPayloads).toLocaleLowerCase();
  const configuredMarkers = sources.flatMap((source) => configuredStrings(source.parserConfig, 'authorOnlyMarkers'));
  for (const marker of configuredMarkers) {
    assert.equal(writerJson.includes(marker.toLocaleLowerCase()), false, marker);
  }

  for (const payload of writerPayloads) {
    if (payload.parser === 'markdown-table') {
      // writerHiddenFields (blankLink by default) must be blanked on every
      // row, whatever the row count -- see the fixture test above for the
      // default vs. explicit-opt-out cases this covers.
      const source = sources.find((candidate) => candidate.id === payload.sourceId);
      const configuredHidden = configuredStrings(source?.parserConfig, 'writerHiddenFields');
      const hiddenFields = new Set(configuredHidden.length > 0 || source?.parserConfig
        && Array.isArray((source.parserConfig as Record<string, unknown>)['writerHiddenFields'])
        ? configuredHidden
        : ['blankLink']);
      for (const entry of payload.entries) {
        if (hiddenFields.has('blankLink')) assert.equal(entry.blankLink, '');
        if (hiddenFields.has('serial')) assert.equal(entry.serial, null);
      }
    } else if (payload.parser === 'heading-sections' && payload.kind === 'characters') {
      // No authorOnly section survives into the writer view.
      for (const card of payload.data) {
        assert.equal(card.sections.some((section) => section.authorOnly), false);
      }
    } else if (payload.parser === 'heading-sections' && payload.kind === 'foreshadowing') {
      // Unless the source explicitly opts into writerVisible, no entries
      // should reach the writer projection at all.
      const source = sources.find((candidate) => candidate.id === payload.sourceId);
      const writerVisible = (source?.parserConfig as Record<string, unknown> | undefined)?.['writerVisible'] === true;
      if (!writerVisible) assert.deepEqual(payload.data, []);
      // else: this vault opted its foreshadowing source into writer
      // visibility; what belongs there depends on the vault's own content,
      // so nothing further is asserted here.
    }
  }

  // markdown-table term/source query: derive the query term from whatever
  // the vault's own planner view actually contains -- never a hardcoded
  // placeholder term, which no real vault is guaranteed to have.
  const plannerTable = plannerPayloads.find(
    (payload) => payload.parser === 'markdown-table' && payload.entries.length > 0 && payload.entries[0]!.term,
  );
  if (plannerTable && plannerTable.parser === 'markdown-table') {
    const sampleTerm = plannerTable.entries[0]!.term;
    const filtered = service.getSource(project(realVault, sources), plannerTable.sourceId, 'planner', sampleTerm);
    assert.equal(filtered?.parser, 'markdown-table');
    if (filtered?.parser === 'markdown-table') {
      const needle = sampleTerm.toLocaleLowerCase();
      assert.equal(filtered.entries.length > 0, true);
      assert.equal(
        filtered.entries.every((entry) =>
          entry.term.toLocaleLowerCase().includes(needle) || entry.source.toLocaleLowerCase().includes(needle)),
        true,
      );
    }
  }
  // else: the vault has no markdown-table source with a non-empty term to
  // query on -- skipped rather than asserted against a hardcoded term.
});
