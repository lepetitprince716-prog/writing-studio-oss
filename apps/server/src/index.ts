import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { buildApp } from './app.js';
import { getPort } from './config.js';

type ProcessGuardLogger = Pick<FastifyBaseLogger, 'error'>;

type ProcessGuardListeners = {
  unhandledRejection: (reason: unknown) => void;
  uncaughtException: (error: Error) => void;
};

let installedProcessGuards: ProcessGuardListeners | undefined;

/** Return an actionable message for bind failures that users can resolve locally. */
export function describeListenFailure(error: unknown, port: number): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    return `port ${port} already in use — a previous writing-studio server may still be running; stop it or set WRITING_STUDIO_PORT`;
  }
  if (code === 'EACCES') {
    return `permission denied for port ${port} — choose an allowed port or set WRITING_STUDIO_PORT`;
  }
  return undefined;
}

/**
 * Keep unexpected process-level failures visible and give the server a chance
 * to release its resources before a fatal exception exits the process.
 */
export function installProcessGuards(
  logger: ProcessGuardLogger,
  close: () => Promise<void> = async () => undefined,
  exit: (code: number) => never = (code) => process.exit(code),
): void {
  if (installedProcessGuards) {
    process.off('unhandledRejection', installedProcessGuards.unhandledRejection);
    process.off('uncaughtException', installedProcessGuards.uncaughtException);
  }

  const unhandledRejection = (reason: unknown): void => {
    // pino only runs its error serializer on the `err` key; `error` logs as {}.
    logger.error({ err: reason, source: 'unhandledRejection' }, 'unhandled rejection');
  };
  const uncaughtException = (error: Error): void => {
    logger.error({ err: error, source: 'uncaughtException' }, 'uncaught exception');
    // Post-exception state may be corrupt; never let a hung close block the exit.
    const failsafe = setTimeout(() => exit(1), 3000);
    failsafe.unref();
    void close().then(
      () => {
        clearTimeout(failsafe);
        exit(1);
      },
      (closeError: unknown) => {
        clearTimeout(failsafe);
        logger.error({ err: closeError, source: 'uncaughtException' }, 'graceful shutdown failed');
        exit(1);
      },
    );
  };

  installedProcessGuards = { unhandledRejection, uncaughtException };
  process.on('unhandledRejection', unhandledRejection);
  process.on('uncaughtException', uncaughtException);
}

export async function main(): Promise<void> {
  const app = await buildApp({ logger: { level: 'info' } });
  const port = getPort();

  let closing = false;
  const close = async (signal: NodeJS.Signals | 'uncaughtException'): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down writing-studio');
    try {
      await app.close();
    } catch (error) {
      app.log.error(error, 'graceful shutdown failed');
      process.exitCode = 1;
    }
  };
  installProcessGuards(app.log, () => close('uncaughtException'));

  try {
    await app.listen({ port, host: '127.0.0.1' });
  } catch (error) {
    const message = describeListenFailure(error, port);
    if (!message) throw error;
    app.log.error({ err: error, port }, message);
    // onReady hooks already started watchers; close them or the process hangs.
    await app.close();
    process.exitCode = 1;
    return;
  }
  app.log.info(`writing-studio server on http://127.0.0.1:${port}`);

  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    // realpath both sides so a symlinked launch path still matches.
    return realpathSync(process.argv[1]) === self;
  } catch {
    return resolve(process.argv[1]) === self;
  }
}

if (isDirectExecution()) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
