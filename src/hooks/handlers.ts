import type { SessionState, SessionStore } from '../core/session.js';
import type { ThreadStore } from '../core/store/thread-store.js';
import { createThread, endSession, recordActivity, titleFromText, type Person } from '../core/thread.js';
import { editedFiles } from './edited-files.js';
import type { HookEvent, HookResult } from './events.js';

export interface HookDeps {
  store: ThreadStore;
  sessions: SessionStore;
  identity: Person;
  repoRoot: string;
  currentBranch(): Promise<string | null>;
  now(): Date;
  log(message: string): Promise<void>;
}

/**
 * What each event does. Only turn-end and session-end touch git; the others
 * just update the local session file, so they stay fast even on a slow disk.
 *  - session-start: remember the session
 *  - prompt:        first prompt plans the session's thread, titled from the prompt
 *  - tool-used:     note edited files
 *  - turn-end:      commit the planned thread and noted files (one commit per turn)
 *  - session-end:   flush, mark the session ended, forget it, and sync
 */
export async function handleHookEvent(event: HookEvent, deps: HookDeps): Promise<HookResult> {
  switch (event.kind) {
    case 'session-start':
      await deps.sessions.update(event.sessionId, async (cur) => ({ next: cur ?? freshSession(event, deps), result: undefined }));
      return {};

    case 'prompt':
      await deps.sessions.update(event.sessionId, async (cur) => {
        const state = cur ?? freshSession(event, deps);
        if (state.threadId || state.pendingThread) return { next: state, result: undefined };
        const pendingThread = {
          title: titleFromText(event.prompt),
          branch: await deps.currentBranch(),
          createdAt: deps.now().toISOString(),
        };
        return { next: { ...state, pendingThread, updatedAt: deps.now().toISOString() }, result: undefined };
      });
      return {};

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
      await deps.sessions.update(event.sessionId, async (cur) => ({ next: cur && (await flush(cur, deps)), result: undefined }));
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
      await deps.log(result.skipped ? `sync skipped: ${result.skipped}` : `synced: pulled ${result.pulled}, pushed ${result.pushed}`);
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

function freshSession(event: HookEvent, deps: HookDeps): SessionState {
  const iso = deps.now().toISOString();
  return {
    sessionId: event.sessionId,
    agent: event.agent,
    startedAt: iso,
    updatedAt: iso,
    threadId: null,
    pendingThread: null,
    pendingFiles: [],
  };
}
