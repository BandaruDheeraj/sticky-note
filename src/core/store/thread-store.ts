import type { Thread, ThreadStatus } from '../thread.js';

export interface ThreadFilter {
  status?: ThreadStatus | ThreadStatus[];
  author?: string;
}

export interface SyncResult {
  /** Why nothing was synced, if nothing was. */
  skipped?: 'no-remote';
  /** Commits pulled from the remote. */
  pulled: number;
  /** Commits pushed to the remote. */
  pushed: number;
}

export interface StoreStatus {
  backend: string;
  location: string;
  head: string | null;
  remote: string | null;
  /** Local commits not yet on the remote's last-fetched state. */
  ahead: number | null;
  behind: number | null;
}

export interface InvalidRecord {
  file: string;
  error: string;
}

/**
 * Storage backend for threads. The git data branch is the default; a
 * Cloudflare backend can implement the same contract later.
 */
export interface ThreadStore {
  /** Idempotent: prepare storage so reads and writes work. */
  init(): Promise<void>;
  list(filter?: ThreadFilter): Promise<{ threads: Thread[]; invalid: InvalidRecord[] }>;
  /** Look up by full id or unique id prefix. */
  get(idOrPrefix: string): Promise<Thread | null>;
  save(thread: Thread, message?: string): Promise<void>;
  sync(): Promise<SyncResult>;
  status(): Promise<StoreStatus>;
}

export class AmbiguousIdError extends Error {
  constructor(readonly prefix: string, readonly matches: string[]) {
    super(`Thread id "${prefix}" is ambiguous; matches: ${matches.join(', ')}`);
    this.name = 'AmbiguousIdError';
  }
}

export class SyncConflictError extends Error {
  constructor(detail: string) {
    super(`Could not merge remote thread data: ${detail}`);
    this.name = 'SyncConflictError';
  }
}

export function matchesFilter(thread: Thread, filter: ThreadFilter = {}): boolean {
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (!statuses.includes(thread.status)) return false;
  }
  if (filter.author) {
    const needle = filter.author.toLowerCase();
    const people = [thread.author, ...thread.contributors];
    if (!people.some((p) => p.name.toLowerCase() === needle || p.email?.toLowerCase() === needle)) return false;
  }
  return true;
}
