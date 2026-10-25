import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Git, GitError } from '../git.js';
import { withLock } from '../lock.js';
import { localStateDir } from '../paths.js';
import { AuditEntry, AuditLog, appendAuditEntry, mergeAuditLogs } from '../audit.js';
import { ClaimSet, mergeClaimSets, ownerKey } from '../claim.js';
import { mergeThreads } from '../thread-merge.js';
import { Person, Thread } from '../thread.js';
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
const CLAIMS_DIR = 'claims';
const AUDIT_DIR = 'audit';
/** Directories of records sticky-note owns on the data branch, and how to merge each kind. */
const RECORD_DIRS = [THREADS_DIR, CLAIMS_DIR, AUDIT_DIR];
const MAX_PUSH_ATTEMPTS = 3;

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
    await this.writeRecord(path.posix.join(THREADS_DIR, `${valid.id}.json`), valid, message ?? `thread ${valid.id}: ${valid.status}`);
  }

  async listClaims(): Promise<ClaimSet[]> {
    return this.listRecords(CLAIMS_DIR, ClaimSet);
  }

  async saveClaims(set: ClaimSet, message?: string): Promise<void> {
    const valid = ClaimSet.parse(set);
    const rel = path.posix.join(CLAIMS_DIR, `${ownerKey(valid.owner)}.json`);
    await this.writeRecord(rel, valid, message ?? `claims: ${valid.owner.name} (${valid.claims.length})`);
  }

  async listAudit(): Promise<AuditLog[]> {
    return this.listRecords(AUDIT_DIR, AuditLog);
  }

  async appendAudit(actor: Person, entry: Omit<AuditEntry, 'at'> & { at?: string }, message?: string): Promise<void> {
    // Read-modify-write under one lock acquisition, so two hook processes
    // appending for the same person in quick succession don't lose an entry.
    await this.withWriteLock(async () => {
      const worktree = await this.ensureWorktree();
      const wt = this.repo.at(worktree);
      const rel = path.posix.join(AUDIT_DIR, `${ownerKey(actor)}.json`);
      const existing = await readFile(path.join(worktree, rel), 'utf8').then(
        (raw) => AuditLog.safeParse(JSON.parse(raw)),
        () => null,
      );
      const log = existing?.success ? existing.data : AuditLog.parse({ schemaVersion: 1, owner: actor });
      const next = appendAuditEntry(log, entry);
      await this.writeRecordLocked(wt, rel, next, message ?? `audit: ${actor.name} ${entry.action}`);
    });
  }

  private async listRecords<T>(dir: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): Promise<T[]> {
    const folder = path.join(await this.readyWorktree(), dir);
    const entries = await readdir(folder).catch(() => [] as string[]);
    const results = await Promise.all(
      entries
        .filter((f) => f.endsWith('.json'))
        .map((f) => readFile(path.join(folder, f), 'utf8').then((raw) => schema.safeParse(JSON.parse(raw)), () => null)),
    );
    return results.flatMap((r) => (r?.success ? [r.data as T] : []));
  }

  private async writeRecord(rel: string, data: unknown, message: string): Promise<void> {
    await this.withWriteLock(async () => {
      const worktree = await this.ensureWorktree();
      await this.writeRecordLocked(this.repo.at(worktree), rel, data, message);
    });
  }

  /** Atomically write one JSON record into the data worktree and commit it. Caller must hold the write lock. */
  private async writeRecordLocked(wt: Git, rel: string, data: unknown, message: string): Promise<void> {
    await this.recover(wt);

    const abs = path.join(wt.cwd, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    // Write-then-rename so readers never see a half-written file. The temp
    // file lives outside the worktree so it can never be committed.
    const { tmp } = await this.resolvePaths();
    await mkdir(tmp, { recursive: true });
    const tmpFile = path.join(tmp, `${path.basename(rel)}.${process.pid}.tmp`);
    await writeFile(tmpFile, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmpFile, abs);

    // Also picks up anything an interrupted earlier write left uncommitted.
    await this.commitPending(wt, message);
  }

  async sync(): Promise<SyncResult> {
    const { dataBranch, remote } = this.opts;
    if (!(await this.repo.hasRemote(remote))) return { skipped: 'no-remote', pulled: 0, pushed: 0, merged: 0 };

    return this.withWriteLock(async () => {
      const wt = this.repo.at(await this.ensureWorktree());
      await this.recover(wt);
      await this.commitPending(wt, 'recover uncommitted thread changes');
      const remoteRef = `refs/remotes/${remote}/${dataBranch}`;
      let pulled = 0;
      let merged = 0;

      // Retry when a teammate pushes between our fetch and our push.
      for (let attempt = 1; ; attempt++) {
        const remoteExists = await this.fetch(wt);
        if (remoteExists) {
          pulled += await this.countCommits(wt, `HEAD..${remoteRef}`);
          merged += await this.integrate(wt, remoteRef);
        }
        const pushed = await this.countCommits(wt, remoteExists ? `${remoteRef}..HEAD` : 'HEAD');
        if (remoteExists && pushed === 0) return { pulled, pushed, merged };
        try {
          await wt.run(['push', '--quiet', remote, `HEAD:refs/heads/${dataBranch}`]);
          await wt.run(['update-ref', remoteRef, 'HEAD']);
          return { pulled, pushed, merged };
        } catch (err) {
          const rejected = err instanceof GitError && /rejected|non-fast-forward|fetch first/i.test(err.stderr);
          if (!rejected || attempt >= MAX_PUSH_ATTEMPTS) throw err;
        }
      }
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

  /**
   * Bring the remote's commits into HEAD. Rebases when possible for a linear
   * history. If both sides edited the same thread, merges instead and resolves
   * each conflicted thread field by field, so people never see a git conflict.
   * Returns how many threads needed merging.
   */
  private async integrate(wt: Git, remoteRef: string): Promise<number> {
    const config = await this.commitConfig();
    if ((await wt.tryRun(['rebase', remoteRef], { config })) !== null) return 0;
    await wt.tryRun(['rebase', '--abort']);

    if ((await wt.tryRun(['merge', '--no-ff', '--no-commit', '--allow-unrelated-histories', remoteRef], { config })) !== null) {
      await wt.run(['commit', '--quiet', '--no-verify', '-m', `merge ${remoteRef}`], { config });
      return 0;
    }

    const conflicted = (await wt.run(['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
    try {
      if (conflicted.length === 0) throw new SyncConflictError('merge failed without conflicting files');
      for (const file of conflicted) {
        // Stage 2 is our version, stage 3 theirs; one is missing if a side deleted the file.
        const versions = (await Promise.all([2, 3].map((stage) => wt.tryRun(['show', `:${stage}:${file}`]))))
          .filter((v): v is string => v !== null);
        const merged = mergeRecord(file, versions);
        await writeFile(path.join(wt.cwd, file), `${JSON.stringify(merged, null, 2)}\n`);
        await wt.run(['add', '--', file]);
      }
      await wt.run(['commit', '--quiet', '--no-verify', '-m', `merge ${conflicted.length} concurrently edited record(s)`], { config });
      return conflicted.length;
    } catch (err) {
      await wt.tryRun(['merge', '--abort']);
      throw err instanceof SyncConflictError ? err : new SyncConflictError((err as Error).message);
    }
  }

  /** Stage and commit every change to sticky-note's records. Returns false if there was nothing to commit. */
  private async commitPending(wt: Git, message: string): Promise<boolean> {
    const dirs = RECORD_DIRS.filter((d) => existsSync(path.join(wt.cwd, d)));
    if (dirs.length === 0) return false;
    await wt.run(['add', '--all', '--', ...dirs]);
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
    if (existsSync(await gitPath('MERGE_HEAD'))) await wt.tryRun(['merge', '--abort']);
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

/** Field-level merge for a conflicted record, chosen by its directory. Anything else is not ours to merge. */
function mergeRecord(file: string, versions: string[]): unknown {
  const [dir, name, ...rest] = file.split('/');
  if (rest.length || !name?.endsWith('.json')) throw new SyncConflictError(`unexpected conflict in ${file}`);
  const parsed = versions.map((v) => JSON.parse(v) as unknown);
  switch (dir) {
    case THREADS_DIR:
      return parsed.map((v) => Thread.parse(v)).reduce(mergeThreads);
    case CLAIMS_DIR:
      return parsed.map((v) => ClaimSet.parse(v)).reduce(mergeClaimSets);
    case AUDIT_DIR:
      return parsed.map((v) => AuditLog.parse(v)).reduce(mergeAuditLogs);
    default:
      throw new SyncConflictError(`unexpected conflict in ${file}`);
  }
}
