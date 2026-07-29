export const AGENT_IDS = ['claude', 'codex', 'opencode', 'pi', 'grok', 'echo'] as const;

export type AgentId = (typeof AGENT_IDS)[number];
