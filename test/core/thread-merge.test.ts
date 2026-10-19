import { describe, expect, it } from 'vitest';
import { closeThread, createThread, type Thread } from '../../src/core/thread.js';
import { mergeThreads } from '../../src/core/thread-merge.js';

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const t0 = new Date('2026-10-18T10:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000).toISOString();

const base = createThread({ title: 'Fix login', author: alice, branch: 'main', files: ['a.ts'], now: t0 });
const edit = (patch: Partial<Thread>): Thread => ({ ...base, ...patch });

describe('mergeThreads', () => {
  it('unions lists and takes scalars from the newer side', () => {
    const mine = edit({ files: ['a.ts', 'b.ts'], narrative: 'mine', updatedAt: at(1) });
    const theirs = edit({ files: ['a.ts', 'c.ts'], contributors: [alice, bob], narrative: 'theirs', status: 'stuck', updatedAt: at(2) });
    const merged = mergeThreads(mine, theirs);

    expect(merged.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(merged.contributors).toEqual([alice, bob]);
    expect(merged).toMatchObject({ narrative: 'theirs', status: 'stuck', updatedAt: at(2), author: alice, createdAt: base.createdAt });
  });

  it('is symmetric', () => {
    const a = edit({ files: ['x.ts'], narrative: 'a', updatedAt: at(1) });
    const b = edit({ files: ['y.ts'], narrative: 'b', updatedAt: at(1) }); // tie on updatedAt
    expect(mergeThreads(a, b)).toEqual(mergeThreads(b, a));
  });

  it('keeps a close even if the other side kept working afterwards', () => {
    const closed = closeThread(base, { summary: 'Done', now: new Date(at(5)) });
    const stillWorking = edit({ files: ['a.ts', 'late.ts'], updatedAt: at(10) });
    const merged = mergeThreads(closed, stillWorking);

    expect(merged).toMatchObject({ status: 'closed', closedAt: at(5), narrative: 'Done' });
    expect(merged.files).toContain('late.ts');
  });

  it('prefers the narrative that contains the other', () => {
    const appended = edit({ narrative: 'step 1\n\nstep 2', updatedAt: at(1) });
    const original = edit({ narrative: 'step 1', updatedAt: at(2) });
    expect(mergeThreads(appended, original).narrative).toBe('step 1\n\nstep 2');
  });

  it('merges sessions by id, keeping the ended state', () => {
    const open = edit({ sessions: [{ id: 's1', agent: 'claude-code', startedAt: at(0), endedAt: null, lastActiveAt: null }], updatedAt: at(1) });
    const ended = edit({
      sessions: [
        { id: 's1', agent: 'claude-code', startedAt: at(0), endedAt: at(3), lastActiveAt: null },
        { id: 's2', agent: 'claude-code', startedAt: at(2), endedAt: null, lastActiveAt: null },
      ],
      updatedAt: at(0),
    });
    expect(mergeThreads(open, ended).sessions).toEqual([
      { id: 's1', agent: 'claude-code', startedAt: at(0), endedAt: at(3), lastActiveAt: null },
      { id: 's2', agent: 'claude-code', startedAt: at(2), endedAt: null, lastActiveAt: null },
    ]);
  });

  it('refuses to merge different threads', () => {
    expect(() => mergeThreads(base, { ...base, id: 'other' })).toThrow(/different threads/);
  });
});
