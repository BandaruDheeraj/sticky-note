import { describe, expect, it } from 'vitest';
import { AuditLog, appendAuditEntry, flattenAudit, mergeAuditLogs } from '../../src/core/audit.js';

const alice = { name: 'Alice', email: 'alice@example.com' };
const bob = { name: 'Bob', email: 'bob@example.com' };
const t0 = new Date('2026-10-25T10:00:00Z');
const at = (m: number) => new Date(t0.getTime() + m * 60_000).toISOString();
const empty = (owner = alice) => AuditLog.parse({ schemaVersion: 1, owner });

describe('audit log', () => {
  it('appends entries, filling in `at` from now', () => {
    const log = appendAuditEntry(empty(), { action: 'thread.created', threadId: 't1', detail: 'Fix login' }, t0);
    expect(log.entries).toEqual([{ at: t0.toISOString(), action: 'thread.created', threadId: 't1', detail: 'Fix login' }]);
  });

  it('caps each log at MAX_AUDIT_ENTRIES, dropping the oldest', () => {
    let log = empty();
    for (let i = 0; i < 1005; i++) log = appendAuditEntry(log, { action: 'thread.created', threadId: `t${i}` }, new Date(t0.getTime() + i));
    expect(log.entries).toHaveLength(1000);
    expect(log.entries[0]!.threadId).toBe('t5'); // oldest 5 trimmed
    expect(log.entries.at(-1)!.threadId).toBe('t1004');
  });

  it('merges two machines of the same person: union of entries, deduplicated, capped and sorted', () => {
    const laptop = appendAuditEntry(appendAuditEntry(empty(), { action: 'thread.created', threadId: 't1' }, t0), { action: 'claim.created', file: 'a.ts' }, new Date(t0.getTime() + 60_000));
    const desktop = appendAuditEntry(empty(), { action: 'thread.closed', threadId: 't1' }, new Date(t0.getTime() + 30_000));

    const merged = mergeAuditLogs(laptop, desktop);
    expect(merged.entries.map((e) => e.action)).toEqual(['thread.created', 'thread.closed', 'claim.created']); // sorted by `at`

    // Merging with itself doesn't duplicate.
    expect(mergeAuditLogs(laptop, laptop).entries).toEqual(laptop.entries);
  });

  it('flattens multiple people into one timeline, each entry carrying its actor', () => {
    const aliceLog = appendAuditEntry(empty(alice), { action: 'thread.created', threadId: 't1' }, t0);
    const bobLog = appendAuditEntry(empty(bob), { action: 'claim.created', file: 'b.ts' }, new Date(at(1)));
    expect(flattenAudit([aliceLog, bobLog])).toEqual([
      { at: t0.toISOString(), action: 'thread.created', threadId: 't1', actor: alice },
      { at: at(1), action: 'claim.created', file: 'b.ts', actor: bob },
    ]);
  });
});
