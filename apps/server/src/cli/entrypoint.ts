import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Compare realpaths on both sides: Node resolves symlinks when loading the
// module, so a raw argv[1] comparison silently never matches under a
// symlinked checkout — and a validator that exits 0 without validating is
// the worst possible failure mode.
function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function isCliEntrypoint(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1] ? realpathOrNull(resolve(process.argv[1])) : null;
  return entrypoint !== null
    && pathToFileURL(entrypoint).href
      === pathToFileURL(realpathSync(fileURLToPath(importMetaUrl))).href;
}
