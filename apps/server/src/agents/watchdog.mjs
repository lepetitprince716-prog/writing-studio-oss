#!/usr/bin/env node
// This small JS entrypoint deliberately has no TypeScript/runtime-loader
// dependency: it must still run after the server process that spawned it has
// been SIGKILLed.  It owns the actual CLI process group and proxies all I/O.
import { spawn } from 'node:child_process';

const launchArgs = process.argv.slice(2);

if (launchArgs[0] === '--reap') {
  const processGroup = Number(launchArgs[1]);
  if (Number.isSafeInteger(processGroup) && processGroup > 1) {
    // This helper is intentionally detached from the watchdog group.  It is
    // the last resort when an owner is SIGKILLed or a CLI ignores SIGTERM.
    setTimeout(() => {
      try { process.kill(-processGroup, 'SIGKILL'); } catch { /* group ended */ }
    }, 750);
  }
} else {
const [ownerPidText, file, ...args] = launchArgs;
const ownerPid = Number(ownerPidText);

if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !file) {
  process.stderr.write('writing-studio watchdog: invalid launch arguments\n');
  process.exitCode = 125;
} else if (process.ppid !== ownerPid) {
  // `ppid` is the authoritative identity check.  A PID may eventually be
  // reused, but it cannot remain this process's parent after the real owner
  // exits; this avoids signalling an unrelated replacement process.
  process.stderr.write('writing-studio watchdog: owner disappeared before launch\n');
  process.exitCode = 125;
} else {
  let target;
  let stopping = false;
  let finished = false;
  let killTimer;
  let ownerTimer;

  const writeError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`writing-studio watchdog: ${message}\n`);
  };

  const signalOwnGroup = (signal) => {
    try { process.kill(-process.pid, signal); } catch {
      try { target?.kill(signal); } catch { /* already gone */ }
    }
  };

  const armReaper = () => {
    try {
      const reaper = spawn(process.execPath, [process.argv[1], '--reap', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      reaper.unref();
      return true;
    } catch (error) {
      writeError(error);
      return false;
    }
  };

  const finish = (code, signal) => {
    if (finished) return;
    finished = true;
    if (ownerTimer) clearInterval(ownerTimer);
    if (killTimer) clearTimeout(killTimer);
    process.exitCode = code ?? (signal ? 128 + signalNumber(signal) : 1);
  };

  const stop = () => {
    if (stopping || finished) return;
    stopping = true;
    // The target is in this watchdog process group (rather than detached):
    // macOS `sandbox-exec` rejects a detached target in some environments.
    // A detached reaper is created before we signal the group, then escalates
    // even if this watchdog is killed with the rest of its group.
    const reaperArmed = armReaper();
    signalOwnGroup('SIGTERM');
    if (!reaperArmed) {
      // Best effort only; normal operation always has the detached reaper.
      killTimer = setTimeout(() => signalOwnGroup('SIGKILL'), 750);
      killTimer.unref?.();
    }
  };

  const signalNumber = (signal) => ({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1);

  try {
    // The wrapper is detached by the supervisor and owns its CLI process
    // group.  Keeping the target in that group permits a single SIGTERM to
    // reach its normal descendants and stays compatible with `sandbox-exec`.
    target = spawn(file, args, { cwd: process.cwd(), env: process.env, detached: false, stdio: 'pipe', shell: false });
    target.stdin.on('error', () => {});
    target.stdout.on('error', () => {});
    target.stderr.on('error', () => {});
    process.stdin.on('error', () => {});
    process.stdout.on('error', () => {});
    process.stderr.on('error', () => {});
    process.stdin.pipe(target.stdin);
    target.stdout.pipe(process.stdout);
    target.stderr.pipe(process.stderr);
    target.once('error', (error) => {
      writeError(error);
      finish(127, null);
    });
    target.once('close', (code, signal) => finish(code, signal));
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
    ownerTimer = setInterval(() => {
      // A parent process cannot change without the original owner exiting.
      // This is intentionally stronger than `kill(ownerPid, 0)`: it remains
      // correct even if the operating system later reuses the old PID.
      if (process.ppid !== ownerPid) stop();
    }, 100);
    ownerTimer.unref?.();
  } catch (error) {
    writeError(error);
    finish(127, null);
  }
}
}
