import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Git } from '../../src/core/git.js';

const created: string[] = [];

export async function tmpDir(prefix = 'sticky-note-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function cleanupTmpDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

/** A repo with one commit on main, optionally cloned from `remote`. */
export async function makeRepo(opts: { remote?: string; user?: string } = {}): Promise<{ dir: string; git: Git }> {
  const dir = await tmpDir();
  const git = new Git(dir);
  if (opts.remote) {
    await git.run(['clone', '--quiet', opts.remote, '.']);
  } else {
    await git.run(['init', '--quiet', '-b', 'main']);
  }
  const user = opts.user ?? 'Test User';
  await git.run(['config', 'user.name', user]);
  await git.run(['config', 'user.email', `${user.toLowerCase().replace(/\s+/g, '.')}@example.com`]);
  await git.run(['config', 'commit.gpgSign', 'false']);
  if (!opts.remote) await git.run(['commit', '--quiet', '--allow-empty', '-m', 'initial']);
  return { dir, git };
}

/** A bare remote seeded with one commit on main. */
export async function makeBareRemote(): Promise<string> {
  const bare = await tmpDir('sticky-note-remote-');
  await new Git(bare).run(['init', '--quiet', '--bare', '-b', 'main']);
  const seed = await makeRepo();
  await seed.git.run(['remote', 'add', 'origin', bare]);
  await seed.git.run(['push', '--quiet', 'origin', 'main']);
  return bare;
}
