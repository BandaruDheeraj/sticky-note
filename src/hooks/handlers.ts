import { SessionState, type SessionStore } from '../core/session.js';
import type { ThreadStore } from '../core/store/thread-store.js';
import { createThread, endSession, recordActivity, titleFromText, type Person, type Thread } from '../core/thread.js';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  PROMPT_LIMIT,
  PROMPT_MIN_SCORE,
  SESSION_START_LIMIT,
  SESSION_START_MIN_SCORE,
} from '../surfacing/policy.js';
import { findOverlaps, isLive, rankThreads, type RankedThread } from '../surfacing/relevance.js';
import { renderContext, renderOverlapWarning } from '../surfacing/render.js';
import { editedFiles } from './edited-files.js';
import type { HookEvent, HookResult } from './events.js';

export interface HookDeps {
  store: ThreadStore;
  sessions: SessionStore;
  identity: Person;
  repoRoot: string;
  currentBranch(): Promise<string | null>;
  /** Start a detached sync so hooks never wait on the network. */
  syncInBackground(): void;
  now(): Date;
  log(message: string): Promise<void>;
}

/**
 * What each event does. Only turn-end and session-end write to git; the others
 * update the local session file and read threads, so they stay fast.
 *  - session-start: remember the session, start a sync, show stuck/live/branch work
 *  - prompt:        plan the thread on the first prompt; show threads related to the prompt
 *  - tool-before:   warn once per file if a teammate's open thread touches it
 *  - tool-used:     note edited files
 *  - turn-end:      commit the planned thread and noted files; background sync (at once for a new thread, else throttled)
 *  - session-end:   flush, mark the session ended, forget it, and sync
 */
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<HookResult> {
  switch (event.kind) {
    case 'session-start': {
      deps.syncInBackground();
      return deps.sessions.update<HookResult>(event.sessionId, async (cur) => {
        const state = { ...(cur ?? freshSession(event, deps)), lastSyncAt: deps.now().toISOString() };
        const { threads } = await deps.store.list();
        const selected = rankThreads(threads, {
          me: deps.identity,
          branch: await deps.currentBranch(),
          excludeThreadIds: ownThreadIds(state),
          now: deps.now(),
        })
          .filter((r) => r.score >= SESSION_START_MIN_SCORE)
          .slice(0, SESSION_START_LIMIT);
        return {
          next: markSurfaced(state, selected),
          result: {
            context: renderContext('Team activity in this repo:', selected, deps.now()),
            notice: summarize(selected, deps.now()),
          },
        };
      });
    }

    case 'prompt':
      return deps.sessions.update<HookResult>(event.sessionId, async (cur) => {
        let state = cur ?? freshSession(event, deps);
        if (!state.threadId && !state.pendingThread) {
          const pendingThread = { title: titleFromText(event.prompt), branch: await deps.currentBranch(), createdAt: deps.now().toISOString() };
          state = { ...state, pendingThread, updatedAt: deps.now().toISOString() };
        }

        const { threads } = await deps.store.list();
        const own = threads.find((t) => t.id === state.threadId);
        const selected = rankThreads(threads, {
          me: deps.identity,
          branch: await deps.currentBranch(),
          text: event.prompt,
          files: [...(own?.files ?? []), ...state.pendingFiles],
          excludeThreadIds: ownThreadIds(state),
          now: deps.now(),
        })
          .filter((r) => r.score >= PROMPT_MIN_SCORE && state.surfaced[r.thread.id] !== r.thread.updatedAt)
          .slice(0, PROMPT_LIMIT);
        return {
          next: markSurfaced(state, selected),
          result: { context: renderContext('Related work by your team:', selected, deps.now()), notice: summarize(selected, deps.now()) },
        };
      });

    case 'tool-before': {
      const files = editedFiles(event.toolName, event.toolInput, event.cwd, deps.repoRoot);
      if (files.length === 0) return {};
      return deps.sessions.update<HookResult>(event.sessionId, async (cur) => {
        const state = cur ?? freshSession(event, deps);
        const unwarned = files.filter((f) => !state.warnedFiles.includes(f));
        if (unwarned.length === 0) return { next: state, result: {} };

        const { threads } = await deps.store.list();
        const now = deps.now();
        const warnings: { file: string; threads: Thread[] }[] = [];
        for (const file of unwarned) {
          const overlaps = findOverlaps(threads, file, { me: deps.identity, excludeThreadIds: ownThreadIds(state), now });
          if (overlaps.length) warnings.push({ file, threads: overlaps });
        }
        if (warnings.length === 0) return { next: state, result: {} };

        const first = warnings[0]!;
        const lead = first.threads[0]!;
        const who = lead.contributors.at(-1)?.name ?? lead.author.name;
        return {
          next: { ...state, warnedFiles: [...state.warnedFiles, ...warnings.map((w) => w.file)] },
          result: {
            context: warnings.map((w) => renderOverlapWarning(w.file, w.threads, now)).join('\n\n'),
            notice: `sticky-note: ${who} ${isLive(lead, now) ? 'is working on' : 'has open work on'} ${first.file} ("${lead.title}")${warnings.length > 1 ? ` and ${warnings.length - 1} more file(s)` : ''}`,
          },
        };
      });
    }

    case 'tool-used': {
      const files = editedFiles(event.toolName, event.toolInput, event.cwd, deps.repoRoot);
      if (files.length === 0) return {};
      await deps.sessions.update(event.sessionId, async (cur) => {
        const state = cur ?? freshSession(event, deps);
        const pendingFiles = [...new Set([...state.pendingFiles, ...files])];
        return { next: { ...state, pendingFiles, updatedAt: deps.now().toISOString() }, result: undefined };
      });
      return {};
    }

    case 'turn-end':
      await deps.sessions.update(event.sessionId, async (cur) => {
        if (!cur) return { next: null, result: undefined };
        let state = await flush(cur, deps);
        const sinceSync = state.lastSyncAt ? deps.now().getTime() - Date.parse(state.lastSyncAt) : Infinity;
        // Publish a brand-new thread right away so teammates see the session; otherwise throttle.
        const justCreated = !cur.threadId && state.threadId !== null;
        if (justCreated || sinceSync >= BACKGROUND_SYNC_INTERVAL_MS) {
          deps.syncInBackground();
          state = { ...state, lastSyncAt: deps.now().toISOString() };
        }
        return { next: state, result: undefined };
      });
      return {};

    case 'session-end': {
      await deps.sessions.update(event.sessionId, async (cur) => {
        if (!cur) return { next: null, result: undefined };
        const state = await flush(cur, deps);
        const thread = state.threadId ? await deps.store.get(state.threadId) : null;
        if (thread) {
          const ended = endSession(thread, state.sessionId, deps.now());
          if (ended !== thread) await deps.store.save(ended, `thread ${thread.id}: session ended`);
        }
        return { next: null, result: undefined };
      });
      const result = await deps.store.sync();
      await deps.log(result.skipped ? `sync skipped: ${result.skipped}` : `synced: pulled ${result.pulled}, pushed ${result.pushed}${result.merged ? `, merged ${result.merged} thread(s)` : ''}`);
      return {};
    }
  }
}

/** Commit the session's planned thread and pending files; returns the updated session state. */
async function flush(state: SessionState, deps: HookDeps): Promise<SessionState> {
  const now = deps.now();

  if (!state.threadId && state.pendingThread) {
    const thread = createThread({
      title: state.pendingThread.title,
      author: deps.identity,
      branch: state.pendingThread.branch,
      files: state.pendingFiles,
      session: { id: state.sessionId, agent: state.agent, startedAt: state.startedAt },
      now: new Date(state.pendingThread.createdAt),
    });
    await deps.store.save(thread, `thread ${thread.id}: started in ${state.agent}`);
    return { ...state, threadId: thread.id, pendingThread: null, pendingFiles: [], updatedAt: now.toISOString() };
  }

  if (!state.threadId || state.pendingFiles.length === 0) return state;
  const thread = await deps.store.get(state.threadId);
  if (thread) {
    const updated = recordActivity(thread, { files: state.pendingFiles, person: deps.identity, now });
    if (updated !== thread) await deps.store.save(updated, `thread ${thread.id}: ${state.pendingFiles.length} file(s) touched`);
  }
  return { ...state, pendingFiles: [], updatedAt: now.toISOString() };
}

function ownThreadIds(state: SessionState): string[] {
  return state.threadId ? [state.threadId] : [];
}

function markSurfaced(state: SessionState, shown: RankedThread[]): SessionState {
  if (shown.length === 0) return state;
  const surfaced = { ...state.surfaced };
  for (const { thread } of shown) surfaced[thread.id] = thread.updatedAt;
  return { ...state, surfaced };
}

/** One line for the person, e.g. `sticky-note: 3 related threads (1 stuck, 1 in progress) — "Fix login" by Alice, …` */
function summarize(shown: RankedThread[], now: Date): string | undefined {
  if (shown.length === 0) return undefined;
  const stuck = shown.filter((r) => r.thread.status === 'stuck').length;
  const live = shown.filter((r) => isLive(r.thread, now)).length;
  const tags = [stuck && `${stuck} stuck`, live && `${live} in progress`].filter(Boolean).join(', ');
  const names = shown.slice(0, 2).map((r) => `"${r.thread.title}" by ${r.thread.author.name}`).join(', ');
  const noun = shown.length === 1 ? 'thread' : 'threads';
  return `sticky-note: ${shown.length} related ${noun}${tags ? ` (${tags})` : ''} — ${names}${shown.length > 2 ? ', …' : ''}`;
}

function freshSession(event: HookEvent, deps: HookDeps): SessionState {
  const iso = deps.now().toISOString();
  return SessionState.parse({ sessionId: event.sessionId, agent: event.agent, startedAt: iso, updatedAt: iso });
}
