import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_IDS,
  agentModelIdSchema,
  type AgentBackend,
  type AgentId,
  type AgentModelOption,
} from '@writing-studio/contract';
import { z } from 'zod';
import { StudioError, asErrorMessage } from '../errors.js';

const modelOptionSchema = z.object({
  id: agentModelIdSchema,
  label: z.string().trim().min(1).max(120),
  isDefault: z.boolean().optional(),
}).strict();

const modelListSchema = z.array(modelOptionSchema).max(100).superRefine((models, ctx) => {
  const ids = new Set<string>();
  let defaults = 0;
  models.forEach((model, index) => {
    if (ids.has(model.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'id'],
        message: `duplicate model id: ${model.id}`,
      });
    }
    ids.add(model.id);
    if (model.isDefault) defaults += 1;
  });
  if (defaults > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'at most one model may be marked as default',
    });
  }
});

const catalogOverrideSchema = z.object({
  claude: modelListSchema.optional(),
  codex: modelListSchema.optional(),
  opencode: modelListSchema.optional(),
  pi: modelListSchema.optional(),
  grok: modelListSchema.optional(),
  echo: modelListSchema.optional(),
}).strict();

export type AgentModelCatalogs = Record<AgentId, AgentModelOption[]>;

const BUILTIN_CATALOGS: AgentModelCatalogs = {
  // Claude Code documents these stable aliases. Full dated model ids remain
  // available through the custom-id field or the local override file.
  claude: [
    { id: 'sonnet', label: 'Sonnet', isDefault: true },
    { id: 'opus', label: 'Opus' },
    { id: 'haiku', label: 'Haiku' },
  ],
  // Codex and OpenCode model names are provider/account dependent. Advertising
  // an empty list intentionally enables argv-safe custom ids without baking a
  // stale vendor catalog into the generic distribution.
  codex: [],
  opencode: [],
  pi: [],
  grok: [],
  // Echo ignores the value; the options exist so the selector and transport
  // can be exercised without invoking a paid CLI.
  echo: [
    { id: 'echo-1', label: 'Echo 1', isDefault: true },
    { id: 'echo-verbose', label: 'Echo verbose' },
  ],
};

function cloneCatalogs(catalogs: AgentModelCatalogs): AgentModelCatalogs {
  return {
    claude: catalogs.claude.map((model) => ({ ...model })),
    codex: catalogs.codex.map((model) => ({ ...model })),
    opencode: catalogs.opencode.map((model) => ({ ...model })),
    pi: catalogs.pi.map((model) => ({ ...model })),
    grok: catalogs.grok.map((model) => ({ ...model })),
    echo: catalogs.echo.map((model) => ({ ...model })),
  };
}

/**
 * Optional `data/agent-models.json` entries replace one agent's complete
 * built-in list. The file is local configuration, never copied into a vault.
 */
export function loadAgentModelCatalogs(dataDir: string): AgentModelCatalogs {
  const catalogs = cloneCatalogs(BUILTIN_CATALOGS);
  const path = join(dataDir, 'agent-models.json');
  if (!existsSync(path)) return catalogs;
  try {
    const overrides = catalogOverrideSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    for (const agentId of AGENT_IDS) {
      const override = overrides[agentId];
      if (override !== undefined) catalogs[agentId] = override.map((model) => ({ ...model }));
    }
    return catalogs;
  } catch (error) {
    throw new StudioError(
      'INVALID_CONFIG',
      `invalid agent model catalog: ${asErrorMessage(error)}`,
      { cause: error },
    );
  }
}

export function withAgentModelCatalogs(
  backends: ReadonlyMap<AgentId, AgentBackend>,
  catalogs: AgentModelCatalogs,
): Map<AgentId, AgentBackend> {
  return new Map([...backends].map(([agentId, backend]) => [
    agentId,
    {
      id: backend.id,
      displayName: backend.displayName,
      async probeAvailability() {
        const availability = await backend.probeAvailability();
        return {
          ...availability,
          models: (
            catalogs[agentId].length > 0
              ? catalogs[agentId]
              : availability.models ?? []
          ).map((model) => ({ ...model })),
        };
      },
      send: backend.send.bind(backend),
    } satisfies AgentBackend,
  ]));
}
