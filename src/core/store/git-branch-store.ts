import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Git, GitError } from '../git.js';
import { withLock } from '../lock.js';
import { localStateDir } from '../paths.js';
import { Thread } from '../thread.js';
import {
  AmbiguousIdError,
  matchesFilter,
  SyncConflictError,
  type InvalidRecord,
  type StoreStatus,
  type SyncResult,
  type ThreadFilter,
  type ThreadStore,
} from './thread-store.js';

const THREADS_DIR = 'threads';

export interface GitBranchStoreOptions {
  /** Any directory inside the user's repo. */
  repoDir: string;
  dataBranch: string;
  remote: string;
}

/**
 * Stores threads as JSON files on a dedicated branch, checked out in a private
 * worktree under <git-common-dir>/sticky-note/worktree. The user's working tree
 * and current branch are never touched.
 */
export class GitBranchStore implements ThreadStore {
  private readonly repo: Git;
  private paths?: { worktree: string; lock: string; tmp: string; noHooks: string };

  constructor(private readonly opts: GitBranchStoreOptions) {
    this.repo = new Git(opts.repoDir);
  }

  /** Absolute path of the data worktree. */
  async worktreePath(): Promise<string> {
    return (await this.resolvePaths()).worktree;
  }

  async init(): Promise<void> {
    await this.withWriteLock(() => this.ensureWorktree());
  }

  async list(filter?: ThreadFilter): Promise<{ threads: Thread[]; invalid: InvalidRecord[] }> {
    const dir = path.join(await this.readyWorktree(), THREADS_DIR);
    const entries = await readdir(dir).catch(() => [] as string[]);
    const threads: Thread[] = [];
    const invalid: InvalidRecord[] = [];

    await Promise.all(
      entries
        .filter((f) => f.endsWith('.json'))
        .map(async (file) => {
          try {
            const thread = Thread.parse(JSON.parse(await readFile(path.join(dir, file), 'utf8')));
            if (matchesFilter(thread, filter)) threads.push(thread);
          } catch (err) {
            invalid.push({ file: path.join(THREADS_DIR, file), error: (err as Error).message });
          }
        }),
    );

    threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { threads, invalid };
  }

  async get(idOrPrefix: string): Promise<Thread | null> {
    const { threads } = await this.list();
    const exact = threads.find((t) => t.id === idOrPrefix);
    if (exact) return exact;
    const matches = threads.filter((t) => t.id.startsWith(idOrPrefix));
    if (matches.length > 1) throw new AmbiguousIdError(idOrPrefix, matches.map((t) => t.id));
    return matches[0] ?? null;
  }

  async save(thread: Thread, message?: string): Promise<void> {
    const valid = Thread.parse(thread);
    await this.withWriteLock(async () => {
      const worktree = await this.ensureWorktree();
      const wt = this.repo.at(worktree);
      await this.recover(wt);

      const abs = path.join(worktree, THREADS_DIR, `${valid.id}.json`);
      await mkdir(path.dirname(abs), { recursive: true });
      // Write-then-rename so readers never see a half-written file. The temp
      // file lives outside the worktree so it can never be committed.
      const { tmp } = await this.resolvePaths();
      await mkdir(tmp, { recursive: true });
      const tmpFile = path.join(tmp, `${valid.id}.${process.pid}.json`);
      await writeFile(tmpFile, `${JSON.stringify(valid, null, 2)}\n`);
      await rename(tmpFile, abs);

      // Also picks up anything an interrupted earlier write left uncommitted.
      await this.commitPending(wt, message ?? `thread ${valid.id}: ${valid.status}`);
    });
  }

  async sync(): Promise<SyncResult> {
    const { dataBranch, remote } = this.opts;
    if (!(await this.repo.hasRemote(remote))) return { skipped: 'no-remote', pulled: 0, pushed: 0 };

    return this.withWriteLock(async () => {
      const wt = this.repo.at(await this.ensureWorktree());
      await this.recover(wt);
      await this.commitPending(wt, 'recover uncommitted thread changes');
      const remoteRef = `refs/remotes/${remote}/${dataBranch}`;
      let pulled = 0;

      const remoteExists = await this.fetch(wt);
      if (remoteExists) {
        pulled = await this.countCommits(wt, `HEAD..${remoteRef}`);
        try {
          await wt.run(['rebase', remoteRef], { config: await this.commitConfig() });
        } catch (err) {
          await wt.tryRun(['rebase', '--abort']);
          throw new SyncConflictError(err instanceof GitError ? err.stderr.trim() : String(err));
        }
      }

      const pushed = remoteExists ? await this.countCommits(wt, `${remoteRef}..HEAD`) : await this.countCommits(wt, 'HEAD');
      if (pushed > 0 || !remoteExists) {
        await wt.run(['push', '--quiet', remote, `HEAD:refs/heads/${dataBranch}`]);
        await wt.run(['update-ref', remoteRef, 'HEAD']);
      }
      return { pulled, pushed };
    });
  }

  async status(): Promise<StoreStatus> {
    const { remote, dataBranch } = this.opts;
    const worktree = await this.readyWorktree();
    const wt = this.repo.at(worktree);
    const remoteRef = `refs/remotes/${remote}/${dataBranch}`;
    const hasRemote = await this.repo.hasRemote(remote);
    const tracked = hasRemote && (await this.repo.refExists(remoteRef));

    return {
      backend: `git branch ${dataBranch}`,
      location: worktree,
      head: await wt.tryRun(['rev-parse', '--short', 'HEAD']),
      remote: hasRemote ? remote : null,
      ahead: tracked ? await this.countCommits(wt, `${remoteRef}..HEAD`) : null,
      behind: tracked ? await this.countCommits(wt, `HEAD..${remoteRef}`) : null,
    };
  }

  // ---------------------------------------------------------------------------

  private async resolvePaths() {
    if (!this.paths) {
      const base = await localStateDir(this.repo);
      this.paths = {
        worktree: path.join(base, 'worktree'),
        lock: path.join(base, 'lock'),
        tmp: path.join(base, 'tmp'),
        noHooks: path.join(base, 'no-hooks'),
      };
    }
    return this.paths;
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const { lock } = await this.resolvePaths();
    await mkdir(path.dirname(lock), { recursive: true });
    return withLock(lock, fn);
  }

  /** Read path: create the worktree if missing, without taking the lock when it already exists. */
  private async readyWorktree(): Promise<string> {
    const { worktree } = await this.resolvePaths();
    if (existsSync(path.join(worktree, '.git'))) return worktree;
    return this.withWriteLock(() => this.ensureWorktree());
  }

  /** Must be called with the write lock held. */
  private async ensureWorktree(): Promise<string> {
    const { worktree } = await this.resolvePaths();
    const { dataBranch, remote } = this.opts;

    if (existsSync(path.join(worktree, '.git'))) {
      const checkedOut = await this.repo.at(worktree).currentBranch();
      if (checkedOut !== dataBranch) {
        throw new Error(`Data worktree ${worktree} is on "${checkedOut ?? 'detached HEAD'}", expected "${dataBranch}"`);
      }
      return worktree;
    }

    await this.repo.run(['worktree', 'prune']);
    const localRef = `refs/heads/${dataBranch}`;

    if (!(await this.repo.refExists(localRef))) {
      const remoteRef = `refs/remotes/${remote}/${dataBranch}`;
      if (await this.repo.refExists(remoteRef)) {
        await this.repo.run(['branch', '--track', dataBranch, `${remote}/${dataBranch}`]);
      } else {
        await this.createOrphanBranch(localRef);
      }
    }

    await mkdir(path.dirname(worktree), { recursive: true });
    await this.repo.run(['worktree', 'add', '--quiet', worktree, dataBranch]);
    return worktree;
  }

  /** Root commit with an empty tree, built with plumbing so it works even in a repo with no commits. */
  private async createOrphanBranch(ref: string): Promise<void> {
    const emptyTree = await this.repo.run(['hash-object', '-t', 'tree', '/dev/null']);
    const commit = await this.repo.run(['commit-tree', emptyTree, '-m', 'sticky-note: initialize data branch'], {
      config: await this.commitConfig(),
    });
    await this.repo.run(['update-ref', ref, commit, '']);
  }

  /** Fetch the data branch. Returns false if the remote doesn't have it yet. */
  private async fetch(wt: Git): Promise<boolean> {
    const { remote, dataBranch } = this.opts;
    try {
      await wt.run(['fetch', '--quiet', remote, `+refs/heads/${dataBranch}:refs/remotes/${remote}/${dataBranch}`]);
      return true;
    } catch (err) {
      if (err instanceof GitError && /couldn't find remote ref/i.test(err.stderr)) return false;
      throw err;
    }
  }

  /** Stage and commit every change under threads/. Returns false if there was nothing to commit. */
  private async commitPending(wt: Git, message: string): Promise<boolean> {
    if (!existsSync(path.join(wt.cwd, THREADS_DIR))) return false;
    await wt.run(['add', '--all', '--', THREADS_DIR]);
    if ((await wt.tryRun(['diff', '--cached', '--quiet'])) !== null) return false;
    await wt.run(['commit', '--quiet', '--no-verify', '-m', message], { config: await this.commitConfig() });
    return true;
  }

  /**
   * Undo debris from a process killed mid-operation (hooks get killed on
   * timeout). Must be called with the write lock held, which guarantees no
   * other sticky-note process is using the worktree.
   */
  private async recover(wt: Git): Promise<void> {
    const gitPath = async (name: string) => path.resolve(wt.cwd, await wt.run(['rev-parse', '--git-path', name]));
    await rm(await gitPath('index.lock'), { force: true });
    if (existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply'))) {
      await wt.tryRun(['rebase', '--abort']);
    }
  }

  /** Disable the user's repo hooks for data commits and supply an identity if none is configured. */
  private async commitConfig(): Promise<Record<string, string>> {
    const { noHooks } = await this.resolvePaths();
    const config: Record<string, string> = { 'core.hooksPath': noHooks, 'commit.gpgSign': 'false' };
    if (!(await this.repo.configGet('user.name'))) config['user.name'] = 'sticky-note';
    if (!(await this.repo.configGet('user.email'))) config['user.email'] = 'sticky-note@localhost';
    return config;
  }

  private async countCommits(wt: Git, range: string): Promise<number> {
    return Number(await wt.run(['rev-list', '--count', range]));
  }
}
