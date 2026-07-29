import { createServer } from 'node:net';

const TCP_LISTENER_SKIP_REASON =
  'TCP listener probe failed (bind 127.0.0.1:0 denied in this environment)';

let cachedProbe: Promise<string | false> | undefined;

/** Return a registration-time skip reason when loopback TCP bind is unavailable. */
export function tcpListenerSkipReason(): Promise<string | false> {
  cachedProbe ??= new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (result: string | false): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    server.once('error', () => finish(TCP_LISTENER_SKIP_REASON));
    server.listen(0, '127.0.0.1', () => {
      server.close(() => finish(false));
    });
  });
  return cachedProbe;
}
