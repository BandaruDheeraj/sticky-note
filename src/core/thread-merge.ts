import type { FailedApproach, Person, SessionRef, Thread } from './thread.js';

/**
 * Combine two versions of the same thread edited on different machines.
 * Symmetric (merge(a, b) equals merge(b, a)), so it doesn't matter which side
 * is local. Rules:
 *  - lists (files, contributors, sessions, failed approaches): union
 *  - status, narrative, title, work type, branch: the most recently updated version
 *  - closed beats open: a teammate's agent that kept working without seeing
 *    the close shouldn't silently reopen the thread
 *  - author and createdAt: from the original creation
 */
export function mergeThreads(a: Thread, b: Thread): Thread {
  if (a.id !== b.id) throw new Error(`Cannot merge different threads ${a.id} and ${b.id}`);
  const [older, newer] = order(a, b);
  const closed = [a, b].filter((t) => t.status === 'closed').sort((x, y) => (x.closedAt ?? '').localeCompare(y.closedAt ?? ''));
  const firstCreated = a.createdAt <= b.createdAt ? a : b;

  return {
    ...newer,
    author: firstCreated.author,
    createdAt: firstCreated.createdAt,
    updatedAt: newer.updatedAt,
    status: closed.length ? 'closed' : newer.status,
    closedAt: closed[0]?.closedAt ?? null,
    narrative: mergeNarrative(older.narrative, newer.narrative),
    files: union(older.files, newer.files, (f) => f),
    contributors: union(older.contributors, newer.contributors, personKey),
    failedApproaches: union(older.failedApproaches, newer.failedApproaches, (f: FailedApproach) => `${f.at}\0${f.description}`),
    sessions: mergeSessions(older.sessions, newer.sessions),
    commits: union(older.commits, newer.commits, (c) => c),
  };
}

/** Deterministic: by updatedAt, then by content so ties don't depend on argument order. */
function order(a: Thread, b: Thread): [Thread, Thread] {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? [a, b] : [b, a];
  return JSON.stringify(a) <= JSON.stringify(b) ? [a, b] : [b, a];
}

/** Narratives grow by appending, so prefer the version that contains the other. */
function mergeNarrative(older: string, newer: string): string {
  if (newer.includes(older)) return newer;
  if (older.includes(newer)) return older;
  return newer;
}

function mergeSessions(a: SessionRef[], b: SessionRef[]): SessionRef[] {
  const byId = new Map<string, SessionRef>();
  for (const s of [...a, ...b]) {
    const prev = byId.get(s.id);
    if (!prev) {
      byId.set(s.id, s);
      continue;
    }
    // An ended session stays ended; keep the later end time and the latest heartbeat.
    byId.set(s.id, {
      ...prev,
      endedAt: maxIso(prev.endedAt, s.endedAt),
      lastActiveAt: maxIso(prev.lastActiveAt, s.lastActiveAt),
    });
  }
  return [...byId.values()].sort((x, y) => x.startedAt.localeCompare(y.startedAt));
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function union<T>(a: T[], b: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of [...a, ...b]) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

function personKey(p: Person): string {
  return p.email ? p.email.toLowerCase() : `name:${p.name}`;
}
