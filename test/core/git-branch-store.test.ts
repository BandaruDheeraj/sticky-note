import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Git } from '../../src/core/git.js';
import { GitBranchStore } from '../../src/core/store/git-branch-store.js';
import { AmbiguousIdError } from '../../src/core/store/thread-store.js';
import { closeThread, createThread, type Thread } from '../../src/core/thread.js';
import { cleanupTmpDirs, makeBareRemote, makeRepo } from '../helpers/repo.js';

const BRANCH = 'sticky-note/context';
const author = { name: 'Test User', email: 'test.user@example.com' };

function store(dir: string) {
  return new GitBranchStore({ repoDir: dir, dataBranch: BRANCH, remote: 'origin' });
}

function thread(title: string, overrides: Partial<Thread> = {}): Thread {
  return { ...createThread({ title, author, branch: 'main' }), ...overrides };
}

afterEach(cleanupTmpDirs);

describe('GitBranchStore', () => {
  it('creates the data branch in a private worktree without touching the working tree', async () => {
    const { dir, git } = await makeRepo();
    const s = store(dir);
    await s.init();

    const worktree = await s.worktreePath();
    expect(worktree).toBe(path.join(await git.commonDir(), 'sticky-note', 'worktree'));
    expect(existsSync(path.join(worktree, '.git'))).toBe(true);
    expect(await git.currentBranch()).toBe('main');
    expect(await git.run(['status', '--porcelain'])).toBe('');
    expect(await git.refExists(`refs/heads/${BRANCH}`)).toBe(true);
  });

  it('works in a repo with no commits yet', async () => {
    const { dir, git } = await makeRepo();
    await git.run(['update-ref', '-d', 'HEAD']);
    await store(dir).save(thread('first'));
    expect((await store(dir).list()).threads).toHaveLength(1);
  });

  it('saves, lists and reads back threads, one commit per change', async () => {
    const { dir, git } = await makeRepo();
    const s = store(dir);
    const a = thread('A');
    const b = thread('B', { updatedAt: new Date(Date.now() + 1000).toISOString() });
    await s.save(a);
    await s.save(b);
    await s.save(b); // unchanged: no new commit

    const { threads, invalid } = await s.list();
    expect(threads.map((t) => t.title)).toEqual(['B', 'A']); // newest first
    expect(invalid).toEqual([]);
    expect(await git.run(['rev-list', '--count', BRANCH])).toBe('3'); // root + 2
  });

  it('filters by status and author', async () => {
    const { dir } = await makeRepo();
    const s = store(dir);
    await s.save(thread('open'));
    await s.save(closeThread(thread('done')));
    await s.save(thread('theirs', { author: { name: 'Someone Else' }, contributors: [{ name: 'Someone Else' }] }));

    expect((await s.list({ status: 'closed' })).threads.map((t) => t.title)).toEqual(['done']);
    expect((await s.list({ author: 'someone else' })).threads.map((t) => t.title)).toEqual(['theirs']);
  });

  it('resolves id prefixes and rejects ambiguous ones', async () => {
    const { dir } = await makeRepo();
    const s = store(dir);
    await s.save(thread('one', { id: 'abc-111' }));
    await s.save(thread('two', { id: 'abc-222' }));

    expect((await s.get('abc-1'))?.title).toBe('one');
    expect(await s.get('zzz')).toBeNull();
    await expect(s.get('abc')).rejects.toBeInstanceOf(AmbiguousIdError);
  });

  it('reports unreadable thread files instead of failing', async () => {
    const { dir } = await makeRepo();
    const s = store(dir);
    await s.save(thread('good'));
    await writeFile(path.join(await s.worktreePath(), 'threads', 'bad.json'), '{not json');

    const { threads, invalid } = await s.list();
    expect(threads).toHaveLength(1);
    expect(invalid.map((i) => i.file)).toEqual([path.join('threads', 'bad.json')]);
  });

  it('serializes concurrent writers', async () => {
    const { dir } = await makeRepo();
    const s = store(dir);
    await s.init();
    await Promise.all(Array.from({ length: 8 }, (_, i) => store(dir).save(thread(`t${i}`))));
    expect((await s.list()).threads).toHaveLength(8);
  });

  it("does not run the user's git hooks on data commits", async () => {
    const { dir, git } = await makeRepo();
    const hook = path.join(await git.commonDir(), 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await expect(store(dir).save(thread('x'))).resolves.toBeUndefined();
  });

  it('recreates the worktree if it was deleted', async () => {
    const { dir } = await makeRepo();
    const s = store(dir);
    await s.save(thread('kept'));
    const { rm } = await import('node:fs/promises');
    await rm(await s.worktreePath(), { recursive: true, force: true });

    expect((await store(dir).list()).threads.map((t) => t.title)).toEqual(['kept']);
  });

  describe('recovery from a killed process', () => {
    // Simulates a hook killed between `git add` and `git commit`, leaving a lock behind.
    async function interruptedWrite(dir: string) {
      const s = store(dir);
      await s.init();
      const worktree = await s.worktreePath();
      const orphan = thread('orphan');
      await mkdir(path.join(worktree, 'threads'), { recursive: true });
      await writeFile(path.join(worktree, 'threads', `${orphan.id}.json`), JSON.stringify(orphan));
      const wt = new Git(worktree);
      await wt.run(['add', '--all']);
      await writeFile(path.resolve(worktree, await wt.run(['rev-parse', '--git-path', 'index.lock'])), '');
      return { s, wt, orphan };
    }

    it('commits leftovers and clears a stale index.lock on the next save', async () => {
      const { dir } = await makeRepo();
      const { s, wt } = await interruptedWrite(dir);
      await s.save(thread('next'));
      expect(await wt.run(['status', '--porcelain'])).toBe('');
      expect((await s.list()).threads.map((t) => t.title).sort()).toEqual(['next', 'orphan']);
    });

    it('syncs successfully after an interrupted write', async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      const { s, orphan } = await interruptedWrite(alice.dir);
      expect((await s.sync()).pushed).toBeGreaterThan(0);

      const bob = await makeRepo({ remote, user: 'Bob' });
      await store(bob.dir).sync();
      expect(await store(bob.dir).get(orphan.id)).not.toBeNull();
    });

    it('takes over a lock held by a dead process immediately', async () => {
      const { dir, git } = await makeRepo();
      const lock = path.join(await git.commonDir(), 'sticky-note', 'lock');
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, 'pid'), '999999'); // no such process

      const started = Date.now();
      await store(dir).save(thread('after crash'));
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  });

  describe('sync', () => {
    it('skips when there is no remote', async () => {
      const { dir } = await makeRepo();
      expect(await store(dir).sync()).toEqual({ skipped: 'no-remote', pulled: 0, pushed: 0, merged: 0 });
    });

    it("shares threads between teammates through the remote", async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      const bob = await makeRepo({ remote, user: 'Bob' });

      await store(alice.dir).save(thread('alice work'));
      expect(await store(alice.dir).sync()).toMatchObject({ pushed: 2 }); // root + thread

      // Bob created his data branch independently before ever syncing.
      await store(bob.dir).save(thread('bob work'));
      const result = await store(bob.dir).sync();
      expect(result.pulled).toBe(2);
      expect((await store(bob.dir).list()).threads.map((t) => t.title).sort()).toEqual(['alice work', 'bob work']);

      await store(alice.dir).sync();
      expect((await store(alice.dir).list()).threads.map((t) => t.title).sort()).toEqual(['alice work', 'bob work']);
    });

    it('picks up an existing remote data branch on a fresh clone', async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      await store(alice.dir).save(thread('from alice'));
      await store(alice.dir).sync();

      const carol = await makeRepo({ remote, user: 'Carol' });
      await carol.git.run(['fetch', '--quiet', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
      expect((await store(carol.dir).list()).threads.map((t) => t.title)).toEqual(['from alice']);
    });

    it('merges concurrent edits to the same thread instead of failing', async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      const bob = await makeRepo({ remote, user: 'Bob' });

      const shared = thread('shared', { files: ['a.ts'] });
      await store(alice.dir).save(shared);
      await store(alice.dir).sync();
      await store(bob.dir).sync();

      const later = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
      await store(alice.dir).save({ ...shared, files: ['a.ts', 'alice.ts'], narrative: 'alice', updatedAt: later(1) });
      await store(alice.dir).sync();
      await store(bob.dir).save({ ...shared, files: ['a.ts', 'bob.ts'], narrative: 'bob', updatedAt: later(2) });

      expect(await store(bob.dir).sync()).toMatchObject({ merged: 1, pushed: 2 }); // bob's edit + merge commit
      const merged = await store(bob.dir).get(shared.id);
      expect(merged).toMatchObject({ narrative: 'bob', files: ['a.ts', 'alice.ts', 'bob.ts'] });
      expect(await new Git(await store(bob.dir).worktreePath()).run(['status', '--porcelain'])).toBe('');

      await store(alice.dir).sync();
      expect(await store(alice.dir).get(shared.id)).toEqual(merged);
    });

    it('keeps history linear when edits touch different threads', async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      const bob = await makeRepo({ remote, user: 'Bob' });
      await store(alice.dir).save(thread('a'));
      await store(alice.dir).sync();
      await store(bob.dir).save(thread('b'));

      expect(await store(bob.dir).sync()).toMatchObject({ merged: 0 });
      const merges = await bob.git.run(['rev-list', '--merges', '--count', BRANCH]);
      expect(merges).toBe('0');
    });

    it('leaves local data intact on a conflict it cannot resolve', async () => {
      const remote = await makeBareRemote();
      const alice = await makeRepo({ remote, user: 'Alice' });
      const bob = await makeRepo({ remote, user: 'Bob' });
      await store(alice.dir).save(thread('seed'));
      await store(alice.dir).sync();
      await store(bob.dir).sync();

      // Same non-thread file edited on both sides (not something sticky-note writes).
      for (const [who, text] of [[alice, 'alice'], [bob, 'bob']] as const) {
        const wt = new Git(await store(who.dir).worktreePath());
        await writeFile(path.join(wt.cwd, 'NOTES.md'), text);
        await wt.run(['add', 'NOTES.md']);
        await wt.run(['commit', '-q', '-m', text]);
      }
      await store(alice.dir).sync();

      await expect(store(bob.dir).sync()).rejects.toThrow(/unexpected conflict in NOTES.md/);
      const wt = new Git(await store(bob.dir).worktreePath());
      expect(await wt.run(['status', '--porcelain'])).toBe('');
      expect((await store(bob.dir).list()).threads).toHaveLength(1);
    });
  });
});
