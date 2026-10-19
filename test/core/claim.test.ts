import { describe, expect, it } from 'vitest';
import { activeClaims, addClaims, ClaimSet, claimsByOthers, mergeClaimSets, ownerKey, removeClaims } from '../../src/core/claim.js';
import { createThread, heartbeat } from '../../src/core/thread.js';
import { isLive } from '../../src/surfacing/relevance.js';

const alice = { name: 'Alice', email: 'Alice@Example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const t0 = new Date('2026-10-18T10:00:00Z');
const hours = (h: number) => new Date(t0.getTime() + h * 3_600_000);
const empty = (owner = alice) => ClaimSet.parse({ schemaVersion: 1, owner });

describe('claims', () => {
  it('adds, refreshes, expires and removes claims', () => {
    let set = addClaims(empty(), ['a.ts', 'b.ts'], { reason: 'migration', hours: 2, now: t0 });
    expect(set.claims.map((c) => c.file)).toEqual(['a.ts', 'b.ts']);
    expect(set.claims[0]).toMatchObject({ reason: 'migration', expiresAt: hours(2).toISOString() });

    set = addClaims(set, ['a.ts'], { hours: 8, now: hours(1) }); // refresh
    expect(activeClaims([set], hours(3)).map((c) => c.file)).toEqual(['a.ts']); // b.ts expired

    expect(removeClaims(set, ['a.ts'], hours(1)).claims.map((c) => c.file)).toEqual(['b.ts']);
    expect(removeClaims(set, [], hours(1)).claims).toEqual([]); // empty list releases all
  });

  it("finds other people's active claims on a file", () => {
    const sets = [addClaims(empty(alice), ['a.ts'], { now: t0 }), addClaims(empty(bob), ['a.ts'], { now: t0 })];
    expect(claimsByOthers(sets, 'a.ts', bob, hours(1)).map((c) => c.owner.name)).toEqual(['Alice']);
    expect(claimsByOthers(sets, 'a.ts', bob, hours(9))).toEqual([]);
  });

  it('merges two machines of the same person: latest claim per file wins', () => {
    const laptop = addClaims(empty(), ['a.ts'], { reason: 'old', now: t0 });
    const desktop = addClaims(empty(), ['a.ts', 'b.ts'], { reason: 'new', now: hours(1) });
    const merged = mergeClaimSets(laptop, desktop);
    expect(merged.claims.map((c) => [c.file, c.reason])).toEqual([['a.ts', 'new'], ['b.ts', 'new']]);
  });

  it('derives a stable, filename-safe owner key', () => {
    expect(ownerKey(alice)).toBe('alice-example.com');
    expect(ownerKey({ name: 'Jane Doe' })).toBe('jane-doe');
  });
});

describe('heartbeat and presence', () => {
  it('marks the open session active and attaches commits', () => {
    const t = createThread({ title: 'x', author: alice, branch: 'main', session: { id: 's1', agent: 'claude-code', startedAt: t0.toISOString() }, now: t0 });
    expect(isLive(t, hours(1))).toBe(false); // created an hour ago, no heartbeat since

    const beat = heartbeat(t, 's1', { commits: ['abc'], now: hours(1) });
    expect(beat.sessions[0]!.lastActiveAt).toBe(hours(1).toISOString());
    expect(beat.commits).toEqual(['abc']);
    expect(isLive(beat, hours(1.25))).toBe(true);
    expect(isLive(beat, hours(2))).toBe(false); // heartbeat older than 30 min
    expect(heartbeat(beat, 'unknown-session', { commits: ['abc'] })).toBe(beat); // nothing changed
  });
});
