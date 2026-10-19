import path from 'node:path';
import { samePerson, type Person, type Thread } from '../core/thread.js';

const HOUR = 3_600_000;
/** A thread with an open session updated this recently counts as being worked on right now. */
export const LIVE_WINDOW_MS = 2 * HOUR;
/** Open threads untouched for longer than this no longer trigger overlap warnings. */
export const OVERLAP_WINDOW_MS = 7 * 24 * HOUR;
const RECENCY_HALF_LIFE_HOURS = 48;
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop']);

export interface RelevanceInput {
  me: Person;
  branch: string | null;
  /** Repo-relative files the current work involves. */
  files?: string[];
  /** Free text (e.g. the user's prompt) scanned for mentions of a thread's files. */
  text?: string;
  /** Threads never to surface, e.g. the current session's own thread. */
  excludeThreadIds?: string[];
  now: Date;
}

export interface RankedThread {
  thread: Thread;
  score: number;
  /** Human-readable reasons, shown alongside the thread so the ranking is explainable. */
  reasons: string[];
  matchedFiles: string[];
}

export function isLive(thread: Thread, now: Date): boolean {
  return (
    thread.status !== 'closed' &&
    thread.sessions.some((s) => s.endedAt === null) &&
    now.getTime() - Date.parse(thread.updatedAt) < LIVE_WINDOW_MS
  );
}

export function isMine(thread: Thread, me: Person): boolean {
  return samePerson(thread.author, me);
}

/**
 * Score threads for relevance to what the user is doing. Signals: file overlap,
 * stuck status, live work, same branch, recency. Closed threads only count when
 * they touched the same files (their failed approaches are still worth knowing).
 */
export function rankThreads(threads: Thread[], input: RelevanceInput): RankedThread[] {
  const exclude = new Set(input.excludeThreadIds ?? []);
  const files = new Set(input.files ?? []);
  const text = input.text ?? '';
  const ranked: RankedThread[] = [];

  for (const thread of threads) {
    if (exclude.has(thread.id)) continue;
    const matchedFiles = thread.files.filter((f) => files.has(f) || mentions(text, f));
    if (thread.status === 'closed' && matchedFiles.length === 0) continue;

    const reasons: string[] = [];
    let score = 0;
    if (matchedFiles.length) {
      score += 4 + Math.min(matchedFiles.length - 1, 4) * 0.5;
      reasons.push(`touches ${matchedFiles.slice(0, 3).join(', ')}${matchedFiles.length > 3 ? ', …' : ''}`);
    }
    if (thread.status === 'stuck') {
      score += 3;
      reasons.push('stuck');
    }
    if (isLive(thread, input.now)) {
      score += 2; // live work is what collides, so it outranks a same-branch match
      reasons.push('in progress now');
    }
    if (input.branch && thread.branch === input.branch) {
      score += DEFAULT_BRANCHES.has(input.branch) ? 0.5 : 1.5;
      reasons.push(`same branch (${input.branch})`);
    }
    if (thread.status === 'closed') {
      score *= 0.5;
      reasons.push('closed');
    }
    if (isMine(thread, input.me)) score *= 0.6; // teammates' work is what you're least likely to know

    const ageHours = Math.max(0, input.now.getTime() - Date.parse(thread.updatedAt)) / HOUR;
    score *= 0.3 + 0.7 * Math.pow(0.5, ageHours / RECENCY_HALF_LIFE_HOURS);

    if (score > 0) ranked.push({ thread, score: Math.round(score * 100) / 100, reasons, matchedFiles });
  }

  return ranked.sort((a, b) => b.score - a.score || b.thread.updatedAt.localeCompare(a.thread.updatedAt));
}

/** Teammates' open, recent threads that touched `file`; live ones first. */
export function findOverlaps(threads: Thread[], file: string, input: Pick<RelevanceInput, 'me' | 'excludeThreadIds' | 'now'>): Thread[] {
  const exclude = new Set(input.excludeThreadIds ?? []);
  return threads
    .filter(
      (t) =>
        !exclude.has(t.id) &&
        t.status !== 'closed' &&
        !isMine(t, input.me) &&
        t.files.includes(file) &&
        input.now.getTime() - Date.parse(t.updatedAt) < OVERLAP_WINDOW_MS,
    )
    .sort((a, b) => Number(isLive(b, input.now)) - Number(isLive(a, input.now)) || b.updatedAt.localeCompare(a.updatedAt));
}

/** Does `text` mention `file`, by full path or by a distinctive basename? */
function mentions(text: string, file: string): boolean {
  if (!text) return false;
  if (text.includes(file)) return true;
  const base = path.posix.basename(file);
  // Short or generic names (index.ts, a.js) would match too much.
  if (base.length < 6 || /^(index|main|utils?|types?)\./.test(base)) return false;
  return new RegExp(`(^|[^\\w.-])${escapeRegExp(base)}($|[^\\w-])`).test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
