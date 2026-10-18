import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock older than this is assumed abandoned even if its owner can't be checked. */
  staleMs?: number;
}

/**
 * Cross-process mutex using atomic mkdir. Serializes writers to the data
 * worktree so concurrent hooks don't collide on git's index.lock.
 *
 * The owner's pid is recorded so a lock left by a killed process (e.g. a hook
 * that hit the agent's timeout) is taken over immediately.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const pidFile = path.join(lockDir, 'pid');

  for (let delay = 20; ; delay = Math.min(delay * 2, 250)) {
    try {
      await mkdir(lockDir);
      await writeFile(pidFile, String(process.pid));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (await isAbandoned(lockDir, pidFile, staleMs)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lockDir}`);
      await sleep(delay);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function isAbandoned(lockDir: string, pidFile: string, staleMs: number): Promise<boolean> {
  const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
  if (pid > 0 && !isAlive(pid)) return true;
  const age = await stat(lockDir).then((s) => Date.now() - s.mtimeMs, () => 0);
  return age > staleMs;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}
