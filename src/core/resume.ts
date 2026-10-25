import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const ResumeIntent = z.object({
  threadId: z.string().min(1),
  setAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
type ResumeIntent = z.infer<typeof ResumeIntent>;

const DEFAULT_TTL_MS = 15 * 60_000;

/**
 * A one-shot, local-only "continue this thread next" marker. `sticky-note
 * resume <id>` writes it; the next hook event in this repo (session start or
 * prompt, whichever fires first) consumes it and attaches that session to the
 * thread. Not synced — resuming is a decision made on one machine.
 */
export class ResumeIntentStore {
  constructor(private readonly dir: string) {}

  private file(): string {
    return path.join(this.dir, 'resume-intent.json');
  }

  async set(threadId: string, now = new Date(), ttlMs = DEFAULT_TTL_MS): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const intent: ResumeIntent = { threadId, setAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() };
    const tmp = `${this.file()}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(intent));
    await rename(tmp, this.file());
  }

  /** Read and clear the pending intent. Returns its thread id, or null if absent, malformed or expired. */
  async consume(now = new Date()): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    await rm(this.file(), { force: true }); // consume once, even if invalid or stale
    const parsed = ResumeIntent.safeParse(JSON.parse(raw));
    if (!parsed.success || Date.parse(parsed.data.expiresAt) < now.getTime()) return null;
    return parsed.data.threadId;
  }
}
