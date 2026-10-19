import { SessionState, type SessionStore } from '../core/session.js';
import type { ThreadStore } from '../core/store/thread-store.js';
import { claimsByOthers, type ActiveClaim } from '../core/claim.js';
import { createThread, endSession, heartbeat, recordActivity, titleFromText, type Person, type Thread } from '../core/thread.js';
import {
  BACKGROUND_SYNC_INTERVAL_MS,
  HISTORY_LIMIT,
  PROMPT_LIMIT,
  PROMPT_MIN_SCORE,
  SESSION_START_LIMIT,
  SESSION_START_MIN_SCORE,
} from '../surfacing/policy.js';
import { findOverlaps, isLive, rankThreads, type RankedThread } from '../surfacing/relevance.js';
import { renderClaimWarning, renderContext, renderOverlapWarning } from '../surfacing/render.js';
import { editedFiles, touchedFiles } from './edited-files.js';
import type { HookEvent, HookResult } from './events.js';

export interface HookDeps {
  store: ThreadStore;
  sessions: SessionStore;
  identity: Person;
  repoRoot: string;
  currentBranch(): Promise<string | null>;
  /** Start a detached sync so hooks never wait on the network. */
  syncInBackground(): void;
  /** Current HEAD commit, or null in a repo with no commits. */
  head(): Promise<string | null>;
  /** My commits in base..HEAD (for attributing commits to the session's thread). */
  myCommitsSince(base: string): Promise<string[]>;
  /** Recent commits that changed `file`. */
  fileCommits(file: string): Promise<string[]>;
  now(): Date;
  log(message: string): Promise<void>;
}

/**
 * What each event does. Only turn-end and session-end write to git; the others
 * update the local session file and read threads, so they stay fast.
 *  - session-start: remember the session, start a sync, show stuck/live/branch work
 *  - prompt:        plan the thread on the first prompt; show threads related to the prompt
 *  - tool-before:   before an edit, warn once per file about teammates' claims or open threads on it,
 *                   and show the file's history the first time it's touched
 *  - tool-used:     note edited files; after a read, show the file's history on first touch
 *  - turn-end:      commit the planned thread and noted files, heartbeat + new commits;
 *                   background sync (at once for a new thread, else throttled)
 *  - session-end:   flush, mark the session ended, forget it, and sync
 */
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<HookResult> {
  switch (event.kind) {
    case 'session-start': {
      deps.syncInBackground();
      return deps.sessions.update<HookResult>(event.sessionId, async (cur) => {
        const base = cur ?? freshSession(event, deps);
        const state = { ...base, baseHead: base.baseHead ?? (await deps.head()), lastSyncAt: deps.now().toISOString() };
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
        let state = cur ?? freshSession(event, deps);
        const unwarned = files.filter((f) => !state.warnedFiles.includes(f));
        const firstTouch = files.filter((f) => !state.touchedFiles.includes(f));
        if (unwarned.length === 0 && firstTouch.length === 0) return { next: state, result: {} };

        const [{ threads }, claimSets] = await Promise.all([deps.store.list(), deps.store.listClaims()]);
        const now = deps.now();
        const parts: string[] = [];
        let notice: string | undefined;

        // 1. Overlap: someone else's claim or open thread on the file.
        const warned: string[] = [];
        const warnedThreadIds = new Set<string>();
        for (const file of unwarned) {
          const claims = claimsByOthers(claimSets, file, deps.identity, now);
          const overlaps = findOverlaps(threads, file, { me: deps.identity, excludeThreadIds: ownThreadIds(state), now });
          if (claims.length === 0 && overlaps.length === 0) continue;
          warned.push(file);
          overlaps.forEach((t) => warnedThreadIds.add(t.id));
          if (claims.length) parts.push(renderClaimWarning(file, claims, now));
          if (overlaps.length) parts.push(renderOverlapWarning(file, overlaps, now));
          notice ??= overlapNotice(file, claims, overlaps, now);
        }
        if (warned.length > 1) notice += ` and ${warned.length - 1} more file(s)`;

        // 2. History: earlier threads on files touched for the first time this session.
        const history = await historyFor(firstTouch, threads, state, deps, warnedThreadIds);
        if (history.text) parts.push(history.text);

        state = markSurfaced(
          { ...state, warnedFiles: [...state.warnedFiles, ...warned], touchedFiles: [...state.touchedFiles, ...firstTouch] },
          history.shown,
        );
        return { next: state, result: { context: parts.join('\n\n') || undefined, notice: notice ?? summarize(history.shown, now) } };
      });
    }

    case 'tool-used': {
      const edited = editedFiles(event.toolName, event.toolInput, event.cwd, deps.repoRoot);
      const touched = touchedFiles(event.toolName, event.toolInput, event.cwd, deps.repoRoot);
      if (touched.length === 0) return {};
      return deps.sessions.update<HookResult>(event.sessionId, async (cur) => {
        let state = cur ?? freshSession(event, deps);
        if (edited.length) state = { ...state, pendingFiles: [...new Set([...state.pendingFiles, ...edited])], updatedAt: deps.now().toISOString() };

        // Reads: show the file's history on first touch (edits already got it before the edit).
        const firstTouch = touched.filter((f) => !state.touchedFiles.includes(f));
        if (firstTouch.length === 0) return { next: state, result: {} };
        const { threads } = await deps.store.list();
        const history = await historyFor(firstTouch, threads, state, deps);
        state = markSurfaced({ ...state, touchedFiles: [...state.touchedFiles, ...firstTouch] }, history.shown);
        return { next: state, result: { context: history.text || undefined, notice: summarize(history.shown, deps.now()) } };
      });
    }

    case 'turn-end':
      await deps.sessions.update(event.sessionId, async (cur) => {
        if (!cur) return { next: null, result: undefined };
        let state = await flush(cur, deps);
        const sinceSync = state.lastSyncAt ? deps.now().getTime() - Date.parse(state.lastSyncAt) : Infinity;
        // Publish a brand-new thread right away so teammates see the session; otherwise throttle.
        const justCreated = !cur.threadId && state.threadId !== null;
        const syncDue = justCreated || sinceSync >= BACKGROUND_SYNC_INTERVAL_MS;

        // Heartbeat (presence) and commit attribution, written when we're about to sync or there are new commits.
        if (state.threadId) {
          const thread = await deps.store.get(state.threadId);
          if (thread) {
            const commits = state.baseHead ? (await deps.myCommitsSince(state.baseHead)).filter((c) => !thread.commits.includes(c)) : [];
            // A thread created this turn already carries a fresh heartbeat.
            if ((syncDue && !justCreated) || commits.length) {
              const beat = heartbeat(thread, state.sessionId, { commits, now: deps.now() });
              if (beat !== thread) await deps.store.save(beat, `thread ${thread.id}: ${commits.length ? `${commits.length} commit(s)` : 'heartbeat'}`);
            }
          }
        }
        if (!state.baseHead) state = { ...state, baseHead: await deps.head() };
        if (syncDue) {
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
      session: { id: state.sessionId, agent: state.agent, startedAt: state.startedAt, lastActiveAt: now.toISOString() },
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

/**
 * Earlier threads on files touched for the first time: threads that listed the
 * file, or whose recorded commits changed it (git history → thread).
 */
async function historyFor(
  files: string[],
  threads: Thread[],
  state: SessionState,
  deps: HookDeps,
  skip: Set<string> = new Set(),
): Promise<{ text: string; shown: RankedThread[] }> {
  if (files.length === 0) return { text: '', shown: [] };
  const own = new Set(ownThreadIds(state));
  const shown: RankedThread[] = [];
  for (const file of files) {
    const commits = new Set(await deps.fileCommits(file));
    for (const thread of threads) {
      if (own.has(thread.id) || skip.has(thread.id) || shown.some((r) => r.thread.id === thread.id)) continue;
      if (state.surfaced[thread.id] === thread.updatedAt) continue;
      const commit = thread.commits.find((c) => commits.has(c));
      if (!thread.files.includes(file) && !commit) continue;
      const reasons = [commit ? `changed ${file} (commit ${commit.slice(0, 7)})` : `touched ${file}`];
      if (thread.status === 'closed') reasons.push('closed');
      shown.push({ thread, score: 0, reasons, matchedFiles: [file] });
    }
  }
  shown.sort((a, b) => b.thread.updatedAt.localeCompare(a.thread.updatedAt));
  const top = shown.slice(0, HISTORY_LIMIT);
  const heading = files.length === 1 ? `Earlier work on ${files[0]}:` : `Earlier work on ${files.join(', ')}:`;
  return { text: renderContext(heading, top, deps.now()), shown: top };
}

function overlapNotice(file: string, claims: ActiveClaim[], overlaps: Thread[], now: Date): string {
  const claim = claims[0];
  if (claim) return `sticky-note: ${claim.owner.name} has claimed ${file}${claim.reason ? ` (${claim.reason})` : ''}`;
  const lead = overlaps[0]!;
  const who = lead.contributors.at(-1)?.name ?? lead.author.name;
  return `sticky-note: ${who} ${isLive(lead, now) ? 'is working on' : 'has open work on'} ${file} ("${lead.title}")`;
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
