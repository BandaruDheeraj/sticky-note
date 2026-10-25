import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withLock } from './lock.js';

/**
 * Machine-local state for one live agent session. Hooks fire as separate
 * processes, so this file is how they share state cheaply between calls
 * without committing to the data branch on every tool use.
 */
export const SessionState = z.object({
  sessionId: z.string(),
  agent: z.string(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** Set once the session's thread has been committed to the store. */
  threadId: z.string().nullable().default(null),
  /**
   * Thread planned on the first prompt but not yet committed. Committing is
   * deferred to the end of the turn to keep git off the prompt's critical path.
   */
  pendingThread: z
    .object({
      title: z.string(),
      /** The full first prompt, kept when the title had to shorten it. */
      prompt: z.string().optional(),
      branch: z.string().nullable(),
      createdAt: z.string().datetime(),
    })
    .nullable()
    .default(null),
  /** Files edited since the last flush to the thread. */
  pendingFiles: z.array(z.string()).default([]),
  /** Threads already shown to the agent (id → updatedAt at the time), so we don't repeat them. */
  surfaced: z.record(z.string()).default({}),
  /** Files we've already warned about overlapping work on, once per session. */
  warnedFiles: z.array(z.string()).default([]),
  /** Files the agent has read or edited; their history is shown on first touch only. */
  touchedFiles: z.array(z.string()).default([]),
  /** HEAD when the session began; my commits after it are attributed to the session's thread. */
  baseHead: z.string().nullable().default(null),
  /** Last background sync started by this session. */
  lastSyncAt: z.string().datetime().nullable().default(null),
});
export type SessionState = z.infer<typeof SessionState>;

export class SessionStore {
  constructor(private readonly dir: string) {}

  async get(sessionId: string): Promise<SessionState | null> {
    try {
      return SessionState.parse(JSON.parse(await readFile(this.file(sessionId), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Atomically read-modify-write a session. Parallel tool calls fire hooks
   * concurrently, so updates are serialized per session.
   */
  async update<T>(
    sessionId: string,
    fn: (current: SessionState | null) => Promise<{ next: SessionState | null; result: T }>,
  ): Promise<T> {
    await mkdir(this.dir, { recursive: true });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const { next, result } = await fn(await this.get(sessionId));
      if (next) await this.write(SessionState.parse(next));
      else await rm(this.file(sessionId), { force: true });
      return result;
    });
  }

  private async write(state: SessionState): Promise<void> {
    const file = this.file(state.sessionId);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await rename(tmp, file);
  }

  private file(sessionId: string): string {
    return path.join(this.dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }
}
