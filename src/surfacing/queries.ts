import { claimsByOthers, type ActiveClaim, type ClaimSet } from '../core/claim.js';
import type { Person, Thread } from '../core/thread.js';
import { findOverlaps, type RankedThread } from './relevance.js';

/**
 * Read-only questions about team activity, shared by hooks and the MCP server
 * so an agent gets the same answer whichever way it asks.
 */

export interface FileOverlap {
  file: string;
  claims: ActiveClaim[];
  threads: Thread[];
}

/** Teammates' claims and open threads on each file; files with neither are omitted. */
export function overlapsFor(
  files: string[],
  threads: Thread[],
  claimSets: ClaimSet[],
  opts: { me: Person; excludeThreadIds?: string[]; now: Date },
): FileOverlap[] {
  return files
    .map((file) => ({
      file,
      claims: claimsByOthers(claimSets, file, opts.me, opts.now),
      threads: findOverlaps(threads, file, opts),
    }))
    .filter((o) => o.claims.length > 0 || o.threads.length > 0);
}

/**
 * Threads that worked on `file`: they listed it, or one of their recorded
 * commits changed it (git history → thread). Newest first.
 */
export function fileHistory(
  threads: Thread[],
  file: string,
  fileCommits: Iterable<string>,
  opts: { exclude?: (thread: Thread) => boolean } = {},
): RankedThread[] {
  const commits = new Set(fileCommits);
  const found: RankedThread[] = [];
  for (const thread of threads) {
    if (opts.exclude?.(thread)) continue;
    const commit = thread.commits.find((c) => commits.has(c));
    if (!thread.files.includes(file) && !commit) continue;
    const reasons = [commit ? `changed ${file} (commit ${commit.slice(0, 7)})` : `touched ${file}`];
    if (thread.status === 'closed') reasons.push('closed');
    found.push({ thread, score: 0, reasons, matchedFiles: [file] });
  }
  return found.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
}

/**
 * Case-insensitive search over title, notes, files and failed approaches.
 * Every query word must match somewhere; title matches rank highest.
 */
export function searchThreads(threads: Thread[], query: string): RankedThread[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const results: RankedThread[] = [];

  for (const thread of threads) {
    const fields: [string, string, number][] = [
      ['title', thread.title, 3],
      ['notes', thread.narrative, 1],
      ['files', thread.files.join(' '), 2],
      ['failed approaches', thread.failedApproaches.map((f) => `${f.description} ${f.reason ?? ''}`).join(' '), 1.5],
    ];
    let score = 0;
    const where = new Set<string>();
    const matchesAll = words.every((w) => {
      let hit = false;
      for (const [name, text, weight] of fields) {
        if (text.toLowerCase().includes(w)) {
          score += weight;
          where.add(name);
          hit = true;
        }
      }
      return hit;
    });
    if (!matchesAll) continue;
    const matchedFiles = thread.files.filter((f) => words.some((w) => f.toLowerCase().includes(w)));
    results.push({ thread, score, reasons: [`matched ${[...where].join(', ')}`], matchedFiles });
  }
  return results.sort((a, b) => b.score - a.score || b.thread.updatedAt.localeCompare(a.thread.updatedAt));
}
