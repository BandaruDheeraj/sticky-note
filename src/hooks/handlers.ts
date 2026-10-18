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
 * What each event does:
 *  - session-start: remember the session (no thread yet)
 *  - prompt:        first prompt creates the session's thread, titled from the prompt
 *  - tool-used:     note edited files locally (cheap, no git)
 *  - turn-end:      flush noted files to the thread (one commit per turn)
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
        if (state.threadId) return { next: state, result: undefined };
        const thread = createThread({
          title: titleFromText(event.prompt),
          author: deps.identity,
          branch: await deps.currentBranch(),
          session: { id: event.sessionId, agent: event.agent, startedAt: state.startedAt },
          now: deps.now(),
        });
        await deps.store.save(thread, `thread ${thread.id}: started in ${event.agent}`);
        return { next: { ...state, threadId: thread.id, updatedAt: deps.now().toISOString() }, result: undefined };
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

/** Write pending files to the session's thread; returns the updated session state. */
async function flush(state: SessionState, deps: HookDeps): Promise<SessionState> {
  if (!state.threadId || state.pendingFiles.length === 0) return state;
  const thread = await deps.store.get(state.threadId);
  if (thread) {
    const updated = recordActivity(thread, { files: state.pendingFiles, person: deps.identity, now: deps.now() });
    if (updated !== thread) await deps.store.save(updated, `thread ${thread.id}: ${state.pendingFiles.length} file(s) touched`);
  }
  return { ...state, pendingFiles: [], updatedAt: deps.now().toISOString() };
}

function freshSession(event: HookEvent, deps: HookDeps): SessionState {
  const iso = deps.now().toISOString();
  return { sessionId: event.sessionId, agent: event.agent, startedAt: iso, updatedAt: iso, threadId: null, pendingFiles: [] };
}
