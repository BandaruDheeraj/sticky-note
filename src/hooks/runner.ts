import { Services } from '../cli/context.js';
import { syncInBackground } from '../core/background-sync.js';
import type { AgentAdapter, HookEvent } from './events.js';
import { handleHookEvent } from './handlers.js';

/**
 * Entry point for every hook invocation. Never throws and never fails the
 * agent: errors are written to .git/sticky-note/logs/hooks.log instead.
 * Returns what to print on stdout.
 */
export async function runHook(adapter: AgentAdapter, rawInput: string): Promise<string> {
  // A credential prompt would hang the agent; fail fast instead.
  process.env.GIT_TERMINAL_PROMPT = '0';

  let event: HookEvent | null = null;
  let services: Services | undefined;
  const started = Date.now();
  try {
    event = adapter.parse(JSON.parse(rawInput));
    if (!event) return '';

    services = new Services(event.cwd);
    if (!(await services.git().isRepo())) return '';
    if (!(await services.config()).exists) return ''; // repo hasn't opted in via `init`

    const log = await services.log();
    // A "start" with no matching "ok"/"FAILED" means the agent killed the hook (e.g. timeout).
    await log.write(`${adapter.name} ${event.kind} session=${event.sessionId} start`);
    const [store, sessions, identity, repoRoot] = await Promise.all([
      services.store(),
      services.sessions(),
      services.identity(),
      services.repoRoot(),
    ]);
    const result = await handleHookEvent(event, {
      store,
      sessions,
      identity,
      repoRoot,
      currentBranch: () => services!.git().currentBranch(),
      syncInBackground: () => syncInBackground(repoRoot, log.file),
      head: async () => (await services!.git().tryRun(['rev-parse', '--verify', '--quiet', 'HEAD'])) || null,
      myCommitsSince: async (base) => {
        const author = identity.email ?? identity.name;
        const out = await services!.git().tryRun(['log', '--format=%H', `--author=${author}`, '-n', '50', `${base}..HEAD`]);
        return out ? out.split('\n') : [];
      },
      fileCommits: async (file) => {
        const out = await services!.git().tryRun(['log', '--format=%H', '-n', '50', '--', file]);
        return out ? out.split('\n') : [];
      },
      now: () => new Date(),
      log: (m) => log.write(`${adapter.name} ${event!.kind}: ${m}`),
    });
    await log.write(`${adapter.name} ${event.kind} session=${event.sessionId} ok ${Date.now() - started}ms`);
    return adapter.render(event, result);
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const where = event ? `${event.kind} session=${event.sessionId}` : 'parse';
    const log = await services?.log().catch(() => undefined);
    if (log) await log.write(`${adapter.name} ${where} FAILED ${Date.now() - started}ms: ${message}`);
    if (process.env.STICKY_DEBUG || !log) process.stderr.write(`sticky-note hook error (${where}): ${message}\n`);
    return '';
  }
}
