import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const ThreadStatus = z.enum(['active', 'stuck', 'closed']);
export type ThreadStatus = z.infer<typeof ThreadStatus>;

export const WorkType = z.enum(['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'investigation', 'other']);
export type WorkType = z.infer<typeof WorkType>;

export const Person = z.object({
  name: z.string(),
  email: z.string().optional(),
});
export type Person = z.infer<typeof Person>;

export const FailedApproach = z.object({
  description: z.string(),
  reason: z.string().optional(),
  at: z.string().datetime(),
});
export type FailedApproach = z.infer<typeof FailedApproach>;

/** One agent session that contributed to a thread. */
export const SessionRef = z.object({
  id: z.string(),
  /** Which coding agent ran it, e.g. "claude-code". */
  agent: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  /** Heartbeat from the end of the session's latest turn; drives presence. */
  lastActiveAt: z.string().datetime().nullable().default(null),
});
export type SessionRef = z.infer<typeof SessionRef>;

/**
 * A thread is the unit of shared context: one goal pursued by one or more
 * people's agents. Stored as threads/<id>.json on the data branch.
 */
export const Thread = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  status: ThreadStatus,
  workType: WorkType.default('other'),
  author: Person,
  contributors: z.array(Person).default([]),
  branch: z.string().nullable(),
  files: z.array(z.string()).default([]),
  narrative: z.string().default(''),
  failedApproaches: z.array(FailedApproach).default([]),
  sessions: z.array(SessionRef).default([]),
  /** Commits made during this thread's sessions, linking code history back to the thread. */
  commits: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().default(null),
});
export type Thread = z.infer<typeof Thread>;

/** Time-sortable, collision-resistant id, e.g. "m2abc123-9f3e1a". */
export function newThreadId(now = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export interface NewThreadInput {
  title: string;
  author: Person;
  branch: string | null;
  workType?: WorkType;
  files?: string[];
  narrative?: string;
  session?: { id: string; agent: string; startedAt: string; lastActiveAt?: string };
  now?: Date;
}

export function createThread(input: NewThreadInput): Thread {
  const now = input.now ?? new Date();
  const iso = now.toISOString();
  return Thread.parse({
    schemaVersion: 1,
    id: newThreadId(now),
    title: input.title,
    status: 'active',
    workType: input.workType ?? 'other',
    author: input.author,
    contributors: [input.author],
    branch: input.branch,
    files: dedupe(input.files ?? []),
    narrative: input.narrative ?? '',
    sessions: input.session ? [{ endedAt: null, lastActiveAt: null, ...input.session }] : [],
    createdAt: iso,
    updatedAt: iso,
  });
}

/** Record work done in a session: touched files and who did it. Returns the same object if nothing changed. */
export function recordActivity(thread: Thread, activity: { files: string[]; person: Person; now?: Date }): Thread {
  const files = dedupe([...thread.files, ...activity.files]);
  const isNewContributor = !thread.contributors.some((p) => samePerson(p, activity.person));
  if (files.length === thread.files.length && !isNewContributor) return thread;
  return {
    ...thread,
    files,
    contributors: isNewContributor ? [...thread.contributors, activity.person] : thread.contributors,
    updatedAt: (activity.now ?? new Date()).toISOString(),
  };
}

/**
 * Attach a new session to an existing thread, continuing it instead of
 * starting fresh. Reopens a closed thread, since someone is working on it
 * again. The old session (if any) is ended separately by the caller first.
 */
export function resumeThread(
  thread: Thread,
  session: { id: string; agent: string; startedAt: string },
  now = new Date(),
): Thread {
  const iso = now.toISOString();
  const wasClosed = thread.status === 'closed';
  return {
    ...thread,
    status: wasClosed ? 'active' : thread.status,
    closedAt: wasClosed ? null : thread.closedAt,
    sessions: [...thread.sessions, { id: session.id, agent: session.agent, startedAt: session.startedAt, endedAt: null, lastActiveAt: iso }],
    updatedAt: iso,
  };
}

export function endSession(thread: Thread, sessionId: string, now = new Date()): Thread {
  const iso = now.toISOString();
  if (!thread.sessions.some((s) => s.id === sessionId && s.endedAt === null)) return thread;
  return {
    ...thread,
    sessions: thread.sessions.map((s) => (s.id === sessionId ? { ...s, endedAt: iso } : s)),
    updatedAt: iso,
  };
}

/** Mark a session active now and attach any new commits. Returns the same object if nothing changed. */
export function heartbeat(thread: Thread, sessionId: string, opts: { commits?: string[]; now?: Date } = {}): Thread {
  const iso = (opts.now ?? new Date()).toISOString();
  const commits = dedupe([...thread.commits, ...(opts.commits ?? [])]);
  const hasSession = thread.sessions.some((s) => s.id === sessionId && s.endedAt === null);
  if (!hasSession && commits.length === thread.commits.length) return thread;
  return {
    ...thread,
    commits,
    sessions: thread.sessions.map((s) => (s.id === sessionId && s.endedAt === null ? { ...s, lastActiveAt: iso } : s)),
    updatedAt: commits.length > thread.commits.length ? iso : thread.updatedAt,
  };
}

/** A short single-line title derived from free text such as a user's first prompt. */
export function titleFromText(text: string, maxLength = 80): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled';
  return line.length <= maxLength ? line : `${line.slice(0, maxLength - 1).trimEnd()}…`;
}

export function samePerson(a: Person, b: Person): boolean {
  return a.email && b.email ? a.email.toLowerCase() === b.email.toLowerCase() : a.name === b.name;
}

export function closeThread(thread: Thread, opts: { summary?: string; now?: Date } = {}): Thread {
  const iso = (opts.now ?? new Date()).toISOString();
  const narrative = opts.summary
    ? [thread.narrative, opts.summary].filter(Boolean).join('\n\n')
    : thread.narrative;
  return { ...thread, status: 'closed', narrative, closedAt: iso, updatedAt: iso };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
