import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flattenAudit } from '../../src/core/audit.js';
import { localStateDir } from '../../src/core/paths.js';
import { GitBranchStore } from '../../src/core/store/git-branch-store.js';
import { claudeCodeAdapter } from '../../src/hooks/adapters/claude-code.js';
import { editedFiles } from '../../src/hooks/edited-files.js';
import { installClaudeCodeHooks } from '../../src/hooks/install/claude-code.js';
import { closeThread, createThread } from '../../src/core/thread.js';
import { runCli } from '../helpers/cli.js';
import { cleanupTmpDirs, makeBareRemote, makeRepo } from '../helpers/repo.js';

afterEach(cleanupTmpDirs);

const BRANCH = 'sticky-note/context';

describe('claudeCodeAdapter', () => {
  const base = { session_id: 's1', cwd: '/repo', transcript_path: '/t.jsonl' };

  it('maps Claude Code payloads to neutral events', () => {
    expect(claudeCodeAdapter.parse({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).toEqual({
      agent: 'claude-code', sessionId: 's1', cwd: '/repo', kind: 'prompt', prompt: 'hi',
    });
    expect(claudeCodeAdapter.parse({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' } }))
      .toMatchObject({ kind: 'tool-used', toolName: 'Edit', toolInput: { file_path: 'a' } });
    expect(claudeCodeAdapter.parse({ ...base, hook_event_name: 'Notification' })).toBeNull();
  });

  it('renders additionalContext only for events that support it', () => {
    const start = claudeCodeAdapter.parse({ ...base, hook_event_name: 'SessionStart', source: 'startup' })!;
    expect(JSON.parse(claudeCodeAdapter.render(start, { context: 'hello' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello' },
    });
    expect(JSON.parse(claudeCodeAdapter.render(start, { notice: 'seen by the person' }))).toEqual({ systemMessage: 'seen by the person' });
    const stop = claudeCodeAdapter.parse({ ...base, hook_event_name: 'Stop' })!;
    expect(claudeCodeAdapter.render(stop, { context: 'ignored' })).toBe('');
  });
});

describe('editedFiles', () => {
  it('returns repo-relative paths for edit tools only', () => {
    expect(editedFiles('Edit', { file_path: '/repo/src/a.ts' }, '/repo', '/repo')).toEqual(['src/a.ts']);
    expect(editedFiles('Write', { file_path: 'b.ts' }, '/repo/src', '/repo')).toEqual(['src/b.ts']);
    expect(editedFiles('NotebookEdit', { notebook_path: '/repo/n.ipynb' }, '/repo', '/repo')).toEqual(['n.ipynb']);
    expect(editedFiles('Read', { file_path: '/repo/a.ts' }, '/repo', '/repo')).toEqual([]);
    expect(editedFiles('Edit', { file_path: '/elsewhere/a.ts' }, '/repo', '/repo')).toEqual([]);
  });
});

describe('installClaudeCodeHooks', () => {
  it('preserves unrelated settings and replaces old sticky-note hooks', async () => {
    const { dir } = await makeRepo();
    await mkdir(path.join(dir, '.claude'));
    await writeFile(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
          SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'npx --no sticky-note-cli run-hook session-start' }] }],
        },
      }),
    );

    expect((await installClaudeCodeHooks(dir, 'sn')).changed).toBe(true);
    const settings = JSON.parse(await readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));

    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: 'say done' }] },
      { hooks: [{ type: 'command', command: 'sn run-hook claude-code', timeout: 30 }] },
    ]);
    expect(settings.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'sn run-hook claude-code', timeout: 30 }] }]);
    expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|MultiEdit|Write|NotebookEdit|Read');
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Edit|MultiEdit|Write|NotebookEdit');

    expect((await installClaudeCodeHooks(dir, 'sn')).changed).toBe(false);
    await installClaudeCodeHooks(dir, 'node dist/cli.js'); // switching command replaces, doesn't duplicate
    const switched = JSON.parse(await readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(switched.hooks.SessionStart).toEqual([{ hooks: [{ type: 'command', command: 'node dist/cli.js run-hook claude-code', timeout: 30 }] }]);
  });
});

describe('run-hook claude-code', () => {
  async function setup(opts: { remote?: string } = {}) {
    const repo = await makeRepo(opts.remote ? { remote: opts.remote } : {});
    expect((await runCli(['init', '--skip-hooks'], { cwd: repo.dir })).code).toBe(0);
    const hook = (payload: Record<string, unknown>) =>
      runCli(['run-hook', 'claude-code'], {
        cwd: repo.dir,
        stdin: JSON.stringify({ session_id: 'sess-1', cwd: repo.dir, transcript_path: '/dev/null', ...payload }),
      });
    const store = new GitBranchStore({ repoDir: repo.dir, dataBranch: BRANCH, remote: 'origin' });
    const commits = async () => Number(await repo.git.run(['rev-list', '--count', BRANCH]));
    return { ...repo, hook, store, commits };
  }

  it('captures a session as a thread', async () => {
    const { dir, git, hook, store, commits } = await setup();
    const statusBefore = await git.run(['status', '--porcelain']);

    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    expect((await store.list()).threads).toHaveLength(0); // no thread until there's a prompt

    const initial = await commits();

    // Prompts and tool calls only touch the local session file: no git work on the hot path.
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the flaky login test\nmore detail here' });
    await Promise.all([
      hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/login.ts') } }),
      hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'test/login.test.ts' } }),
      hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/login.ts' } }),
    ]);
    expect(await commits()).toBe(initial);
    expect((await store.list()).threads).toHaveLength(0);

    // End of turn: thread+files land in one commit, plus one for the audit entry.
    await hook({ hook_event_name: 'Stop' });
    let [thread] = (await store.list()).threads;
    expect(thread).toMatchObject({
      title: 'Fix the flaky login test',
      status: 'active',
      branch: 'main',
      author: { name: 'Test User' },
      sessions: [{ id: 'sess-1', agent: 'claude-code', endedAt: null }],
    });
    expect(thread!.files.sort()).toEqual(['src/login.ts', 'test/login.test.ts']);
    expect(thread!.narrative).toBe('Asked: Fix the flaky login test\nmore detail here'); // full prompt kept
    expect(await commits()).toBe(initial + 2);
    const auditEntries = flattenAudit(await store.listAudit());
    expect(auditEntries).toMatchObject([{ action: 'thread.created', threadId: thread!.id, detail: 'Fix the flaky login test' }]);

    // Later turns update the same thread (no new audit entry, so only one more commit).
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second prompt' });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/session.ts' } });
    await hook({ hook_event_name: 'Stop' });
    [thread] = (await store.list()).threads;
    expect(thread!.title).toBe('Fix the flaky login test');
    expect(thread!.files).toContain('src/session.ts');
    expect(await commits()).toBe(initial + 3);

    await hook({ hook_event_name: 'Stop' }); // nothing pending: no commit
    expect(await commits()).toBe(initial + 3);

    await hook({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    [thread] = (await store.list()).threads;
    expect(thread!.sessions[0]!.endedAt).not.toBeNull();
    expect(existsSync(path.join(await localStateDir(git), 'sessions', 'sess-1.json'))).toBe(false);

    expect(await git.run(['status', '--porcelain'])).toBe(statusBefore); // user's tree untouched by hooks
  });

  it('commits a first-turn thread at session end if the turn never finished', async () => {
    const { hook, store } = await setup();
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'interrupted' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'other' });
    const [thread] = (await store.list()).threads;
    expect(thread).toMatchObject({ title: 'interrupted', narrative: '' }); // short prompt: title is enough
    expect(thread!.sessions[0]!.endedAt).not.toBeNull();
  });

  it('leaves no thread for a session without prompts', async () => {
    const { hook, store } = await setup();
    await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect((await store.list()).threads).toHaveLength(0);
  });

  it('pushes to the remote when the session ends', async () => {
    const remote = await makeBareRemote();
    const { hook } = await setup({ remote });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'shared work' });
    await hook({ hook_event_name: 'SessionEnd', reason: 'other' });

    const teammate = await makeRepo({ remote, user: 'Teammate' });
    await teammate.git.run(['fetch', '--quiet', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
    const theirs = new GitBranchStore({ repoDir: teammate.dir, dataBranch: BRANCH, remote: 'origin' });
    expect((await theirs.list()).threads.map((t) => t.title)).toEqual(['shared work']);
  });

  it('is a silent no-op in a repo without sticky-note', async () => {
    const { dir, git } = await makeRepo();
    const r = await runCli(['run-hook', 'claude-code'], {
      cwd: dir,
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: dir, prompt: 'x' }),
    });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(await git.refExists(`refs/heads/${BRANCH}`)).toBe(false);
  });

  it('never fails the agent, and logs errors', async () => {
    const { dir, git } = await setup();
    const r = await runCli(['run-hook', 'claude-code'], { cwd: dir, stdin: JSON.stringify({ hook_event_name: 'Stop', cwd: dir }) });
    expect(r).toMatchObject({ code: 0, out: '' });

    const ok = await runCli(['run-hook', 'claude-code'], { cwd: dir, stdin: 'not json' });
    expect(ok.code).toBe(0);

    await runCli(['run-hook', 'claude-code'], {
      cwd: dir,
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'x', cwd: dir, prompt: 'hi' }),
    });
    const log = await readFile(path.join(await localStateDir(git), 'logs', 'hooks.log'), 'utf8');
    expect(log).toMatch(/claude-code prompt session=x ok/);
  });
});

describe('surfacing through hooks', () => {
  const alice = { name: 'Alice', email: 'alice@example.com' };

  async function setup() {
    const repo = await makeRepo();
    await runCli(['init', '--skip-hooks'], { cwd: repo.dir });
    const store = new GitBranchStore({ repoDir: repo.dir, dataBranch: BRANCH, remote: 'origin' });
    const hook = async (payload: Record<string, unknown>) => {
      const r = await runCli(['run-hook', 'claude-code'], {
        cwd: repo.dir,
        stdin: JSON.stringify({ session_id: 'me-1', cwd: repo.dir, ...payload }),
      });
      return r.out.trim() ? JSON.parse(r.out) : null;
    };
    return { ...repo, store, hook };
  }

  it("shows teammates' stuck and live work at session start, to the agent and the person", async () => {
    const { store, hook } = await setup();
    const stuck = { ...createThread({ title: 'Payments webhook retries', author: alice, branch: 'main' }), status: 'stuck' as const };
    await store.save(stuck);

    const out = await hook({ hook_event_name: 'SessionStart', source: 'startup' });
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('STUCK · "Payments webhook retries" · Alice');
    expect(out.systemMessage).toMatch(/sticky-note: 1 related thread \(1 stuck\)/);
  });

  it('injects threads related to the prompt, once per thread version', async () => {
    const { store, hook } = await setup();
    const related = createThread({ title: 'Rate limiter rewrite', author: alice, branch: 'main', files: ['src/api/rate-limit.ts'] });
    await store.save(related);
    await store.save(createThread({ title: 'Unrelated docs', author: alice, branch: 'other', files: ['README.md'] }));

    const first = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'make src/api/rate-limit.ts configurable' });
    expect(first.hookSpecificOutput.additionalContext).toContain('Rate limiter rewrite');
    expect(first.hookSpecificOutput.additionalContext).not.toContain('Unrelated docs');

    expect(await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'and rate-limit.ts tests too' })).toBeNull();

    await store.save({ ...related, narrative: 'new findings', updatedAt: new Date(Date.now() + 1000).toISOString() });
    const again = await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'rate-limit.ts again' });
    expect(again.hookSpecificOutput.additionalContext).toContain('new findings');
  });

  it("warns once before editing a file in a teammate's live thread", async () => {
    const { dir, store, hook } = await setup();
    const t = createThread({ title: 'Refactor auth', author: alice, branch: 'main', files: ['src/auth.ts'], session: { id: 'a-1', agent: 'claude-code', startedAt: new Date().toISOString() } });
    await store.save(t);

    const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/auth.ts') } };
    const out = await hook(edit);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(out.hookSpecificOutput.additionalContext).toContain('Alice (working on it right now): "Refactor auth"');
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined(); // advisory, never blocks
    expect(out.systemMessage).toBe('sticky-note: Alice is working on src/auth.ts ("Refactor auth")');

    expect(await hook(edit)).toBeNull();
    expect(await hook({ ...edit, tool_input: { file_path: path.join(dir, 'src/other.ts') } })).toBeNull();
  });

  it('never surfaces the session\'s own thread', async () => {
    const { store, hook } = await setup();
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work on src/feature-flags.ts' });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/feature-flags.ts' } });
    await hook({ hook_event_name: 'Stop' });
    expect((await store.list()).threads).toHaveLength(1);
    expect(await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'more on src/feature-flags.ts' })).toBeNull();
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/feature-flags.ts' } })).toBeNull();
  });
});

describe('4b: claims, history on first touch, commit attribution', () => {
  const alice = { name: 'Alice', email: 'alice@example.com' };

  async function setup() {
    const repo = await makeRepo();
    await runCli(['init', '--skip-hooks'], { cwd: repo.dir });
    const store = new GitBranchStore({ repoDir: repo.dir, dataBranch: BRANCH, remote: 'origin' });
    const hook = async (session: string, payload: Record<string, unknown>) => {
      const r = await runCli(['run-hook', 'claude-code'], { cwd: repo.dir, stdin: JSON.stringify({ session_id: session, cwd: repo.dir, ...payload }) });
      return r.out.trim() ? JSON.parse(r.out) : null;
    };
    return { ...repo, store, hook };
  }

  it("warns before editing a teammate's claimed file", async () => {
    const { dir, store, hook } = await setup();
    const { addClaims, ClaimSet } = await import('../../src/core/claim.js');
    await store.saveClaims(addClaims(ClaimSet.parse({ schemaVersion: 1, owner: alice }), ['db/schema.sql'], { reason: 'running the migration' }));

    const out = await hook('me', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(dir, 'db/schema.sql') } });
    expect(out.hookSpecificOutput.additionalContext).toContain('db/schema.sql is claimed by a teammate');
    expect(out.hookSpecificOutput.additionalContext).toContain('Alice: running the migration');
    expect(out.systemMessage).toBe('sticky-note: Alice has claimed db/schema.sql (running the migration)');
  });

  it("my own claims don't warn me", async () => {
    const { dir, hook } = await setup();
    expect((await runCli(['claim', 'src/mine.ts', '-m', 'mine'], { cwd: dir })).code).toBe(0);
    expect(await hook('me', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/mine.ts' } })).toBeNull();
  });

  it('shows earlier work, including failed approaches, the first time a file is read', async () => {
    const { store, hook } = await setup();
    const { closeThread } = await import('../../src/core/thread.js');
    const old = closeThread({
      ...createThread({ title: 'Speed up search index', author: alice, branch: 'main', files: ['src/search/index-builder.ts'] }),
      failedApproaches: [{ description: 'parallel workers', reason: 'lock contention', at: new Date().toISOString() }],
    });
    await store.save(old);

    const read = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'src/search/index-builder.ts' } };
    const out = await hook('me', read);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('Earlier work on src/search/index-builder.ts:');
    expect(out.hookSpecificOutput.additionalContext).toContain("Tried, didn't work: parallel workers (lock contention)");
    expect(await hook('me', read)).toBeNull(); // only on first touch
  });

  it('links commits made in a session to its thread, then surfaces that thread from git history', async () => {
    const { dir, git, store, hook } = await setup();
    await hook('s1', { hook_event_name: 'SessionStart', source: 'startup' });
    await hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'Tune retry backoff' });
    // The person (or agent via Bash) commits a file that sticky-note never saw edited.
    await writeFile(path.join(dir, 'retry.ts'), 'export const backoff = 2;\n');
    await git.run(['add', 'retry.ts']);
    await git.run(['commit', '-q', '-m', 'tune backoff']);
    const sha = await git.run(['rev-parse', 'HEAD']);
    await hook('s1', { hook_event_name: 'Stop' });
    await hook('s1', { hook_event_name: 'SessionEnd', reason: 'other' });

    const [thread] = (await store.list()).threads;
    expect(thread!.commits).toEqual([sha]);
    expect(thread!.files).toEqual([]); // known only through the commit

    const out = await hook('s2', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: 'retry.ts' } });
    expect(out.hookSpecificOutput.additionalContext).toContain('"Tune retry backoff"');
    expect(out.hookSpecificOutput.additionalContext).toContain(`changed retry.ts (commit ${sha.slice(0, 7)})`);
  });

  it("doesn't attribute commits made before the session started", async () => {
    const { git, store, hook } = await setup();
    await git.run(['commit', '-q', '--allow-empty', '-m', 'before session']);
    await hook('s1', { hook_event_name: 'SessionStart', source: 'startup' });
    await hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'x' });
    await hook('s1', { hook_event_name: 'Stop' });
    expect((await store.list()).threads[0]!.commits).toEqual([]);
  });
});

describe('resume', () => {
  const alice = { name: 'Alice', email: 'alice@example.com' };

  async function setup() {
    const repo = await makeRepo();
    await runCli(['init', '--skip-hooks'], { cwd: repo.dir });
    const store = new GitBranchStore({ repoDir: repo.dir, dataBranch: BRANCH, remote: 'origin' });
    const hook = async (session: string, payload: Record<string, unknown>) => {
      const r = await runCli(['run-hook', 'claude-code'], { cwd: repo.dir, stdin: JSON.stringify({ session_id: session, cwd: repo.dir, ...payload }) });
      return r.out.trim() ? JSON.parse(r.out) : null;
    };
    const cli = (args: string[]) => runCli(args, { cwd: repo.dir });
    return { ...repo, store, hook, cli };
  }

  it('sticky-note resume arms a thread, and the next session attaches to it', async () => {
    const { store, hook, cli } = await setup();
    const original = createThread({
      title: 'Add rate limiting',
      author: alice,
      branch: 'main',
      files: ['src/api/rate-limit.ts'],
      narrative: 'Got partway through, ran out of time.',
    });
    await store.save(original);

    const resumeResult = await cli(['resume', original.id, '--json']);
    expect(resumeResult.code).toBe(0);
    expect(JSON.parse(resumeResult.out).armed).toBe(original.id);

    const out = await hook('new-session', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain(`Resumed thread "Add rate limiting" (id ${original.id})`);
    expect(out.hookSpecificOutput.additionalContext).toContain('Got partway through, ran out of time.');
    expect(out.systemMessage).toBe(`sticky-note: Resumed "Add rate limiting" (${original.id}) — continuing from here.`);

    const [thread] = (await store.list()).threads;
    expect(thread!.sessions).toMatchObject([{ id: 'new-session', agent: 'claude-code', endedAt: null }]);

    const audit = flattenAudit(await store.listAudit());
    expect(audit).toContainEqual(expect.objectContaining({ action: 'thread.resumed', threadId: original.id }));
  });

  it('resuming mid-session moves the running session over, ending its own thread cleanly', async () => {
    const { store, hook, cli } = await setup();
    const target = createThread({ title: 'Target thread', author: alice, branch: 'main' });
    await store.save(target);

    // The session already started its own thread before resume was requested.
    await hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'something else entirely' });
    await hook('s1', { hook_event_name: 'Stop' });
    const ownThreadId = (await store.list()).threads.find((t) => t.title === 'something else entirely')!.id;

    await cli(['resume', target.id]);
    const out = await hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'continuing target thread' });
    expect(out.hookSpecificOutput.additionalContext).toContain(`Resumed thread "Target thread" (id ${target.id})`);

    const own = await store.get(ownThreadId);
    expect(own!.sessions[0]).toMatchObject({ id: 's1', endedAt: expect.any(String) }); // ended, not lost
    const resumed = await store.get(target.id);
    expect(resumed!.sessions).toMatchObject([{ id: 's1', endedAt: null }]);

    // Subsequent edits land on the resumed thread, not a new one.
    await hook('s1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/target.ts' } });
    await hook('s1', { hook_event_name: 'Stop' });
    expect((await store.get(target.id))!.files).toEqual(['src/target.ts']);
  });

  it('reopens a closed thread on resume', async () => {
    const { store, hook, cli } = await setup();
    const closed = closeThread(createThread({ title: 'Old work', author: alice, branch: 'main' }), { summary: 'done' });
    await store.save(closed);

    await cli(['resume', closed.id]);
    await hook('s1', { hook_event_name: 'SessionStart', source: 'startup' });

    expect((await store.get(closed.id))!.status).toBe('active');
  });

  it('resume by search words when no id matches', async () => {
    const { store, cli } = await setup();
    await store.save(createThread({ title: 'Rate limiter rewrite', author: alice, branch: 'main', files: ['src/api/rate-limit.ts'] }));
    await store.save(createThread({ title: 'Unrelated docs cleanup', author: alice, branch: 'main' }));

    const result = await cli(['resume', 'rate', 'limiter', '--json']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).thread.title).toBe('Rate limiter rewrite');
  });

  it('refuses to guess between equally good matches', async () => {
    const { store, cli } = await setup();
    await store.save(createThread({ title: 'exact match', author: alice, branch: 'main' }));
    await store.save(createThread({ title: 'exact match', author: alice, branch: 'main' }));

    const result = await cli(['resume', 'exact', 'match', '--json']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).ambiguous).toBe(true);
  });

  it('fails clearly when nothing matches', async () => {
    const { cli } = await setup();
    const result = await cli(['resume', 'nothing', 'like', 'this', 'exists']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/No thread matches/);
  });

  it('a resume intent for a deleted thread is silently ignored', async () => {
    const { store, hook, cli } = await setup();
    const t = createThread({ title: 'Will be gone', author: alice, branch: 'main' });
    await store.save(t);
    await cli(['resume', t.id]);
    const { rm } = await import('node:fs/promises');
    const path = (await import('node:path')).default;
    await rm(path.join(await store.worktreePath(), 'threads', `${t.id}.json`)); // simulate the thread having disappeared

    // Falls back to normal first-prompt behavior instead of erroring.
    const out = await hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'fresh start' });
    expect(out?.hookSpecificOutput?.additionalContext ?? '').not.toContain('Resumed');
    await hook('s1', { hook_event_name: 'Stop' });
    expect((await store.list()).threads.map((x) => x.title)).toEqual(['fresh start']);
  });
});
