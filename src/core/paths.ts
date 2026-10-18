import path from 'node:path';
import type { Git } from './git.js';

/**
 * Machine-local sticky-note state lives inside the shared .git dir so it is
 * never committed, survives branch switches, and is shared by linked worktrees.
 */
export async function localStateDir(git: Git): Promise<string> {
  return path.join(await git.commonDir(), 'sticky-note');
}
