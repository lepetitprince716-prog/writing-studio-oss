import assert from 'node:assert/strict';
import test from 'node:test';
import { captureJsonLogs } from './support/log-capture.js';

test('captureJsonLogs reports the offending non-JSON line and preserves its cause', () => {
  const captured = captureJsonLogs();
  const offendingLine = 'not-json: diagnostic payload';

  assert.throws(
    () => captured.stream.write(`${offendingLine}\n`),
    (error: unknown) => error instanceof Error
      && error.message.includes(offendingLine)
      && error.cause instanceof SyntaxError,
  );
  assert.deepEqual(captured.records, []);
});
