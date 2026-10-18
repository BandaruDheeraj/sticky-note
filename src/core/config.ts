import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

/**
 * Note: git can't hold both `refs/heads/sticky-note` and `refs/heads/sticky-note/...`,
 * and the legacy v3 data lives on `sticky-note/data`, so we namespace under it.
 */
export const DEFAULT_DATA_BRANCH = 'sticky-note/context';

export const Config = z.object({
  version: z.literal(1).default(1),
  /** Branch that holds thread data. Never checked out in the user's working tree. */
  dataBranch: z.string().min(1).default(DEFAULT_DATA_BRANCH),
  /** Remote to sync the data branch with. */
  remote: z.string().min(1).default('origin'),
});
export type Config = z.infer<typeof Config>;

export const CONFIG_RELATIVE_PATH = path.join('.sticky-note', 'config.json');

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_RELATIVE_PATH);
}

/** Load config from the repo, falling back to defaults when absent. */
export async function loadConfig(repoRoot: string): Promise<{ config: Config; exists: boolean }> {
  let raw: string;
  try {
    raw = await readFile(configPath(repoRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { config: Config.parse({}), exists: false };
    throw err;
  }
  const parsed = Config.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Invalid ${CONFIG_RELATIVE_PATH}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return { config: parsed.data, exists: true };
}

export async function saveConfig(repoRoot: string, config: Config): Promise<void> {
  const file = configPath(repoRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
}
