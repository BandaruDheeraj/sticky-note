import { mkdir, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock older than this is assumed to belong to a crashed process. */
  staleMs?: number;
}

/**
 * Cross-process mutex using atomic mkdir. Serializes writers to the data
 * worktree so concurrent hooks don't collide on git's index.lock.
 */
export async function withLock<T>(lockDir: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const staleMs = opts.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;

  for (let delay = 20; ; delay = Math.min(delay * 2, 250)) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const age = await stat(lockDir).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) {
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
