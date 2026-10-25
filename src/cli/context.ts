import path from 'node:path';
import { loadConfig, type Config } from '../core/config.js';
import { Git } from '../core/git.js';
import { resolveIdentity } from '../core/identity.js';
import { FileLog } from '../core/log.js';
import { localStateDir } from '../core/paths.js';
import { ResumeIntentStore } from '../core/resume.js';
import { SessionStore } from '../core/session.js';
import { GitBranchStore } from '../core/store/git-branch-store.js';
import type { ThreadStore } from '../core/store/thread-store.js';
import type { Person } from '../core/thread.js';
import { CliError } from './errors.js';
import type { Output } from './output.js';

/**
 * Lazily-constructed, memoized dependencies. Commands ask for what they need,
 * so `--help` never touches git and `init` can run before a config exists.
 */
export class Services {
  private cache = new Map<string, Promise<unknown>>();

  constructor(readonly cwd: string) {}

  git(): Git {
    return new Git(this.cwd);
  }

  repoRoot(): Promise<string> {
    return this.memo('repoRoot', async () => {
      const git = this.git();
      if (!(await git.isRepo())) {
        throw new CliError(`Not a git repository: ${this.cwd}`, 1, 'Run sticky-note inside a git repository.');
      }
      return git.topLevel();
    });
  }

  config(): Promise<{ config: Config; exists: boolean }> {
    return this.memo('config', async () => loadConfig(await this.repoRoot()));
  }

  identity(): Promise<Person> {
    return this.memo('identity', () => resolveIdentity(this.git()));
  }

  store(): Promise<ThreadStore> {
    return this.memo('store', async () => {
      const [repoDir, { config }] = await Promise.all([this.repoRoot(), this.config()]);
      return new GitBranchStore({ repoDir, dataBranch: config.dataBranch, remote: config.remote });
    });
  }

  sessions(): Promise<SessionStore> {
    return this.memo('sessions', async () => new SessionStore(path.join(await localStateDir(this.git()), 'sessions')));
  }

  log(): Promise<FileLog> {
    return this.memo('log', async () => new FileLog(path.join(await localStateDir(this.git()), 'logs', 'hooks.log')));
  }

  resumeIntent(): Promise<ResumeIntentStore> {
    return this.memo('resumeIntent', async () => new ResumeIntentStore(await localStateDir(this.git())));
  }

  private memo<T>(key: string, factory: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, factory());
    return this.cache.get(key) as Promise<T>;
  }
}

export interface CommandContext {
  cwd: string;
  out: Output;
  stdin: NodeJS.ReadableStream;
  services: Services;
}
