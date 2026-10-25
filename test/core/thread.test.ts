import { describe, expect, it } from 'vitest';
import { closeThread, createThread, resumeThread } from '../../src/core/thread.js';

const alice = { name: 'Alice', email: 'alice@example.com' };
const t0 = new Date('2026-10-25T10:00:00Z');
const at = (m: number) => new Date(t0.getTime() + m * 60_000);

describe('resumeThread', () => {
  it('adds a new, open session ref without disturbing earlier sessions', () => {
    const thread = createThread({
      title: 'Fix login',
      author: alice,
      branch: 'main',
      session: { id: 's1', agent: 'claude-code', startedAt: t0.toISOString() },
      now: t0,
    });
    const resumed = resumeThread(thread, { id: 's2', agent: 'claude-code', startedAt: at(10).toISOString() }, at(10));

    expect(resumed.sessions).toHaveLength(2);
    expect(resumed.sessions[0]).toMatchObject({ id: 's1' }); // untouched
    expect(resumed.sessions[1]).toMatchObject({ id: 's2', endedAt: null, lastActiveAt: at(10).toISOString() });
    expect(resumed.updatedAt).toBe(at(10).toISOString());
  });

  it('reopens a closed thread', () => {
    const closed = closeThread(createThread({ title: 'Fix login', author: alice, branch: 'main', now: t0 }), { now: at(5) });
    expect(closed.status).toBe('closed');

    const resumed = resumeThread(closed, { id: 's1', agent: 'claude-code', startedAt: at(10).toISOString() }, at(10));
    expect(resumed.status).toBe('active');
    expect(resumed.closedAt).toBeNull();
  });

  it('leaves an already-active thread active', () => {
    const thread = createThread({ title: 'Fix login', author: alice, branch: 'main', now: t0 });
    const resumed = resumeThread(thread, { id: 's1', agent: 'claude-code', startedAt: at(1).toISOString() }, at(1));
    expect(resumed.status).toBe('active');
  });
});
