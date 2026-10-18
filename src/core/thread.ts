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
    createdAt: iso,
    updatedAt: iso,
  });
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
