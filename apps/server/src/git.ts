import { execFile } from 'node:child_process';
import type { GitStatus } from '@writing-studio/contract';

function tailAfterFields(record: string, fieldCount: number): string {
  let cursor = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const next = record.indexOf(' ', cursor);
    if (next < 0) return '';
    cursor = next + 1;
  }
  return record.slice(cursor);
}

/** Parse `git status --porcelain=v2 --branch -z` without losing spaces in paths. */
export function parseGitStatus(raw: string): GitStatus {
  let branch = '(detached)';
  const dirty: GitStatus['dirty'] = [];
  const records = raw.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? '';
    if (!record) continue;
    if (record.startsWith('# branch.head ')) {
      branch = record.slice('# branch.head '.length);
      continue;
    }

    const kind = record[0];
    if (kind === '?') {
      dirty.push({ status: '??', path: record.slice(2) });
    } else if (kind === '!') {
      continue;
    } else if (kind === '1') {
      const status = record.split(' ', 3)[1] ?? '';
      dirty.push({ status, path: tailAfterFields(record, 8) });
    } else if (kind === '2') {
      const status = record.split(' ', 3)[1] ?? '';
      dirty.push({ status, path: tailAfterFields(record, 9) });
      index += 1; // the following NUL field is the original path
    } else if (kind === 'u') {
      const status = record.split(' ', 3)[1] ?? '';
      dirty.push({ status, path: tailAfterFields(record, 10) });
    }
  }

  return { branch, dirty };
}

export function readGitStatus(vaultRoot: string): Promise<GitStatus> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain=v2', '--branch', '-z'],
      { cwd: vaultRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error ? { branch: '(unknown)', dirty: [] } : parseGitStatus(stdout));
      },
    );
  });
}
