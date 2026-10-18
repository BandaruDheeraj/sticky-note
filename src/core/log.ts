import { appendFile, mkdir, stat, truncate } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

/**
 * Append-only diagnostic log. Hooks can't print errors to the user without
 * polluting the agent's context, so this file is where to look when debugging.
 */
export class FileLog {
  constructor(readonly file: string) {}

  async write(message: string): Promise<void> {
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const size = await stat(this.file).then((s) => s.size, () => 0);
      if (size > MAX_BYTES) await truncate(this.file, 0);
      await appendFile(this.file, `${new Date().toISOString()} [${process.pid}] ${message}\n`);
    } catch {
      // Logging must never break the caller.
    }
  }
}
