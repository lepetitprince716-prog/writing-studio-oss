/**
 * Echo backend: fake streaming agent used to exercise the full
 * REST-trigger → WS-stream pipeline without configuring a real adapter.
 * Emits the exact event sequence real adapters must produce:
 * session → delta* → (structured?) → result → done.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentBackend,
  AgentEvent,
  AgentAvailability,
  SendOptions,
  ThreadRunContext,
  RewriteResponse,
} from '@writing-studio/contract';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export const echoBackend: AgentBackend = {
  id: 'echo',
  displayName: 'Echo (联调假流)',

  probeAvailability(): Promise<AgentAvailability> {
    return Promise.resolve({
      agentId: 'echo',
      ok: true,
      supportedProfiles: ['writer', 'planner'],
      version: '0.1.0',
      binaryPath: '(builtin)',
      error: null,
    });
  },

  async *send(
    ctx: ThreadRunContext,
    userMessage: string,
    opts: SendOptions,
  ): AsyncIterable<AgentEvent> {
    const nativeSessionId = ctx.session?.nativeSessionId ?? randomUUID();
    yield { type: 'session', nativeSessionId };

    const wantRewrite = opts.responseSchema !== null;
    let canonSection: string | null = null;
    if (wantRewrite && ctx.contextBlock) {
      try {
        const parsed = JSON.parse(ctx.contextBlock) as {
          sources?: Array<{ path?: unknown; content?: unknown }>;
        };
        const source = parsed.sources?.find(
          (candidate) =>
            typeof candidate.path === 'string'
            && candidate.path.startsWith('canon-section:')
            && typeof candidate.content === 'string',
        );
        canonSection = typeof source?.content === 'string' ? source.content : null;
      } catch {
        canonSection = null;
      }
    }
    const reply = canonSection
      ? `${canonSection.trimEnd()}\n\n> echo 修补占位：${userMessage}\n`
      : wantRewrite
        ? `【echo 改写占位】${ctx.contextBlock ? '（已注入上下文块）' : ''}${userMessage}`
        : `【echo】收到消息（第 ${ctx.history.length + 1} 条）：${userMessage}`;

    let emitted = '';
    for (const char of reply) {
      if (opts.signal.aborted) {
        yield {
          type: 'done',
          stopReason: opts.signal.reason === 'timeout' ? 'timeout' : 'cancelled',
          nativeSessionId,
          strategyUsed: 'native-resume',
        };
        return;
      }
      emitted += char;
      yield { type: 'delta', text: char };
      await sleep(12);
    }

    if (wantRewrite) {
      const structured: RewriteResponse = {
        rewritten_text: emitted,
        notes: 'echo 占位改写，仅供联调',
      };
      yield { type: 'structured', data: structured, valid: true, raw: emitted };
    }

    yield { type: 'result', content: emitted };
    yield {
      type: 'done',
      stopReason: 'end_turn',
      nativeSessionId,
      strategyUsed: ctx.session ? 'native-resume' : 'history-replay',
    };
  },
};
