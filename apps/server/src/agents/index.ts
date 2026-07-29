import type { AgentBackend, AgentId } from '@writing-studio/contract';
import { claudeBackend } from './claude.js';
import { codexBackend } from './codex.js';
import { opencodeBackend } from './opencode.js';
import { piBackend } from './pi.js';
import { grokBackend } from './grok.js';
import { processSupervisor } from './supervisor.js';
import { echoBackend } from '../echo.js';

export { claudeBackend, codexBackend, opencodeBackend, piBackend, grokBackend, processSupervisor };

export const agentBackends: ReadonlyMap<AgentId, AgentBackend> = new Map([
  ['claude', claudeBackend],
  ['codex', codexBackend],
  ['opencode', opencodeBackend],
  ['pi', piBackend],
  ['grok', grokBackend],
  ['echo', echoBackend],
]);
