import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentBackend, AgentId } from '@writing-studio/contract';
import { StudioError } from '../src/errors.js';
import { loadAgentModelCatalogs } from '../src/agents/models.js';
import { AgentCatalog } from '../src/run.js';

function withDataDir(run: (dataDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'writing-studio-model-catalog-'));
  const dataDir = join(root, 'data');
  try {
    mkdirSync(dataDir, { recursive: true });
    run(dataDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('agent-models.json replaces one configured agent catalog without changing the others', () => {
  withDataDir((dataDir) => {
    const builtins = loadAgentModelCatalogs(dataDir);
    assert.deepEqual(builtins.claude.map((model) => model.id), ['sonnet', 'opus', 'haiku']);
    assert.deepEqual(builtins.echo.map((model) => model.id), ['echo-1', 'echo-verbose']);
    assert.deepEqual(builtins.pi, []);
    assert.deepEqual(builtins.grok, []);

    writeFileSync(join(dataDir, 'agent-models.json'), JSON.stringify({
      claude: [{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true }],
      echo: [],
    }));
    const configured = loadAgentModelCatalogs(dataDir);
    assert.deepEqual(configured.claude, [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true },
    ]);
    assert.deepEqual(configured.echo, []);
    assert.deepEqual(configured.codex, builtins.codex);
    assert.deepEqual(configured.opencode, builtins.opencode);
    assert.deepEqual(configured.pi, builtins.pi);
    assert.deepEqual(configured.grok, builtins.grok);
  });
});

test('agent-models.json fails loudly for unsafe or internally inconsistent catalogs', () => {
  withDataDir((dataDir) => {
    const path = join(dataDir, 'agent-models.json');
    for (const invalid of [
      { echo: [{ id: '--evil', label: 'must fail' }] },
      { echo: [
        { id: 'same', label: 'first' },
        { id: 'same', label: 'second' },
      ] },
      { echo: [
        { id: 'a', label: 'one', isDefault: true },
        { id: 'b', label: 'two', isDefault: true },
      ] },
      { unknown: [] },
    ]) {
      writeFileSync(path, JSON.stringify(invalid));
      assert.throws(
        () => loadAgentModelCatalogs(dataDir),
        (error: unknown) => error instanceof StudioError && error.code === 'INVALID_CONFIG',
      );
    }
  });
});

test('availability probes five CLI backends serially without exhausting three supervisor slots', async () => {
  let active = 0;
  let peakActive = 0;
  const makeBackend = (id: AgentId): AgentBackend => ({
    id,
    displayName: id,
    async probeAvailability() {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const busy = active > 3;
      active -= 1;
      return {
        agentId: id,
        ok: !busy,
        supportedProfiles: busy ? [] : ['writer'],
        version: 'test',
        binaryPath: `/test/${id}`,
        error: busy ? 'agent process supervisor is busy' : null,
      };
    },
    async *send() {
      return;
    },
  });
  const backends = new Map<AgentId, AgentBackend>(
    (['claude', 'codex', 'opencode', 'pi', 'grok'] as const)
      .map((id) => [id, makeBackend(id)]),
  );

  const availability = await new AgentCatalog(backends).listAvailability();

  assert.equal(peakActive, 1);
  assert.equal(availability.length, 5);
  assert.equal(availability.every((item) => item.ok && item.error === null), true);
});
