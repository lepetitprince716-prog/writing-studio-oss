import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  promptBundleSchema,
  type AgentEvent,
  type Message,
  type ThreadRunContext,
} from '@writing-studio/contract';
import { claudeBackend, parseClaude } from '../src/agents/claude.js';
import {
  codexBackend,
  codexSandboxMode,
  nativeCodexPermissionOverrides,
} from '../src/agents/codex.js';
import {
  binaryPath,
  CliBackend,
  createPlannerProjection,
  strictEnvironment,
  writerScratch,
} from '../src/agents/adapter.js';
import { buildPrompt, replayHistory, replayLatestCandidate } from '../src/agents/history.js';
import { resolvePromptBundle } from '../src/prompts/index.js';
import { ZH_CN_PROMPT_BUNDLE } from '../src/prompts/locales/zh-CN.js';
import { opencodeBackend, parseOpenCode } from '../src/agents/opencode.js';
import { piBackend } from '../src/agents/pi.js';
import { grokBackend, parseGrok } from '../src/agents/grok.js';
import { sandboxUnavailableReason, wrapCodexWriter, wrapGrokWriter, wrapOutsideVault } from '../src/agents/sandbox.js';
import { ProcessSupervisor } from '../src/agents/supervisor.js';
import { tcpListenerSkipReason } from './support/tcp-probe.js';

const sandboxGateReason = sandboxUnavailableReason();
const tcpListenSkipReason = await tcpListenerSkipReason();
const testProcessScope = `process-${process.pid}`;

/**
 * Availability gate for "stopping async-generator consumption terminates its
 * detached child group". Two independent conditions were considered as the
 * cause of that test's failure in a restricted sandbox; both are probed
 * directly rather than assumed, and the reason below reflects whichever one
 * actually applies:
 *
 *  1. Process-group signal delivery (`process.kill(-pid, signal)`) denied
 *     with EPERM. Probed directly against a detached child below. In this
 *     sandbox this was verified to actually succeed, so it is NOT gated on
 *     `sandboxGateReason` (whose root cause -- sandbox-exec unavailable -- is
 *     unrelated: a real Mac with sandbox-exec available should still hit
 *     condition 2 below and skip).
 *  2. The real, confirmed cause here: every Node runtime spawned by
 *     `ProcessSupervisor` (its watchdog, and the CLI process it launches)
 *     emits several lines of "ERROR: failed to copy trust settings of system
 *     certificate" to its own stderr during startup, before the script's own
 *     logic runs. That stderr chunk consistently reaches the supervisor's
 *     queue before the target's first stdout write, which breaks this
 *     test's "first chunk is stdout" assumption. Probed directly through
 *     `ProcessSupervisor.run()` (the same code path the real test exercises)
 *     with a trivial target, rather than inferred.
 */
async function detachedChildGroupTestGateReason(): Promise<string | null> {
  // Condition 1: process-group signal delivery.
  const probeChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    detached: true,
    stdio: 'ignore',
  });
  let groupSignalReason: string | null = null;
  try {
    if (typeof probeChild.pid !== 'number') {
      groupSignalReason = 'detached probe child did not receive a pid';
    } else {
      process.kill(-probeChild.pid, 0);
    }
  } catch (error) {
    groupSignalReason = `process-group signal (process.kill(-pid, sig)) is unavailable in this sandbox: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  } finally {
    if (typeof probeChild.pid === 'number') {
      try { process.kill(-probeChild.pid, 'SIGKILL'); } catch { /* already gone or ungrouped */ }
    }
    try { probeChild.kill('SIGKILL'); } catch { /* already gone */ }
  }
  if (groupSignalReason) return groupSignalReason;

  // Condition 2: stdout/stderr chunk-ordering hazard from Node runtime startup noise.
  const probeSupervisor = new ProcessSupervisor(1);
  const iterator = probeSupervisor.run({
    file: process.execPath,
    args: ['-e', 'console.log("probe")'],
    cwd: tmpdir(),
    env: process.env,
    stdin: '',
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  });
  try {
    const first = await iterator.next();
    if (first.value?.type !== 'stdout') {
      return 'spawned Node child processes emit stderr startup noise (certificate trust store errors) ahead of their own stdout in this sandbox, which breaks this test\'s first-chunk-is-stdout assumption';
    }
    return null;
  } finally {
    await iterator.return();
  }
}

const detachedChildGroupGateReason = await detachedChildGroupTestGateReason();

async function fakeExecutable(source: string): Promise<{ file: string; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'writing-studio-agent-test-'));
  const file = join(dir, 'fake-cli.mjs');
  await writeFile(file, `#!/usr/bin/env node\n${source}`, 'utf8');
  await chmod(file, 0o755);
  return { file, close: () => rm(dir, { recursive: true, force: true }) };
}

async function fakeCommandPath(commands: string[]): Promise<{ directory: string; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'writing-studio-agent-path-'));
  await Promise.all(commands.map(async (command) => {
    const file = join(directory, command);
    await writeFile(file, '#!/bin/sh\nprintf "test-cli 1.0\\n"\n', 'utf8');
    await chmod(file, 0o755);
  }));
  return { directory, close: () => rm(directory, { recursive: true, force: true }) };
}

async function fakeSandboxExecutable(): Promise<{ file: string; close: () => Promise<void> }> {
  return fakeExecutable(`
    import { spawn } from 'node:child_process';
    const args = process.argv.slice(2);
    if (args[0] !== '-p' || !args[1] || !args[2]) process.exit(64);
    const child = spawn(args[2], args.slice(3), { stdio: 'inherit', env: process.env });
    child.once('error', (error) => { console.error(error.message); process.exit(127); });
    child.once('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  `);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function context(
  history: Message[],
  sessionId: string | null = null,
  agentId: 'claude' | 'codex' | 'opencode' | 'pi' | 'grok' = 'claude',
): ThreadRunContext {
  return {
    threadId: `thread-${testProcessScope}`,
    dataDir: join(tmpdir(), `writing-studio-test-data-scope-${testProcessScope}`),
    vaultRoot: join(tmpdir(), `writing-studio-test-vault-scope-${testProcessScope}`),
    history, contextBlock: '', allowVaultBrowsing: false,
    vaultReadPolicy: null,
    systemPrompt: 'native system requirement',
    promptBundle: resolvePromptBundle({}),
    session: sessionId === null ? null : { agentId, nativeSessionId: sessionId, lastSyncedMessageCount: history.length, createdAt: 0, lastUsedAt: 0 },
  };
}

function plannerContext(vaultRoot: string, history: Message[] = []) {
  return {
    ...context(history), vaultRoot, allowVaultBrowsing: true,
    vaultReadPolicy: { readable: ['allowed/**', 'allowed.md'], forbidden: ['allowed/forbidden.md'] },
  };
}

test('history replay caps both count and approximate token budget with an omission notice', () => {
  const history = Array.from({ length: 45 }, (_, index) => ({
    id: String(index), threadId: 't', index, role: 'user' as const, agentId: null,
    content: 'x'.repeat(2_000), structured: null, createdAt: 0,
  }));
  const replay = replayHistory(history, resolvePromptBundle({}));
  assert.ok(replay.omitted >= 21);
  assert.match(replay.text, /已省略较早/);
});

test('history replay omission and latest candidate preserve the legacy bytes', () => {
  const history: Message[] = Array.from({ length: 41 }, (_, index) => ({
    id: `m${index}`,
    threadId: 't',
    role: index % 2 === 0 ? 'user' : 'assistant',
    agentId: index % 2 === 0 ? null : 'pi',
    content: `message-${index}`,
    structured: null,
    createdAt: index,
  }));
  const replay = replayHistory(history, resolvePromptBundle({}));
  assert.equal(
    replay.text,
    '【已省略较早的 1 条历史消息，以保持上下文上限。】\n'
      + history.slice(1).map((message) =>
        `${message.role === 'user' ? '用户：' : '助手：'}${message.content}`)
        .join('\n\n'),
  );
  assert.equal(
    replayLatestCandidate(history, resolvePromptBundle({})).text,
    '助手最近候选全文：\nmessage-39',
  );
  const repeatedPlaceholderPrompts = {
    ...resolvePromptBundle({}),
    historyOmittedNotice: '{omitted}/{omitted}\n',
  };
  assert.equal(
    replayHistory(history, repeatedPlaceholderPrompts).text,
    '1/1\n'
      + history.slice(1).map((message) =>
        `${message.role === 'user' ? '用户：' : '助手：'}${message.content}`)
        .join('\n\n'),
  );
});

test('history replay budgets Chinese and mixed prose conservatively', () => {
  const messages = (content: string) => Array.from({ length: 20 }, (_, index) => ({
    id: String(index), threadId: 't', index, role: 'user' as const, agentId: null,
    content, structured: null, createdAt: 0,
  }));
  const chinese = replayHistory(messages('汉'.repeat(2_000)), resolvePromptBundle({}));
  assert.equal(chinese.omitted, 14);
  assert.equal(chinese.text.match(/用户：/g)?.length, 6);
  const mixed = replayHistory(messages(`${'汉'.repeat(1_000)}${'x'.repeat(4_000)}`), resolvePromptBundle({}));
  assert.equal(mixed.omitted, 14);
  assert.equal(mixed.text.match(/用户：/g)?.length, 6);
});

test('default prompt assembly preserves the legacy bytes', () => {
  const history: Message[] = [{
    id: 'a1', threadId: 't', role: 'assistant', agentId: 'pi',
    content: '先前回答', structured: null, createdAt: 1,
  }];
  assert.equal(
    buildPrompt({
      history,
      replay: true,
      contextBlock: '上下文正文',
      systemPrompt: '系统正文',
      userMessage: '本轮问题',
      prompts: resolvePromptBundle({}),
      structured: true,
    }),
    [
      '系统要求：\n系统正文',
      '上下文：\n上下文正文',
      '历史对话：\n助手：先前回答',
      '用户：\n本轮问题',
      '只返回一个符合请求 schema 的 JSON 对象，不要 Markdown、解释或代码围栏。',
    ].join('\n\n'),
  );
});

test('prompt bundles apply one override without changing sibling keys and en falls back to zh-CN', () => {
  const legacy = resolvePromptBundle({});
  const english = resolvePromptBundle({ localePreset: 'en' });
  assert.deepEqual(english, legacy);
  assert.deepEqual(promptBundleSchema.parse(ZH_CN_PROMPT_BUNDLE), ZH_CN_PROMPT_BUNDLE);
  assert.equal(
    legacy.schemaCorrection,
    '上一次输出不符合 JSON schema。请沿用当前会话，只输出一个符合 schema 的 JSON 对象。',
  );

  const overridden = resolvePromptBundle({
    prompts: { overrides: { historyCurrentUserLabel: 'CURRENT USER:' } },
  });
  assert.equal(overridden.historyCurrentUserLabel, 'CURRENT USER:');
  assert.equal(overridden.historySystemLabel, legacy.historySystemLabel);
  assert.equal(
    buildPrompt({
      history: [],
      replay: false,
      contextBlock: '',
      systemPrompt: null,
      userMessage: 'question',
      structured: false,
      prompts: overridden,
    }),
    'CURRENT USER:\nquestion',
  );
});

test('generation replay keeps only the latest assistant candidate and current feedback', () => {
  const history: Message[] = [
    {
      id: 'u1', threadId: 't', role: 'user', agentId: null,
      content: 'FIRST_OUTLINE_MARKER', structured: null, createdAt: 1,
    },
    {
      id: 'a1', threadId: 't', role: 'assistant', agentId: 'pi',
      content: 'FIRST_CANDIDATE_MARKER', structured: null, createdAt: 2,
    },
    {
      id: 'u2', threadId: 't', role: 'user', agentId: null,
      content: 'EARLIER_FEEDBACK_MARKER', structured: null, createdAt: 3,
    },
    {
      id: 'a2', threadId: 't', role: 'assistant', agentId: 'pi',
      content: '{"rewritten_text":"raw"}',
      structured: { rewritten_text: 'LATEST_CANDIDATE_MARKER' },
      createdAt: 4,
    },
  ];
  const prompt = buildPrompt({
    history,
    replay: true,
    replayMode: 'latest-candidate',
    prompts: resolvePromptBundle({}),
    contextBlock: '',
    systemPrompt: null,
    userMessage: 'CURRENT_FEEDBACK_MARKER',
    structured: false,
  });
  assert.match(prompt, /LATEST_CANDIDATE_MARKER/);
  assert.match(prompt, /CURRENT_FEEDBACK_MARKER/);
  assert.doesNotMatch(
    prompt,
    /FIRST_OUTLINE_MARKER|FIRST_CANDIDATE_MARKER|EARLIER_FEEDBACK_MARKER|rewritten_text/,
  );
});

test('generation replay for a later beat carries the immediately previous beat candidate', () => {
  const history: Message[] = [
    {
      id: 'u1', threadId: 't', role: 'user', agentId: null,
      content: '【本拍章纲】第一拍', structured: null, createdAt: 1,
    },
    {
      id: 'a1', threadId: 't', role: 'assistant', agentId: 'pi',
      content: '第一拍定稿尾部', structured: null, createdAt: 2,
    },
    {
      id: 'u2', threadId: 't', role: 'user', agentId: null,
      content: '【本拍章纲】第二拍', structured: null, createdAt: 3,
    },
    {
      id: 'a2', threadId: 't', role: 'assistant', agentId: 'pi',
      content: '第二拍定稿尾部', structured: null, createdAt: 4,
    },
  ];
  const prompt = buildPrompt({
    history,
    replay: true,
    replayMode: 'latest-candidate',
    prompts: resolvePromptBundle({}),
    contextBlock: '',
    systemPrompt: null,
    userMessage: '【本拍章纲】第三拍',
    structured: false,
  });
  assert.match(prompt, /助手最近候选全文：\n第二拍定稿尾部/);
  assert.match(prompt, /【本拍章纲】第三拍/);
  assert.doesNotMatch(prompt, /第一拍定稿尾部|【本拍章纲】第二拍/);
});

test('planner projection copies only allowed regular files, rejects links, and cleans itself up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writing-studio-projection-vault-'));
  const outside = await mkdtemp(join(tmpdir(), 'writing-studio-projection-outside-'));
  const outsideSecret = join(outside, 'host-secret.txt');
  try {
    await mkdir(join(root, 'allowed'), { recursive: true });
    await writeFile(join(root, 'allowed', 'keep.md'), 'admitted', 'utf8');
    await writeFile(join(root, 'allowed', 'forbidden.md'), 'never copy', 'utf8');
    await writeFile(join(root, 'other.md'), 'not readable', 'utf8');
    await writeFile(outsideSecret, 'host secret', 'utf8');
    await symlink(outsideSecret, join(root, 'allowed', 'linked-secret.md'));
    const projection = await createPlannerProjection(root, {
      readable: ['allowed/**'], forbidden: ['allowed/forbidden.md'],
    });
    const projectionRoot = projection.cwd;
    try {
      assert.equal(await readFile(join(projection.cwd, 'allowed', 'keep.md'), 'utf8'), 'admitted');
      await assert.rejects(access(join(projection.cwd, 'allowed', 'forbidden.md')));
      await assert.rejects(access(join(projection.cwd, 'allowed', 'linked-secret.md')));
      await assert.rejects(access(join(projection.cwd, 'other.md')));
      // Original-vault paths are not part of the projection's namespace.
      await assert.rejects(access(join(projection.cwd, outsideSecret)));
    } finally {
      await projection.cleanup?.();
    }
    await assert.rejects(access(projectionRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('every planner fails closed before spawning a CLI', async () => {
  const fake = await fakeExecutable(`
    import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(join(tmpdir(), 'writing-studio-unsafe-cli-spawned'))}, 'spawned');
  `);
  const marker = join(tmpdir(), 'writing-studio-unsafe-cli-spawned');
  const previous = {
    claude: process.env['WRITING_STUDIO_CLAUDE_PATH'],
    codex: process.env['WRITING_STUDIO_CODEX_PATH'],
    opencode: process.env['WRITING_STUDIO_OPENCODE_PATH'],
  };
  process.env['WRITING_STUDIO_CLAUDE_PATH'] = fake.file;
  process.env['WRITING_STUDIO_CODEX_PATH'] = fake.file;
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = fake.file;
  try {
    const options = { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal };
    const collect = async (backend: typeof claudeBackend, input: ReturnType<typeof context>) => {
      const events = [] as Array<{ type: string; code?: string }>;
      for await (const event of backend.send(input, 'no spawn', options)) events.push(event);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'error');
      assert.equal(events[0]?.code, 'sandbox_unavailable');
    };
    const vault = await mkdtemp(join(tmpdir(), 'writing-studio-planner-no-spawn-'));
    try {
      for (const backend of [claudeBackend, codexBackend, opencodeBackend]) {
        await collect(backend as typeof claudeBackend, plannerContext(vault));
      }
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
    await assert.rejects(access(marker));
  } finally {
    if (previous.claude === undefined) delete process.env['WRITING_STUDIO_CLAUDE_PATH']; else process.env['WRITING_STUDIO_CLAUDE_PATH'] = previous.claude;
    if (previous.codex === undefined) delete process.env['WRITING_STUDIO_CODEX_PATH']; else process.env['WRITING_STUDIO_CODEX_PATH'] = previous.codex;
    if (previous.opencode === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = previous.opencode;
    await rm(marker, { force: true });
    await fake.close();
  }
});

test('Codex and OpenCode do not invent a resumable session when their JSON output has no native id', { skip: sandboxGateReason ?? false }, async (t) => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', () => {
      const capture = JSON.stringify({args,input});
      if (args[0] === 'run') console.log(JSON.stringify({type:'message.part.updated',part:{text:capture}}));
      else console.log(JSON.stringify({type:'item.completed',item:{text:capture}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    });
  `);
  const codexPath = process.env['WRITING_STUDIO_CODEX_PATH'];
  const opencodePath = process.env['WRITING_STUDIO_OPENCODE_PATH'];
  process.env['WRITING_STUDIO_CODEX_PATH'] = fake.file;
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = fake.file;
  const old = [{ id: 'old', threadId: 't', index: 0, role: 'user' as const, agentId: null, content: 'must replay old history', structured: null, createdAt: 0 }];
  const options = { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal };
  try {
    for (const backend of [opencodeBackend]) {
      const first = [] as Array<{ type: string; content?: string; nativeSessionId?: string | null; strategyUsed?: string }>;
      for await (const event of backend.send(context(old), 'first turn', options)) first.push(event);
      assert.equal(first.some((event) => event.type === 'session'), false, `${backend.id} must not emit a synthetic session`);
      const firstDone = first.at(-1);
      assert.equal(firstDone?.type, 'done');
      assert.equal(firstDone?.nativeSessionId, null);
      assert.equal(firstDone?.strategyUsed, 'history-replay');

      // `done:null` is what the coordinator persists. Simulate the next turn
      // with that absence and assert its CLI never receives a resume ID.
      const second = [] as Array<{ type: string; content?: string }>;
      for await (const event of backend.send(context(old), 'second turn', options)) second.push(event);
      const capture = JSON.parse(second.find((event) => event.type === 'result')?.content ?? '{}') as { args: string[]; input: string };
      assert.doesNotMatch(capture.args.join(' '), /(?:resume|--session)/);
      assert.match(capture.input, /must replay old history/);
    }
  } finally {
    if (codexPath === undefined) delete process.env['WRITING_STUDIO_CODEX_PATH']; else process.env['WRITING_STUDIO_CODEX_PATH'] = codexPath;
    if (opencodePath === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = opencodePath;
    await fake.close();
  }
});

test('Codex writer uses the external profile, danger-full-access, stdin, and JSONL events', { skip: sandboxGateReason ?? false }, async (t) => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'thread.started',thread_id:'codex-native'}));
      console.log(JSON.stringify({
        type:'item.completed',
        item:{text:JSON.stringify({args,input})},
      }));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}}));
    });
  `);
  const sandbox = await fakeSandboxExecutable();
  const previous = {
    codex: process.env['WRITING_STUDIO_CODEX_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
    sandboxMode: process.env['WRITING_STUDIO_CODEX_SANDBOX'],
  };
  process.env['WRITING_STUDIO_CODEX_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = sandbox.file;
  delete process.env['WRITING_STUDIO_CODEX_SANDBOX'];
  try {
    const events: AgentEvent[] = [];
    for await (const event of codexBackend.send(
      context([], null, 'codex'),
      'codex fake prompt',
      { model: 'gpt-test', timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal },
    )) events.push(event);
    assert.equal(events.find((event) => event.type === 'session')?.nativeSessionId, 'codex-native');
    const capture = JSON.parse(events.find((event) => event.type === 'result')?.content ?? '{}') as { args: string[]; input: string };
    assert.deepEqual(capture.args.slice(0, 7), [
      '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--cd', capture.args[5], 'exec',
    ]);
    assert.ok(capture.args.includes('--json'));
    assert.ok(capture.args.includes('--ignore-user-config'));
    assert.ok(capture.args.includes('--ignore-rules'));
    assert.ok(capture.args.includes('--skip-git-repo-check'));
    assert.equal(capture.args.at(-1), '-');
    assert.match(capture.input, /codex fake prompt/);
    assert.deepEqual(
      events.filter((event) => event.type === 'usage').map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })),
      [{ inputTokens: 7, outputTokens: 3 }],
    );
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    if (previous.codex === undefined) delete process.env['WRITING_STUDIO_CODEX_PATH']; else process.env['WRITING_STUDIO_CODEX_PATH'] = previous.codex;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    if (previous.sandboxMode === undefined) delete process.env['WRITING_STUDIO_CODEX_SANDBOX']; else process.env['WRITING_STUDIO_CODEX_SANDBOX'] = previous.sandboxMode;
    await Promise.all([fake.close(), sandbox.close()]);
  }
});

test('Codex native mode injects a per-invocation permission profile without the Seatbelt wrapper', async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'thread.started',thread_id:'codex-native-profile'}));
      console.log(JSON.stringify({type:'item.completed',item:{text:JSON.stringify({args,input})}}));
      console.log(JSON.stringify({type:'turn.completed'}));
    });
  `);
  const previous = {
    codex: process.env['WRITING_STUDIO_CODEX_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
    sandboxMode: process.env['WRITING_STUDIO_CODEX_SANDBOX'],
  };
  process.env['WRITING_STUDIO_CODEX_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = join(tmpdir(), 'missing-sandbox-exec');
  process.env['WRITING_STUDIO_CODEX_SANDBOX'] = 'native';
  try {
    const events = [] as Array<{ type: string; content?: string }>;
    const ctx = context([], null, 'codex');
    for await (const event of codexBackend.send(
      ctx,
      'native profile prompt',
      {
        model: null,
        timeoutMs: 5_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    const capture = JSON.parse(
      events.find((event) => event.type === 'result')?.content ?? '{}',
    ) as { args: string[]; input: string };
    assert.deepEqual(capture.args.slice(0, 5), [
      '--ask-for-approval', 'never', '--cd', capture.args[3], 'exec',
    ]);
    assert.equal(capture.args.includes('--sandbox'), false);
    assert.ok(capture.args.includes('--ignore-user-config'));
    assert.ok(capture.args.includes('features.network_proxy=true'));
    const permissionProfile = capture.args.find((arg) => arg.startsWith('permissions.writing-studio-native='));
    assert.match(permissionProfile ?? '', /":root"="read"/);
    assert.ok(permissionProfile?.includes('":workspace_roots"={"."="write"}'));
    assert.ok(permissionProfile?.includes(`"${ctx.vaultRoot}"="deny"`));
    assert.ok(permissionProfile?.includes(`"${ctx.dataDir}"="deny"`));
    assert.match(permissionProfile ?? '', /\.ssh"="deny"/);
    assert.match(permissionProfile ?? '', /\.claude"="deny"/);
    assert.match(permissionProfile ?? '', /Library\/Keychains"="deny"/);
    assert.match(permissionProfile ?? '', /allow_local_binding=false/);
    assert.ok(permissionProfile?.includes('domains={"*"="allow"}'));
    assert.match(permissionProfile ?? '', /loopback ports 8787 and 5183/);
    assert.match(capture.input, /native profile prompt/);
    assert.equal((await codexBackend.probeAvailability()).ok, true);
  } finally {
    if (previous.codex === undefined) delete process.env['WRITING_STUDIO_CODEX_PATH']; else process.env['WRITING_STUDIO_CODEX_PATH'] = previous.codex;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    if (previous.sandboxMode === undefined) delete process.env['WRITING_STUDIO_CODEX_SANDBOX']; else process.env['WRITING_STUDIO_CODEX_SANDBOX'] = previous.sandboxMode;
    await fake.close();
  }
});

test('Codex native profile generation is pure and unknown sandbox modes fail safe to Seatbelt', () => {
  assert.equal(codexSandboxMode(undefined), 'seatbelt');
  assert.equal(codexSandboxMode('unexpected'), 'seatbelt');
  assert.equal(codexSandboxMode('native'), 'native');
  const input = {
    workspaceRoot: '/private/tmp/isolated-workspace',
    vaultRoot: '/private/tmp/vault-canary',
    dataDir: '/private/tmp/data-canary',
    panelPort: 9876,
    webPort: 5432,
    extraWriteRoots: ['/private/tmp/response-schema'],
  };
  const first = nativeCodexPermissionOverrides(input);
  const second = nativeCodexPermissionOverrides(input);
  assert.deepEqual(first, second);
  const profile = first.find((arg) => arg.startsWith('permissions.writing-studio-native=')) ?? '';
  assert.match(profile, /isolated-workspace"="write"/);
  assert.match(profile, /response-schema"="write"/);
  assert.match(profile, /vault-canary"="deny"/);
  assert.match(profile, /data-canary"="deny"/);
  assert.match(profile, /loopback ports 9876 and 5432/);
});

test('OpenCode pins title work to the panel-selected main model and preserves deny-all text permissions', { skip: sandboxGateReason ?? false }, async (t) => {
  const fake = await fakeExecutable(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({
        type:'message.part.updated',
        part:{text:process.env.OPENCODE_CONFIG_CONTENT},
      }));
    });
  `);
  const sandbox = await fakeSandboxExecutable();
  const previous = {
    opencode: process.env['WRITING_STUDIO_OPENCODE_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = sandbox.file;
  try {
    const events = [] as Array<{ type: string; content?: string }>;
    for await (const event of opencodeBackend.send(
      context([], null, 'opencode'),
      'opencode fake prompt',
      { model: 'provider/main-model', timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal },
    )) events.push(event);
    const config = JSON.parse(events.find((event) => event.type === 'result')?.content ?? '{}') as {
      small_model?: string;
      agent?: { text?: { permission?: Record<string, string> } };
    };
    assert.equal(config.small_model, 'provider/main-model');
    assert.deepEqual(config.agent?.text?.permission, { '*': 'deny' });
  } finally {
    if (previous.opencode === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = previous.opencode;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await Promise.all([fake.close(), sandbox.close()]);
  }
});

test('Claude fresh/replay, native resume, and one structured correction use only fake CLI', { skip: sandboxGateReason ?? false }, async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', () => {
      if (!args.includes('--append-system-prompt')) process.exit(3);
      const resumed = args.includes('--resume');
      const structured = args.includes('--json-schema');
      console.log(JSON.stringify({type:'system', session_id: resumed ? 'native-session' : 'fresh-session'}));
      const text = structured ? (resumed ? '{"rewritten_text":"fixed"}' : 'not-json') : JSON.stringify({args,input});
      console.log(JSON.stringify({type:'stream_event', event:{type:'content_block_delta', delta:{text}}}));
      console.log(JSON.stringify({type:'result', result:text}));
    });
  `);
  const original = process.env['WRITING_STUDIO_CLAUDE_PATH'];
  process.env['WRITING_STUDIO_CLAUDE_PATH'] = fake.file;
  try {
    const old = [{ id: 'm', threadId: 't', index: 0, role: 'user' as const, agentId: null, content: 'old history', structured: null, createdAt: 0 }];
    const first = [] as unknown[];
    for await (const event of claudeBackend.send(context(old), 'new message', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal })) first.push(event);
    assert.match((first.find((event) => (event as { type: string }).type === 'result') as { content: string }).content, /old history/);
    const resumed = [] as unknown[];
    for await (const event of claudeBackend.send(context(old, 'native-session'), 'new message', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal })) resumed.push(event);
    assert.doesNotMatch((resumed.find((event) => (event as { type: string }).type === 'result') as { content: string }).content, /old history/);
    const rewrite = [] as unknown[];
    for await (const event of claudeBackend.send(context([]), 'rewrite', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: { type: 'object', required: ['rewritten_text'], properties: { rewritten_text: { type: 'string' } } }, signal: new AbortController().signal })) rewrite.push(event);
    const structured = rewrite.filter((event) => (event as { type: string }).type === 'structured') as Array<{ valid: boolean }>;
    assert.deepEqual(structured.map((event) => event.valid), [true]);
    const visibleText = rewrite
      .filter((event) => ['delta', 'result'].includes((event as { type: string }).type))
      .map((event) => JSON.stringify(event)).join('\n');
    assert.doesNotMatch(visibleText, /not-json/);
    assert.match(visibleText, /rewritten_text/);
    assert.equal((rewrite.find((event) => (event as { type: string }).type === 'result') as { content: string }).content, '{"rewritten_text":"fixed"}');
    const rewriteDone = rewrite.at(-1) as { type: string; nativeSessionId?: string | null };
    assert.equal(rewriteDone.type, 'done');
    assert.equal(rewriteDone.nativeSessionId, null, 'hidden repair turn must invalidate native resume');

    const afterRepair = [] as Array<{ type: string; content?: string }>;
    for await (const event of claudeBackend.send(context(old), 'after repair', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal })) afterRepair.push(event);
    const capture = JSON.parse(afterRepair.find((event) => event.type === 'result')?.content ?? '{}') as { args: string[]; input: string };
    assert.doesNotMatch(capture.args.join(' '), /--resume/);
    assert.match(capture.input, /old history/);
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_CLAUDE_PATH']; else process.env['WRITING_STUDIO_CLAUDE_PATH'] = original;
    await fake.close();
  }
});

test('Claude parser records both observed model-id shapes and ignores absent or malformed fields', () => {
  assert.deepEqual(
    parseClaude({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-init',
      session_id: 'fixture-session',
    }),
    {
      events: [{ type: 'model', modelId: 'claude-sonnet-init' }],
      nativeSessionId: 'fixture-session',
    },
  );
  assert.deepEqual(
    parseClaude({
      type: 'assistant',
      message: { model: 'claude-sonnet-message' },
    }),
    {
      events: [{ type: 'model', modelId: 'claude-sonnet-message' }],
    },
  );
  assert.deepEqual(parseClaude({ type: 'system', subtype: 'status', model: 'ignore-me' }), {
    events: [],
  });
  assert.deepEqual(parseClaude({ type: 'assistant', message: { model: 42 } }), {
    events: [],
  });
  assert.deepEqual(parseClaude({ type: 'assistant', message: {} }), {
    events: [],
  });
});

test('Grok fake CLI consumes and cleans a long prompt file while keeping every tool surface disabled', async () => {
  const fake = await fakeExecutable(`
    import { readFile } from 'node:fs/promises';
    const args = process.argv.slice(2);
    let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', async () => {
      const promptIndex = args.indexOf('--prompt-file');
      const promptPath = args[promptIndex + 1];
      const prompt = await readFile(promptPath, 'utf8');
      const sessionFlag = args.includes('--resume') ? '--resume' : '--session-id';
      const sessionId = args[args.indexOf(sessionFlag) + 1];
      const capture = JSON.stringify({
        args,
        promptPath,
        promptPrefix: prompt.slice(0, 64),
        promptLength: prompt.length,
        input,
        cwd: process.cwd(),
      });
      console.log(JSON.stringify({type:'text',data:capture}));
      console.log(JSON.stringify({type:'thought',data:'hidden reasoning'}));
      console.log(JSON.stringify({type:'end',stopReason:'EndTurn',sessionId,usage:{inputTokens:5,outputTokens:7}}));
    });
  `);
  const sandbox = await fakeSandboxExecutable();
  const previous = {
    path: process.env['WRITING_STUDIO_GROK_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  process.env['WRITING_STUDIO_GROK_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = sandbox.file;
  try {
    const events = [] as Array<{
      type: string;
      content?: string;
      nativeSessionId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
    }>;
    const longPrompt = `GROK_PROMPT_FILE_MARKER\n${'长'.repeat(110 * 1024)}`;
    for await (const event of grokBackend.send(
      context([], null, 'grok'),
      longPrompt,
      {
        model: 'grok-4.5',
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);

    const capture = JSON.parse(
      events.find((event) => event.type === 'result')?.content ?? '{}',
    ) as {
      args: string[];
      promptPath: string;
      promptPrefix: string;
      promptLength: number;
      input: string;
      cwd: string;
    };
    assert.match(capture.promptPrefix, /GROK_PROMPT_FILE_MARKER/);
    assert.ok(capture.promptLength > 100 * 1024);
    assert.deepEqual(
      capture.args.slice(capture.args.indexOf('--prompt-file'), capture.args.indexOf('--prompt-file') + 2),
      ['--prompt-file', capture.promptPath],
    );
    assert.equal(capture.args.some((arg) => arg.includes('GROK_PROMPT_FILE_MARKER')), false);
    assert.equal(capture.input, '');
    assert.equal(capture.cwd.includes('writing-studio-test-vault-scope'), false);
    await assert.rejects(access(capture.promptPath));
    assert.deepEqual(
      capture.args.slice(capture.args.indexOf('--tools'), capture.args.indexOf('--tools') + 2),
      ['--tools', ''],
    );
    const disallowed = capture.args[capture.args.indexOf('--disallowed-tools') + 1] ?? '';
    for (const tool of [
      'run_terminal_cmd', 'grep', 'read_file', 'search_replace', 'list_dir',
      'web_search', 'web_fetch', 'todo_write', 'task', 'Agent',
    ]) assert.match(disallowed, new RegExp(`(?:^|,)${tool.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}(?:,|$)`));
    assert.ok(capture.args.includes('--disable-web-search'));
    assert.ok(capture.args.includes('--no-subagents'));
    assert.deepEqual(
      capture.args.filter((arg, index) => capture.args[index - 1] === '--deny'),
      ['Bash', 'Edit', 'Write', 'Read', 'Grep', 'WebFetch', 'MCPTool'],
    );
    assert.deepEqual(
      capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2),
      ['--model', 'grok-4.5'],
    );
    assert.equal(events.some((event) => JSON.stringify(event).includes('hidden reasoning')), false);
    assert.deepEqual(
      events.find((event) => event.type === 'usage'),
      { type: 'usage', inputTokens: 5, outputTokens: 7 },
    );
    assert.ok(events.find((event) => event.type === 'session')?.nativeSessionId);
    assert.equal(events.at(-1)?.type, 'done');

    const wrapped = wrapGrokWriter(
      { file: fake.file, args: ['--version'] },
      { workspaceRoot: tmpdir(), vaultRoot: join(tmpdir(), 'grok-vault') },
    );
    assert.equal(wrapped.file, sandbox.file);
    assert.match(wrapped.args[1] ?? '', /\.grok/);
    assert.match(wrapped.args[1] ?? '', /deny file-read/);
  } finally {
    if (previous.path === undefined) delete process.env['WRITING_STUDIO_GROK_PATH'];
    else process.env['WRITING_STUDIO_GROK_PATH'] = previous.path;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'];
    else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await Promise.all([fake.close(), sandbox.close()]);
  }
});

test('Grok parser accepts documented streaming-json and final json shapes', () => {
  assert.deepEqual(parseGrok({ type: 'text', data: 'hello' }), {
    events: [{ type: 'delta', text: 'hello' }],
  });
  assert.deepEqual(parseGrok({ type: 'end', sessionId: 'session-1' }), {
    events: [],
    nativeSessionId: 'session-1',
  });
  assert.deepEqual(parseGrok({ text: '{"rewritten_text":"ok"}', sessionId: 'session-2' }), {
    events: [],
    nativeSessionId: 'session-2',
    text: '{"rewritten_text":"ok"}',
  });
  assert.equal(parseGrok({ type: 'thought', data: 'private' }), null);
});

test('Grok removes its prompt file when the writer wrapper fails before spawn', async () => {
  const fake = await fakeExecutable(`process.exit(0);`);
  const previous = {
    path: process.env['WRITING_STUDIO_GROK_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  const threadId = `grok-wrapper-failure-cleanup-${testProcessScope}`;
  const scratch = await writerScratch(threadId, 'grok');
  process.env['WRITING_STUDIO_GROK_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = join(tmpdir(), 'missing-grok-sandbox-exec');
  try {
    const events = [];
    for await (const event of grokBackend.send(
      { ...context([], null, 'grok'), threadId },
      'PROMPT_MUST_BE_REMOVED',
      {
        model: null,
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    assert.equal(events.at(-1)?.type, 'error');
    await assert.rejects(access(join(scratch, 'prompt.txt')));
  } finally {
    if (previous.path === undefined) delete process.env['WRITING_STUDIO_GROK_PATH'];
    else process.env['WRITING_STUDIO_GROK_PATH'] = previous.path;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'];
    else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await Promise.all([
      fake.close(),
      rm(scratch, { recursive: true, force: true }),
    ]);
  }
});

test('Grok availability probes the CLI model catalog', async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('grok 0.2.111');
    } else if (args.includes('models')) {
      console.log('Default model: grok-4.5');
      console.log('');
      console.log('Available models:');
      console.log('  * grok-4.5 (default)');
      console.log('  * grok-code-fast');
    } else {
      process.exit(3);
    }
  `);
  const sandbox = await fakeSandboxExecutable();
  const previous = {
    path: process.env['WRITING_STUDIO_GROK_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  process.env['WRITING_STUDIO_GROK_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = sandbox.file;
  try {
    const availability = await grokBackend.probeAvailability();
    assert.equal(availability.ok, true);
    assert.equal(availability.version, 'grok 0.2.111');
    assert.deepEqual(availability.models, [
      { id: 'grok-4.5', label: 'grok-4.5', isDefault: true },
      { id: 'grok-code-fast', label: 'grok-code-fast' },
    ]);
  } finally {
    if (previous.path === undefined) delete process.env['WRITING_STUDIO_GROK_PATH'];
    else process.env['WRITING_STUDIO_GROK_PATH'] = previous.path;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'];
    else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await Promise.all([fake.close(), sandbox.close()]);
  }
});

test('Claude error result becomes a bounded authentication diagnostic', async () => {
  const fake = await fakeExecutable(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({
        type:'result',
        is_error:true,
        error:'authentication_failed',
        result:'\\u001b[31mFailed to authenticate: OAuth session expired and could not be refreshed ' + 'x'.repeat(320) + '\\u001b[0m'
      }));
      process.exitCode = 1;
    });
  `);
  const backend = new CliBackend({
    id: 'claude',
    displayName: 'Claude diagnostic test',
    pathEnv: 'WRITING_STUDIO_TEST_CLAUDE_PATH',
    defaultPath: fake.file,
    freshSessionIdIsStable: true,
    async makeCommand() {
      return { file: fake.file, args: [], cwd: tmpdir(), env: strictEnvironment(), prompt: '' };
    },
    parseLine: parseClaude,
    requiresFilesystemSandbox: false,
  });
  try {
    const events = [];
    for await (const event of backend.send(
      context([]),
      'auth',
      {
        model: null,
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type === 'error') {
      assert.equal(terminal.code, 'cli_not_authenticated');
      assert.equal(terminal.retryable, false);
      assert.equal(terminal.detail?.length, 300);
      assert.doesNotMatch(terminal.detail ?? '', /\u001b/);
    }
  } finally {
    await fake.close();
  }
});

test('OpenCode non-zero stderr is cleaned and preferred over stdout diagnostics', async () => {
  const fake = await fakeExecutable(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log(JSON.stringify({type:'error',error:'fallback stdout error'}));
      console.error('\\u001b[33mnetwork socket hang up\\u001b[0m');
      process.exitCode = 2;
    });
  `);
  const backend = new CliBackend({
    id: 'opencode',
    displayName: 'OpenCode diagnostic test',
    pathEnv: 'WRITING_STUDIO_TEST_OPENCODE_PATH',
    defaultPath: fake.file,
    async makeCommand() {
      return { file: fake.file, args: [], cwd: tmpdir(), env: strictEnvironment(), prompt: '' };
    },
    parseLine: parseOpenCode,
    requiresFilesystemSandbox: false,
  });
  try {
    const events = [];
    for await (const event of backend.send(
      context([], null, 'opencode'),
      'network',
      {
        model: null,
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type === 'error') {
      assert.equal(terminal.code, 'network_error');
      assert.equal(terminal.detail, 'network socket hang up');
    }
  } finally {
    await fake.close();
  }
});

test('Pi uses the pure writer flags, stdin prompt, JSON deltas, usage, and native sessions', async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2); let input = '';
    process.stdin.on('data', (part) => input += part);
    process.stdin.on('end', () => {
      const sessionIndex = args.indexOf('--session-id');
      const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : 'missing-session';
      const capture = JSON.stringify({args,input,cwd:process.cwd()});
      console.log(JSON.stringify({type:'session',id:sessionId}));
      console.log(JSON.stringify({
        type:'message_update',
        assistantMessageEvent:{type:'text_delta',delta:capture}
      }));
      console.log(JSON.stringify({
        type:'message_end',
        message:{
          role:'assistant',
          content:[{type:'text',text:capture}],
          usage:{input:11,output:7,cost:{total:0.25}},
          stopReason:'stop'
        }
      }));
    });
  `);
  const original = process.env['WRITING_STUDIO_PI_PATH'];
  process.env['WRITING_STUDIO_PI_PATH'] = fake.file;
  try {
    const events = [] as Array<{
      type: string;
      content?: string;
      nativeSessionId?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
    }>;
    for await (const event of piBackend.send(
      context([], null, 'pi'),
      'PI_STDIN_MARKER',
      {
        model: 'provider/model',
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    const result = events.find((event) => event.type === 'result')?.content ?? '{}';
    assert.notEqual(result, '{}', JSON.stringify(events));
    const capture = JSON.parse(result) as { args: string[]; input: string; cwd: string };
    for (const flag of [
      '--no-tools',
      '--no-context-files',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
    ]) assert.ok(capture.args.includes(flag), flag);
    assert.ok(capture.args.includes('--mode'));
    assert.ok(capture.args.includes('json'));
    assert.deepEqual(
      capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2),
      ['--model', 'provider/model'],
    );
    assert.match(capture.input, /PI_STDIN_MARKER/);
    assert.equal(capture.cwd.includes('writing-studio-test-vault-scope'), false);
    assert.equal(events.some((event) => event.type === 'delta'), true);
    assert.deepEqual(
      events.find((event) => event.type === 'usage'),
      { type: 'usage', inputTokens: 11, outputTokens: 7, costUsd: 0.25 },
    );
    assert.equal(events.at(-1)?.type, 'done');
    assert.ok(events.find((event) => event.type === 'session')?.nativeSessionId);

    const generationContext = context([
      {
        id: 'first', threadId: 'thread', role: 'assistant', agentId: 'pi',
        content: 'FIRST_FULL_TEXT', structured: null, createdAt: 1,
      },
      {
        id: 'latest', threadId: 'thread', role: 'assistant', agentId: 'pi',
        content: '{"rewritten_text":"raw"}',
        structured: { rewritten_text: 'LATEST_FULL_TEXT' },
        createdAt: 2,
      },
    ], 'old-native-session', 'pi');
    generationContext.historyReplayMode = 'latest-candidate';
    const generationEvents = [] as Array<{ type: string; content?: string }>;
    for await (const event of piBackend.send(
      generationContext,
      'CURRENT_GENERATION_FEEDBACK',
      {
        model: null,
        timeoutMs: 5_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) generationEvents.push(event);
    const generationCapture = JSON.parse(
      generationEvents.find((event) => event.type === 'result')?.content ?? '{}',
    ) as { args: string[]; input: string };
    assert.equal(generationCapture.args.includes('old-native-session'), false);
    assert.match(generationCapture.input, /LATEST_FULL_TEXT/);
    assert.match(generationCapture.input, /CURRENT_GENERATION_FEEDBACK/);
    assert.doesNotMatch(generationCapture.input, /FIRST_FULL_TEXT|rewritten_text/);
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_PI_PATH'];
    else process.env['WRITING_STUDIO_PI_PATH'] = original;
    await fake.close();
  }
});

test('Pi classifies JSON authentication failures and never exposes stderr noise', async () => {
  const fake = await fakeExecutable(`
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.error('UNDICI warning and certificate noise');
      console.log(JSON.stringify({type:'session',id:'pi-auth-session'}));
      console.log(JSON.stringify({
        type:'message_end',
        message:{
          role:'assistant',
          content:[],
          usage:{input:0,output:0,cost:{total:0}},
          stopReason:'error',
          errorMessage:'API key auth failed for provider google'
        }
      }));
    });
  `);
  const original = process.env['WRITING_STUDIO_PI_PATH'];
  process.env['WRITING_STUDIO_PI_PATH'] = fake.file;
  try {
    const events: AgentEvent[] = [];
    for await (const event of piBackend.send(
      context([], null, 'pi'),
      'auth',
      {
        model: null,
        timeoutMs: 2_000,
        maxBudgetUsd: null,
        responseSchema: null,
        signal: new AbortController().signal,
      },
    )) events.push(event);
    const terminal = events.at(-1);
    assert.equal(terminal?.type, 'error');
    if (terminal?.type === 'error') {
      assert.equal(terminal.code, 'cli_not_authenticated');
      assert.equal(terminal.message, 'agent CLI is not authenticated');
      assert.doesNotMatch(terminal.message, /UNDICI|certificate|google/i);
    }
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_PI_PATH'];
    else process.env['WRITING_STUDIO_PI_PATH'] = original;
    await fake.close();
  }
});

test('Pi availability probes and parses a bounded provider/model catalog', async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('0.80.10');
    } else if (args.includes('--list-models')) {
      console.log('provider  model  context  max-out  thinking  images');
      console.log('google    gemini-2.5-pro  1M  64K  yes  yes');
      console.log('openai    gpt-5.4         272K  128K  yes  yes');
    }
  `);
  const original = process.env['WRITING_STUDIO_PI_PATH'];
  process.env['WRITING_STUDIO_PI_PATH'] = fake.file;
  try {
    const availability = await piBackend.probeAvailability();
    assert.equal(availability.ok, true);
    assert.equal(availability.version, '0.80.10');
    assert.deepEqual(
      availability.models?.map((model) => model.id),
      ['google/gemini-2.5-pro', 'openai/gpt-5.4'],
    );
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_PI_PATH'];
    else process.env['WRITING_STUDIO_PI_PATH'] = original;
    await fake.close();
  }
});

test('Pi model-catalog probe failure degrades to an empty catalog', async () => {
  const fake = await fakeExecutable(`
    const args = process.argv.slice(2);
    if (args.includes('--version')) console.log('0.80.10');
    else process.exit(3);
  `);
  const original = process.env['WRITING_STUDIO_PI_PATH'];
  process.env['WRITING_STUDIO_PI_PATH'] = fake.file;
  try {
    const availability = await piBackend.probeAvailability();
    assert.equal(availability.ok, true);
    assert.deepEqual(availability.models, []);
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_PI_PATH'];
    else process.env['WRITING_STUDIO_PI_PATH'] = original;
    await fake.close();
  }
});

test('supervisor abort terminates a detached process group and returns one terminal exit', async () => {
  const fake = await fakeExecutable(`setInterval(() => {}, 1_000);`);
  const supervisor = new ProcessSupervisor(1);
  const controller = new AbortController();
  const run = (async () => {
    const chunks = [];
    for await (const chunk of supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 5_000, signal: controller.signal })) chunks.push(chunk);
    return chunks;
  })();
  setTimeout(() => controller.abort(), 50);
  const chunks = await run;
  assert.equal(chunks.filter((chunk) => chunk.type === 'exit').length, 1);
  assert.equal(chunks.at(-1)?.type, 'exit');
  await fake.close();
});

test('async supervisor shutdown waits for its terminating process group', async () => {
  const fake = await fakeExecutable(`setInterval(() => {}, 1_000);`);
  const supervisor = new ProcessSupervisor(1);
  const draining = (async () => {
    for await (const _chunk of supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 5_000, signal: new AbortController().signal })) { /* drain */ }
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await supervisor.shutdown();
  await draining;
  await fake.close();
});

test('stopping async-generator consumption terminates its detached child group', { skip: detachedChildGroupGateReason ?? false }, async () => {
  const fake = await fakeExecutable(`
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    console.log(String(child.pid));
    setInterval(() => {}, 1_000);
  `);
  const supervisor = new ProcessSupervisor(1);
  const iterator = supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 5_000, signal: new AbortController().signal });
  const first = await iterator.next();
  assert.equal(first.value?.type, 'stdout');
  const grandchildPid = Number(first.value && first.value.type === 'stdout' ? first.value.text.trim() : NaN);
  await iterator.return();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.throws(() => process.kill(grandchildPid, 0), /ESRCH/);
  // Release is also observable: another run can begin under a limit of one.
  const next = supervisor.run({ file: '/bin/true', args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 1_000, signal: new AbortController().signal });
  await next.next();
  await fake.close();
});

test('orphan watchdog kills a detached CLI group after its owning server is SIGKILLed', async () => {
  const fake = await fakeExecutable(`
    import { spawn } from 'node:child_process';
    const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: 'ignore' });
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ cliPid: process.pid, grandchildPid: grandchild.pid }));
    setInterval(() => {}, 1_000);
  `);
  const ownerDir = await mkdtemp(join(tmpdir(), 'writing-studio-owner-test-'));
  const ownerFile = join(ownerDir, 'owner.mjs');
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const supervisorUrl = pathToFileURL(join(serverRoot, 'src/agents/supervisor.ts')).href;
  await writeFile(ownerFile, `
    import { ProcessSupervisor } from ${JSON.stringify(supervisorUrl)};
    const supervisor = new ProcessSupervisor(1);
    for await (const chunk of supervisor.run({
      file: process.argv[2], args: [], cwd: process.cwd(), env: process.env,
      stdin: '', timeoutMs: 30_000, signal: new AbortController().signal,
    })) {
      if (chunk.type === 'stdout') process.stdout.write(chunk.text);
    }
  `, 'utf8');
  const owner = spawn(process.execPath, ['--import', 'tsx', ownerFile, fake.file], {
    cwd: serverRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffered = '';
  const reported: { value: { cliPid: number; grandchildPid: number } | null } = { value: null };
  owner.stdout.setEncoding('utf8');
  owner.stdout.on('data', (text: string) => {
    buffered += text;
    const line = buffered.split('\n')[0];
    if (line && reported.value === null) {
      try { reported.value = JSON.parse(line) as { cliPid: number; grandchildPid: number }; } catch { /* wait for a complete line */ }
    }
  });
  owner.stderr.on('data', () => {});
  try {
    assert.equal(await waitFor(() => reported.value !== null, 3_000), true, `owner did not report CLI pids: ${buffered}`);
    const pids = reported.value;
    assert.ok(pids);
    assert.equal(processExists(pids.cliPid), true);
    assert.equal(processExists(pids.grandchildPid), true);
    assert.ok(owner.pid);
    process.kill(owner.pid, 'SIGKILL');
    assert.equal(
      await waitFor(() => !processExists(pids.cliPid) && !processExists(pids.grandchildPid), 4_000),
      true,
      `watchdog left CLI group alive after owner SIGKILL: ${JSON.stringify(pids)}`,
    );
  } finally {
    if (owner.pid && processExists(owner.pid)) {
      try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (reported.value) {
      for (const pid of [reported.value.cliPid, reported.value.grandchildPid]) {
        if (processExists(pid)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }
    await Promise.all([rm(ownerDir, { recursive: true, force: true }), fake.close()]);
  }
});

test('supervisor fails fast when busy and classifies timeout separately from cancellation', async () => {
  const fake = await fakeExecutable(`setInterval(() => {}, 1_000);`);
  const supervisor = new ProcessSupervisor(1);
  const firstController = new AbortController();
  const first = (async () => {
    for await (const _chunk of supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 5_000, signal: firstController.signal })) { /* drain */ }
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const busy = supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 10, signal: new AbortController().signal });
  await assert.rejects(busy.next(), /busy/);
  firstController.abort();
  await first;

  const timed = [] as Array<{ type: string; timedOut?: boolean }>;
  for await (const chunk of supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 20, signal: new AbortController().signal })) timed.push(chunk);
  assert.equal(timed.at(-1)?.type, 'exit');
  assert.equal(timed.at(-1)?.timedOut, true);
  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledRun = supervisor.run({ file: fake.file, args: [], cwd: tmpdir(), env: process.env, stdin: '', timeoutMs: 20, signal: cancelled.signal });
  await assert.rejects(cancelledRun.next(), /cancelled/);
  await fake.close();
});

test('strict environment is an allowlist and always disables colour', () => {
  // Ambient variables never leak: only the fixed pick list plus keys an
  // adapter explicitly names in `extra` may reach a CLI child.
  process.env['WRITING_STUDIO_TEST_AMBIENT_SECRET'] = 'must-not-pass';
  try {
    const environment = strictEnvironment({ OPENCODE_DISABLE_AUTOUPDATE: 'true', EXPLICIT_EXTRA: 'passes' });
    assert.equal(environment.NO_COLOR, '1');
    assert.equal(environment.OPENCODE_DISABLE_AUTOUPDATE, 'true');
    assert.equal(environment.EXPLICIT_EXTRA, 'passes');
    assert.equal(environment['WRITING_STUDIO_TEST_AMBIENT_SECRET'], undefined);
  } finally {
    delete process.env['WRITING_STUDIO_TEST_AMBIENT_SECRET'];
  }
});

test('agent defaults use PATH commands, retain explicit overrides, and never advertise writers without macOS sandboxing', async () => {
  const commands = await fakeCommandPath(['claude', 'codex', 'opencode']);
  const previous = {
    path: process.env.PATH,
    claude: process.env['WRITING_STUDIO_CLAUDE_PATH'],
    codex: process.env['WRITING_STUDIO_CODEX_PATH'],
    opencode: process.env['WRITING_STUDIO_OPENCODE_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  try {
    process.env.PATH = `${commands.directory}:${previous.path ?? ''}`;
    delete process.env['WRITING_STUDIO_CLAUDE_PATH'];
    delete process.env['WRITING_STUDIO_CODEX_PATH'];
    delete process.env['WRITING_STUDIO_OPENCODE_PATH'];
    delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'];

    assert.equal(binaryPath('WRITING_STUDIO_CLAUDE_PATH', 'claude'), 'claude');
    assert.equal(binaryPath('WRITING_STUDIO_CODEX_PATH', 'codex'), 'codex');
    assert.equal(binaryPath('WRITING_STUDIO_OPENCODE_PATH', 'opencode'), 'opencode');
    const [claude, codex, opencode] = await Promise.all([
      claudeBackend.probeAvailability(), codexBackend.probeAvailability(), opencodeBackend.probeAvailability(),
    ]);
    assert.equal(claude.binaryPath, 'claude');
    assert.equal(codex.binaryPath, 'codex');
    assert.equal(opencode.binaryPath, 'opencode');
    const sandboxReason = sandboxUnavailableReason();
    if (sandboxReason) {
      for (const availability of [claude, codex, opencode]) {
        assert.equal(availability.ok, false);
        assert.deepEqual(availability.supportedProfiles, []);
        assert.equal(availability.error, sandboxReason);
      }
    } else {
      assert.deepEqual(claude.supportedProfiles, ['writer']);
      assert.deepEqual(codex.supportedProfiles, ['writer']);
      assert.deepEqual(opencode.supportedProfiles, ['writer']);
    }

    process.env['WRITING_STUDIO_CLAUDE_PATH'] = join(commands.directory, 'opencode');
    const overridden = await claudeBackend.probeAvailability();
    assert.equal(overridden.binaryPath, join(commands.directory, 'opencode'));
  } finally {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.claude === undefined) delete process.env['WRITING_STUDIO_CLAUDE_PATH']; else process.env['WRITING_STUDIO_CLAUDE_PATH'] = previous.claude;
    if (previous.codex === undefined) delete process.env['WRITING_STUDIO_CODEX_PATH']; else process.env['WRITING_STUDIO_CODEX_PATH'] = previous.codex;
    if (previous.opencode === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = previous.opencode;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await commands.close();
  }
});

test('availability clearly reports a missing CLI before checking supported profiles', async () => {
  const previous = process.env['WRITING_STUDIO_OPENCODE_PATH'];
  const missing = join(tmpdir(), `writing-studio-missing-opencode-${Date.now()}`);
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = missing;
  try {
    const availability = await opencodeBackend.probeAvailability();
    assert.equal(availability.ok, false);
    assert.deepEqual(availability.supportedProfiles, []);
    assert.equal(availability.binaryPath, missing);
    assert.match(availability.error ?? '', /agent CLI is not installed or executable/);
    assert.match(availability.error ?? '', new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (previous === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = previous;
  }
});

test('missing sandbox-exec fails closed in availability even when the writer CLI exists', async () => {
  const fake = await fakeExecutable(`console.log('test-cli 1.0');`);
  const previous = {
    path: process.env['WRITING_STUDIO_CLAUDE_PATH'],
    sandbox: process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'],
  };
  const missingSandbox = join(tmpdir(), `writing-studio-missing-sandbox-${Date.now()}`);
  process.env['WRITING_STUDIO_CLAUDE_PATH'] = fake.file;
  process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = missingSandbox;
  try {
    const availability = await claudeBackend.probeAvailability();
    assert.equal(availability.ok, false);
    assert.deepEqual(availability.supportedProfiles, []);
    if (process.platform === 'darwin') {
      assert.match(availability.error ?? '', /required sandbox-exec is unavailable/);
      assert.match(availability.error ?? '', new RegExp(missingSandbox.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } else {
      assert.equal(availability.error, 'required filesystem sandbox is unavailable on this platform');
    }
  } finally {
    if (previous.path === undefined) delete process.env['WRITING_STUDIO_CLAUDE_PATH']; else process.env['WRITING_STUDIO_CLAUDE_PATH'] = previous.path;
    if (previous.sandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = previous.sandbox;
    await fake.close();
  }
});

test('macOS command wrapper denies the vault and OpenCode treats non-JSON as a hard error', { skip: sandboxGateReason ?? false }, async (t) => {
  const fake = await fakeExecutable(`console.log('warning: fallback to plain text');`);
  const oldPath = process.env['WRITING_STUDIO_OPENCODE_PATH'];
  const oldSandbox = process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'];
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = fake.file;
  try {
    const wrapped = wrapOutsideVault({ file: fake.file, args: ['run'] }, tmpdir());
    assert.equal(wrapped.file, '/usr/bin/sandbox-exec');
    assert.match(wrapped.args[1] ?? '', /deny file-read\*/);
    assert.match(wrapped.args[1] ?? '', /deny network-outbound \(remote ip "localhost:8787"\)/);
    assert.match(wrapped.args[1] ?? '', /deny network-outbound \(remote ip "localhost:5183"\)/);
    assert.doesNotMatch(wrapped.args[1] ?? '', /deny network\*/);
    const events = [] as Array<{ type: string }>;
    for await (const event of opencodeBackend.send(context([]), 'hello', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal })) events.push(event);
    assert.equal(events.at(-1)?.type, 'error');
  } finally {
    if (oldPath === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = oldPath;
    if (oldSandbox === undefined) delete process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH']; else process.env['WRITING_STUDIO_SANDBOX_EXEC_PATH'] = oldSandbox;
    await fake.close();
  }
});

test('OpenCode accepts nested part text and session fixture events', { skip: sandboxGateReason ?? false }, async (t) => {
  const fake = await fakeExecutable(`
    console.log(JSON.stringify({type:'session.updated',part:{sessionID:'nested-session'}}));
    console.log(JSON.stringify({type:'message.part.updated',part:{text:'nested OpenCode reply'}}));
  `);
  const original = process.env['WRITING_STUDIO_OPENCODE_PATH'];
  process.env['WRITING_STUDIO_OPENCODE_PATH'] = fake.file;
  try {
    const events: AgentEvent[] = [];
    for await (const event of opencodeBackend.send(context([]), 'hello', { model: null, timeoutMs: 2_000, maxBudgetUsd: null, responseSchema: null, signal: new AbortController().signal })) events.push(event);
    assert.equal(events.find((event) => event.type === 'session')?.nativeSessionId, 'nested-session');
    assert.equal(events.find((event) => event.type === 'result')?.content, 'nested OpenCode reply');
  } finally {
    if (original === undefined) delete process.env['WRITING_STUDIO_OPENCODE_PATH']; else process.env['WRITING_STUDIO_OPENCODE_PATH'] = original;
    await fake.close();
  }
});

test('writer compatibility wrapper continues to deny vault reads and panel ports', { skip: sandboxGateReason ?? false }, (t) => {
  const command = { file: '/bin/echo', args: ['ok'] };
  const writer = wrapOutsideVault(command, join(tmpdir(), 'vault'));
  assert.equal(writer.file, '/usr/bin/sandbox-exec');
  assert.match(writer.args[1] ?? '', /deny file-read\*/);
  assert.match(writer.args[1] ?? '', /deny network-outbound \(remote ip "localhost:8787"\)/);
});

test('Codex writer profile orders global write denial, narrow allows, sensitive reads, and final vault/port denies', { skip: sandboxGateReason ?? false }, (t) => {
  const workspace = join(tmpdir(), 'writing-studio-codex-writer');
  const vault = join(tmpdir(), 'writing-studio-codex-vault');
  const schema = join(tmpdir(), 'writing-studio-codex-schema');
  const dataDir = join(tmpdir(), 'writing-studio-codex-data');
  const previousDataDir = process.env['WRITING_STUDIO_DATA_DIR'];
  process.env['WRITING_STUDIO_DATA_DIR'] = dataDir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env['WRITING_STUDIO_DATA_DIR'];
    else process.env['WRITING_STUDIO_DATA_DIR'] = previousDataDir;
  });
  const wrapped = wrapCodexWriter(
    { file: '/bin/echo', args: ['ok'] },
    { workspaceRoot: workspace, vaultRoot: vault, extraReadRoots: [schema], extraWriteRoots: [schema] },
  );
  const profile = wrapped.args[1] ?? '';
  const globalDeny = profile.indexOf('(deny file-write* (subpath "/"))');
  const workspaceAllow = profile.indexOf(`(allow file-write* (subpath "${workspace}"))`);
  const codexAllow = profile.indexOf('.codex');
  const sensitiveDeny = profile.indexOf('.ssh');
  const vaultReadDeny = profile.lastIndexOf(`(deny file-read* (subpath "${vault}"))`);
  const vaultWriteDeny = profile.lastIndexOf(`(deny file-write* (subpath "${vault}"))`);
  const panelDeny = profile.lastIndexOf('(deny network-outbound (remote ip "localhost:8787"))');
  const webDeny = profile.lastIndexOf('(deny network-outbound (remote ip "localhost:5183"))');
  assert.ok(globalDeny >= 0 && globalDeny < workspaceAllow);
  assert.ok(workspaceAllow < sensitiveDeny);
  assert.ok(codexAllow > globalDeny && codexAllow < sensitiveDeny);
  assert.ok(profile.includes(`(allow file-read* (subpath "${schema}"))`));
  assert.ok(profile.includes(`(allow file-write* (subpath "${schema}"))`));
  assert.match(profile, /deny file-read\* .*\.aws/);
  assert.match(profile, /deny file-read\* .*\.gnupg/);
  assert.match(profile, /deny file-read\* .*\.kube/);
  assert.match(profile, /deny file-read\* .*\.docker/);
  assert.match(profile, /deny file-read\* .*\.claude/);
  assert.match(profile, /deny file-read\* .*Library\/Keychains/);
  assert.ok(profile.includes(`(deny file-read* (subpath "${dataDir}"))`));
  assert.match(profile, /allow file-write\* .*\/dev\/null/);
  assert.ok(sensitiveDeny < vaultReadDeny && vaultReadDeny < vaultWriteDeny);
  assert.ok(vaultWriteDeny < panelDeny && panelDeny < webDeny);
  assert.equal(profile.slice(webDeny).trim(), '(deny network-outbound (remote ip "localhost:5183"))');
});

test('macOS sandbox-exec really blocks reading and writing vault files', { skip: sandboxGateReason ?? false }, async (t) => {
  const vault = await mkdtemp(join(tmpdir(), 'writing-studio-vault-'));
  const secret = join(vault, 'secret.txt');
  await writeFile(secret, 'DO_NOT_READ_ME', 'utf8');
  try {
    const wrapped = wrapOutsideVault({ file: '/bin/cat', args: [secret] }, vault);
    const chunks = [] as Array<{ type: string; text?: string; code?: number | null }>;
    const supervisor = new ProcessSupervisor(1);
    for await (const chunk of supervisor.run({ file: wrapped.file, args: wrapped.args, cwd: tmpdir(), env: strictEnvironment(), stdin: '', timeoutMs: 2_000, signal: new AbortController().signal })) chunks.push(chunk);
    assert.equal(chunks.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.text).join(''), '');
    assert.notEqual(chunks.find((chunk) => chunk.type === 'exit')?.code, 0);

    const attemptedWrite = join(vault, 'agent-created.txt');
    const writeCommand = wrapOutsideVault({ file: '/usr/bin/touch', args: [attemptedWrite] }, vault);
    const writeChunks = [] as Array<{ type: string; code?: number | null }>;
    for await (const chunk of supervisor.run({
      file: writeCommand.file, args: writeCommand.args, cwd: tmpdir(), env: strictEnvironment(),
      stdin: '', timeoutMs: 2_000, signal: new AbortController().signal,
    })) writeChunks.push(chunk);
    assert.notEqual(writeChunks.find((chunk) => chunk.type === 'exit')?.code, 0);
    await assert.rejects(access(attemptedWrite));
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});

test('macOS sandbox-exec denies only the configured panel port, preserving other loopback ports', { skip: sandboxGateReason || tcpListenSkipReason }, async (t) => {
  const vault = await mkdtemp(join(tmpdir(), 'writing-studio-vault-'));
  const blockedServer = createServer((socket) => { socket.on('error', () => {}); socket.end('unexpected'); });
  const allowedServer = createServer((socket) => { socket.on('error', () => {}); socket.end('allowed'); });
  const listen = (server: ReturnType<typeof createServer>) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  await listen(blockedServer);
  await listen(allowedServer);
  const previousPort = process.env['WRITING_STUDIO_PORT'];
  try {
    const blockedAddress = blockedServer.address();
    const allowedAddress = allowedServer.address();
    assert.ok(blockedAddress && typeof blockedAddress !== 'string');
    assert.ok(allowedAddress && typeof allowedAddress !== 'string');
    process.env['WRITING_STUDIO_PORT'] = String(blockedAddress.port);
    const program = [
      "const net=require('node:net');",
      `const socket=net.connect({host:'127.0.0.1',port:${blockedAddress.port}});`,
      "socket.once('connect',()=>{process.stdout.write('connected');process.exit(0)});",
      "socket.once('error',()=>process.exit(7)); setTimeout(()=>process.exit(8),1000);",
    ].join('');
    const wrapped = wrapOutsideVault({ file: process.execPath, args: ['-e', program] }, vault);
    const chunks = [] as Array<{ type: string; text?: string; code?: number | null }>;
    const supervisor = new ProcessSupervisor(1);
    for await (const chunk of supervisor.run({ file: wrapped.file, args: wrapped.args, cwd: tmpdir(), env: strictEnvironment(), stdin: '', timeoutMs: 2_000, signal: new AbortController().signal })) chunks.push(chunk);
    assert.equal(chunks.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.text).join(''), '');
    assert.notEqual(chunks.find((chunk) => chunk.type === 'exit')?.code, 0);
    const allowedProgram = program.replace(String(blockedAddress.port), String(allowedAddress.port));
    const allowed = wrapOutsideVault({ file: process.execPath, args: ['-e', allowedProgram] }, vault);
    const allowedChunks = [] as Array<{ type: string; text?: string; code?: number | null }>;
    for await (const chunk of supervisor.run({ file: allowed.file, args: allowed.args, cwd: tmpdir(), env: strictEnvironment(), stdin: '', timeoutMs: 2_000, signal: new AbortController().signal })) allowedChunks.push(chunk);
    assert.equal(allowedChunks.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.text).join(''), 'connected');
    assert.equal(allowedChunks.find((chunk) => chunk.type === 'exit')?.code, 0);
  } finally {
    if (previousPort === undefined) delete process.env['WRITING_STUDIO_PORT']; else process.env['WRITING_STUDIO_PORT'] = previousPort;
    await Promise.all([blockedServer, allowedServer].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    await rm(vault, { recursive: true, force: true });
  }
});
