// Sandboxed environments prepend runtime noise (certificate-trust errors,
// experimental warnings) to every spawned node's stderr. Strip lines the CLI
// itself never emits before asserting on stderr content.
export function withoutRuntimeNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^ERROR: failed to copy trust settings|^\(node:\d+\)/.test(line))
    .join('\n')
    .trim();
}
