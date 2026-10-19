import { describe, expect, it } from 'vitest';
import { closeThread, createThread, type Thread } from '../../src/core/thread.js';
import { findOverlaps, isLive, rankThreads } from '../../src/surfacing/relevance.js';
import { renderContext, renderOverlapWarning } from '../../src/surfacing/render.js';

const me = { name: 'Me', email: 'me@example.com' };
const alice = { name: 'Alice', email: 'alice@example.com' };
const now = new Date('2026-10-18T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

function thread(title: string, patch: Partial<Thread> = {}): Thread {
  const t = createThread({ title, author: alice, branch: 'main', now: new Date(hoursAgo(1)) });
  return { ...t, updatedAt: hoursAgo(1), ...patch };
}
const live = (t: Thread): Thread => ({ ...t, sessions: [{ id: 's', agent: 'claude-code', startedAt: t.createdAt, endedAt: null }] });
const titles = (threads: Thread[], input: Parameters<typeof rankThreads>[1]) => rankThreads(threads, input).map((r) => r.thread.title);

describe('rankThreads', () => {
  it('ranks file overlap above stuck above plain recent work', () => {
    const threads = [
      thread('plain'),
      thread('stuck', { status: 'stuck' }),
      thread('auth', { files: ['src/auth/session.ts'] }),
    ];
    expect(titles(threads, { me, branch: null, files: ['src/auth/session.ts'], now })).toEqual(['auth', 'stuck']);
  });

  it('matches files mentioned in the prompt by path or distinctive basename', () => {
    const threads = [thread('by path', { files: ['src/api/rate-limit.ts'] }), thread('by name', { files: ['lib/checkout.ts'] })];
    expect(titles(threads, { me, branch: null, text: 'look at src/api/rate-limit.ts', now })).toEqual(['by path']);
    expect(titles(threads, { me, branch: null, text: 'why does checkout.ts throw?', now })).toEqual(['by name']);
  });

  it('ignores generic basenames like index.ts', () => {
    const threads = [thread('generic', { files: ['src/index.ts'] })];
    expect(titles(threads, { me, branch: null, text: 'edit index.ts', now })).toEqual([]);
  });

  it('only includes closed threads when they touched the same files', () => {
    const closed = closeThread(thread('old fix', { files: ['src/db.ts'] }), { now: new Date(hoursAgo(1)) });
    expect(titles([closed], { me, branch: null, now })).toEqual([]);
    const [ranked] = rankThreads([closed], { me, branch: null, files: ['src/db.ts'], now });
    expect(ranked!.reasons).toContain('closed');
  });

  it('excludes given threads and down-weights my own', () => {
    const mine = thread('mine', { status: 'stuck', author: me });
    const theirs = thread('theirs', { status: 'stuck' });
    expect(titles([mine, theirs], { me, branch: null, now })).toEqual(['theirs', 'mine']);
    expect(titles([mine, theirs], { me, branch: null, excludeThreadIds: [theirs.id], now })).toEqual(['mine']);
  });

  it('decays old work and boosts the same feature branch and live sessions', () => {
    const old = thread('old stuck', { status: 'stuck', updatedAt: hoursAgo(24 * 14) });
    const fresh = thread('fresh stuck', { status: 'stuck' });
    const branch = thread('my branch', { branch: 'feat/x' });
    const working = live(thread('working now'));
    const ranked = rankThreads([old, fresh, branch, working], { me, branch: 'feat/x', now });
    expect(ranked.map((r) => r.thread.title)).toEqual(['fresh stuck', 'working now', 'my branch', 'old stuck']);
    expect(ranked.find((r) => r.thread.title === 'old stuck')!.score).toBeLessThan(1.2);
  });
});

describe('findOverlaps', () => {
  it("returns teammates' open recent threads on the file, live first", () => {
    const recent = thread('recent', { files: ['a.ts'] });
    const working = live(thread('working', { files: ['a.ts'], updatedAt: hoursAgo(1.5) }));
    const stale = thread('stale', { files: ['a.ts'], updatedAt: hoursAgo(24 * 10) });
    const mine = thread('mine', { files: ['a.ts'], author: me });
    const done = closeThread(thread('done', { files: ['a.ts'] }));
    expect(findOverlaps([recent, working, stale, mine, done], 'a.ts', { me, now }).map((t) => t.title)).toEqual(['working', 'recent']);
    expect(isLive(working, now)).toBe(true);
  });
});

describe('render', () => {
  it('renders a compact, explainable context block', () => {
    const t = thread('Fix login loop', {
      status: 'stuck',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
      narrative: 'Cookies are set twice.',
      failedApproaches: [{ description: 'clearing cookies', reason: 'still loops', at: hoursAgo(2) }],
    });
    const text = renderContext('Team activity:', rankThreads([t], { me, branch: null, now }), now);
    expect(text).toContain('[sticky-note] Team activity:');
    expect(text).toContain(`STUCK · "Fix login loop" · Alice · 1h ago · branch main · id ${t.id}`);
    expect(text).toContain('Files: a.ts, b.ts, c.ts, d.ts (+1 more)');
    expect(text).toContain("Tried, didn't work: clearing cookies (still loops)");
    expect(text).toContain('Why shown: stuck');
    expect(renderContext('x', [], now)).toBe('');
  });

  it('renders overlap warnings', () => {
    const t = live(thread('Refactor auth', { files: ['a.ts'] }));
    expect(renderOverlapWarning('a.ts', [t], now)).toContain('Alice (working on it right now): "Refactor auth"');
  });
});
