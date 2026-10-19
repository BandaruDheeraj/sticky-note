import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Git } from '../../src/core/git.js';
import { makeBareRemote, makeRepo } from '../helpers/repo.js';

/** The real bundled CLI, run as a separate process exactly like hooks and people run it. */
export const BIN = path.resolve(import.meta.dirname, '../../dist/cli.js');
export const BRANCH = 'sticky-note/context';

export function assertBuilt(): void {
  if (!existsSync(BIN)) throw new Error(`Build first: ${BIN} is missing (npm run build)`);
}

export interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

export function sn(cwd: string, args: string[], stdin = ''): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.STICKY_NO_BACKGROUND_SYNC; // e2e exercises real background syncs
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(stdin);
  });
}

export async function snJson<T = any>(cwd: string, args: string[]): Promise<T> {
  const r = await sn(cwd, [...args, '--json']);
  if (r.code !== 0) throw new Error(`sticky-note ${args.join(' ')} exited ${r.code}: ${r.err}`);
  return JSON.parse(r.out);
}

export interface Teammate {
  name: string;
  dir: string;
  git: Git;
  /** Fire a Claude Code hook as Claude Code would: payload on stdin, JSON (or nothing) on stdout. */
  hook(sessionId: string, payload: Record<string, unknown>): Promise<{ systemMessage?: string; hookSpecificOutput?: { hookEventName: string; additionalContext?: string } } | null>;
}

export async function makeTeam(...names: string[]) {
  const remote = await makeBareRemote();
  const team: Teammate[] = [];
  for (const name of names) {
    const { dir, git } = await makeRepo({ remote, user: name });
    team.push({
      name,
      dir,
      git,
      async hook(sessionId, payload) {
        const r = await sn(dir, ['run-hook', 'claude-code'], JSON.stringify({ session_id: sessionId, cwd: dir, ...payload }));
        if (r.code !== 0) throw new Error(`hook exited ${r.code}: ${r.err}`);
        return r.out.trim() ? JSON.parse(r.out) : null;
      },
    });
  }
  return { remote, team };
}

/** Wait until the shared remote has a thread file (e.g. pushed by a background sync). */
export async function waitForRemoteThread(remote: string, id: string, timeoutMs = 20_000): Promise<void> {
  const git = new Git(remote);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await git.tryRun(['cat-file', '-e', `${BRANCH}:threads/${id}.json`])) !== null) return;
    await sleep(250);
  }
  throw new Error(`Thread ${id} never reached the remote within ${timeoutMs}ms`);
}

export function step(message: string): void {
  console.log(`  → ${message}`);
}
