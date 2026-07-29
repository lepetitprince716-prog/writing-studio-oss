/**
 * Browser/DNS-rebinding boundary for the localhost-only panel.
 *
 * This deliberately is not authentication: another local process can still
 * connect. It only prevents a non-loopback Host or browser Origin from being
 * treated as a trusted panel request.
 */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1)(?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/;
const LOOPBACK_IPV6_HOST = /^\[::1\](?::(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?$/;

export type LocalBoundaryViolation = 'host' | 'origin';

function isLoopbackHost(value: string): boolean {
  return LOOPBACK_HOST.test(value) || LOOPBACK_IPV6_HOST.test(value);
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (
      (origin.protocol === 'http:' || origin.protocol === 'https:')
      && origin.username === ''
      && origin.password === ''
      && origin.origin === value
      && isLoopbackHost(origin.host)
    );
  } catch {
    return false;
  }
}

/**
 * Returns the rejected boundary, if any. A missing Origin remains valid so
 * local CLI clients and server-side tests can use the API without emulating a
 * browser. Host is always required and must be loopback.
 */
export function localBoundaryViolation(headers: {
  host?: string | string[] | undefined;
  origin?: string | string[] | undefined;
}): LocalBoundaryViolation | undefined {
  if (typeof headers.host !== 'string' || !isLoopbackHost(headers.host)) return 'host';
  if (headers.origin === undefined) return undefined;
  if (typeof headers.origin !== 'string' || !isLoopbackOrigin(headers.origin)) return 'origin';
  return undefined;
}
