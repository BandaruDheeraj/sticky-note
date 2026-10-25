import { z } from 'zod';
import { Person } from './thread.js';

export const AuditAction = z.enum([
  'thread.created',
  'thread.resumed',
  'thread.closed',
  'claim.created',
  'claim.released',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditEntry = z.object({
  at: z.string().datetime(),
  action: AuditAction,
  threadId: z.string().optional(),
  /** Set for claim.* actions. */
  file: z.string().optional(),
  detail: z.string().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

/** An entry with its actor attached, for display and the audit API. */
export interface AuditRecord extends AuditEntry {
  actor: Person;
}

/** Keep each person's log bounded; oldest entries are trimmed first. */
export const MAX_AUDIT_ENTRIES = 1000;

/**
 * One person's audit trail, stored as audit/<owner-key>.json. One file per
 * person means teammates never write the same file, so entries can't conflict.
 */
export const AuditLog = z.object({
  schemaVersion: z.literal(1),
  owner: Person,
  entries: z.array(AuditEntry).default([]),
});
export type AuditLog = z.infer<typeof AuditLog>;

export function appendAuditEntry(log: AuditLog, entry: Omit<AuditEntry, 'at'> & { at?: string }, now = new Date()): AuditLog {
  const full = AuditEntry.parse({ ...entry, at: entry.at ?? now.toISOString() });
  return { ...log, entries: [...log.entries, full].slice(-MAX_AUDIT_ENTRIES) };
}

/** Merge two versions of one person's log (same person on two machines): union by content, newest-capped. */
export function mergeAuditLogs(a: AuditLog, b: AuditLog): AuditLog {
  const key = (e: AuditEntry) => `${e.at}\0${e.action}\0${e.threadId ?? ''}\0${e.file ?? ''}`;
  const seen = new Map<string, AuditEntry>();
  for (const e of [...a.entries, ...b.entries]) seen.set(key(e), e);
  const entries = [...seen.values()].sort((x, y) => x.at.localeCompare(y.at)).slice(-MAX_AUDIT_ENTRIES);
  return { ...a, entries };
}

export function flattenAudit(logs: AuditLog[]): AuditRecord[] {
  return logs.flatMap((l) => l.entries.map((e) => ({ ...e, actor: l.owner })));
}
