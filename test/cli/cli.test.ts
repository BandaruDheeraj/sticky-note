import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defineCommand } from '../../src/cli/command.js';
import { CommandRegistry } from '../../src/cli/registry.js';
import { runCli } from '../helpers/cli.js';
import { cleanupTmpDirs, makeRepo, tmpDir } from '../helpers/repo.js';

afterEach(cleanupTmpDirs);

const run = runCli;

describe('Cli framework', () => {
  const registry = () =>
    new CommandRegistry().register(
      defineCommand({
        name: 'echo',
        summary: 'Echo args',
        args: [{ name: 'words', description: 'Words', required: true, variadic: true }],
        options: { loud: { type: 'boolean', short: 'l', description: 'Uppercase' } },
        async run({ out }, { args, options }) {
          out.print(options.loud ? args.words!.toUpperCase() : args.words!);
        },
      }),
      defineCommand({
        name: 'env add-server',
        summary: 'Nested command',
        args: [{ name: 'name', description: 'Server', required: true }],
        async run({ out }, { args }) {
          out.print(`added ${args.name}`);
          return 3;
        },
      }),
    );

  it('dispatches with typed args and options', async () => {
    expect((await run(['echo', 'hi', 'there', '-l'], { registry: registry() })).out).toBe('HI THERE\n');
  });

  it('resolves multi-word subcommands and returns their exit code', async () => {
    const r = await run(['env', 'add-server', 'github'], { registry: registry() });
    expect(r).toMatchObject({ code: 3, out: 'added github\n' });
  });

  it('reports usage errors with exit code 2', async () => {
    expect(await run(['nope'], { registry: registry() })).toMatchObject({ code: 2 });
    expect((await run(['echo'], { registry: registry() })).err).toMatch(/Missing required argument <words>/);
    expect((await run(['echo', 'x', '--bogus'], { registry: registry() })).code).toBe(2);
  });

  it('renders global and per-command help', async () => {
    const global = await run([], { registry: registry() });
    expect(global.out).toMatch(/echo\s+Echo args/);
    expect(global.out).toMatch(/env add-server\s+Nested command/);
    const cmd = await run(['echo', '--help'], { registry: registry() });
    expect(cmd.out).toMatch(/Usage: sticky-note echo <words\.\.\.> \[options\]/);
    expect(cmd.out).toMatch(/-l, --loud/);
  });

  it('prints the version', async () => {
    expect((await run(['--version'])).out).toBe('0.0.0-test\n');
  });
});

describe('commands', () => {
  it('fails outside a git repo', async () => {
    const r = await run(['threads'], { cwd: await tmpDir() });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Not a git repository/);
  });

  it('init → new → threads → show → close → status', async () => {
    const { dir, git } = await makeRepo();
    const cwd = { cwd: dir };

    expect((await run(['init'], cwd)).code).toBe(0);
    const config = JSON.parse(await readFile(path.join(dir, '.sticky-note', 'config.json'), 'utf8'));
    expect(config).toEqual({ version: 1, dataBranch: 'sticky-note/context', remote: 'origin' });
    expect(await git.currentBranch()).toBe('main');

    const created = (await run(['new', 'Fix', 'login', 'loop', '-t', 'bugfix', '-f', 'src/a.ts', '-f', 'src/b.ts', '--json'], cwd)).json();
    expect(created.thread).toMatchObject({ title: 'Fix login loop', workType: 'bugfix', files: ['src/a.ts', 'src/b.ts'], branch: 'main' });
    const id: string = created.thread.id;

    const list = await run(['threads'], cwd);
    expect(list.out).toMatch(/Fix login loop/);

    expect((await run(['show', id.slice(0, 10)], cwd)).out).toMatch(/src\/b\.ts/);

    const closed = (await run(['close', id, '-s', 'Done', '--json'], cwd)).json();
    expect(closed.thread).toMatchObject({ status: 'closed', narrative: 'Done' });

    expect((await run(['threads', '--json'], cwd)).json().threads).toEqual([]);
    expect((await run(['ls', '-a', '--json'], cwd)).json().threads).toHaveLength(1);

    const status = (await run(['status', '--json'], cwd)).json();
    expect(status).toMatchObject({ configured: true, counts: { active: 0, stuck: 0, closed: 1 }, store: { remote: null } });
  });

  it('validates option values', async () => {
    const { dir } = await makeRepo();
    expect((await run(['new', 'x', '-t', 'nonsense'], { cwd: dir })).code).toBe(2);
    expect((await run(['threads', '--status', 'weird'], { cwd: dir })).code).toBe(2);
  });

  it('emits JSON errors in --json mode', async () => {
    const { dir } = await makeRepo();
    const r = await run(['show', 'missing', '--json'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.json()).toMatchObject({ ok: false, error: { message: 'No thread matches "missing"' } });
  });
});

describe('context command', () => {
  it('previews ranking and the injected text', async () => {
    const { dir } = await makeRepo();
    await run(['new', 'Billing export', '-f', 'src/billing/export.ts'], { cwd: dir });
    const r = await run(['context', '-f', 'src/billing/export.ts', '--json'], { cwd: dir });
    const json = r.json();
    expect(json.mode).toBe('prompt');
    expect(json.ranked[0]).toMatchObject({ title: 'Billing export' });
    expect(json.ranked[0].reasons[0]).toMatch(/touches src\/billing\/export.ts/);
    expect(json.injected).toContain('[sticky-note] Related work by your team:');
  });
});

describe('claim, unclaim, claims, who', () => {
  it('manages claims and shows them in who', async () => {
    const { dir } = await makeRepo();
    expect((await run(['claim', 'src/a.ts', 'src/b.ts', '-m', 'refactor', '--hours', '2'], { cwd: dir })).code).toBe(0);
    let claims = (await run(['claims', '--json'], { cwd: dir })).json().claims;
    expect(claims.map((c: any) => [c.file, c.reason, c.owner.name])).toEqual([['src/a.ts', 'refactor', 'Test User'], ['src/b.ts', 'refactor', 'Test User']]);

    // Paths are resolved relative to the current directory.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await run(['unclaim', 'a.ts'], { cwd: path.join(dir, 'src') });
    claims = (await run(['claims', '--json'], { cwd: dir })).json().claims;
    expect(claims.map((c: any) => c.file)).toEqual(['src/b.ts']);

    const who = (await run(['who', '--json'], { cwd: dir })).json();
    expect(who.claims.map((c: any) => c.file)).toEqual(['src/b.ts']);
    expect(who.working).toEqual([]);

    await run(['unclaim', '--all'], { cwd: dir });
    expect((await run(['claims', '--json'], { cwd: dir })).json().claims).toEqual([]);
    expect((await run(['claim', '../outside.ts'], { cwd: dir })).code).toBe(2);
    expect((await run(['unclaim'], { cwd: dir })).code).toBe(2);
  });

  it('who lists live sessions', async () => {
    const { dir } = await makeRepo();
    await run(['init', '--skip-hooks'], { cwd: dir });
    const hook = (payload: object) => run(['run-hook', 'claude-code'], { cwd: dir, stdin: JSON.stringify({ session_id: 'w1', cwd: dir, ...payload }) });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Live work' });
    await hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/live.ts' } });
    await hook({ hook_event_name: 'Stop' });

    const who = (await run(['who', '--json'], { cwd: dir })).json();
    expect(who.working).toMatchObject([{ person: { name: 'Test User' }, live: true, thread: { title: 'Live work', files: ['src/live.ts'] } }]);
    expect((await run(['who'], { cwd: dir })).out).toMatch(/Test User\s+active/);

    await hook({ hook_event_name: 'SessionEnd', reason: 'other' });
    expect((await run(['who', '--json'], { cwd: dir })).json().working).toEqual([]);
  });
});

describe('audit', () => {
  it('records thread and claim actions, filterable by author and thread', async () => {
    const { dir } = await makeRepo();
    const created = (await run(['new', 'Investigate flaky test', '--json'], { cwd: dir })).json();
    await run(['claim', 'src/flaky.ts', '-m', 'debugging'], { cwd: dir });
    await run(['close', created.thread.id, '-s', 'fixed'], { cwd: dir });
    await run(['unclaim', '--all'], { cwd: dir });

    const all = (await run(['audit', '--json'], { cwd: dir })).json();
    expect(all.entries.map((e: any) => e.action)).toEqual(['claim.released', 'thread.closed', 'claim.created', 'thread.created']); // newest first
    for (const e of all.entries) expect(e.actor.name).toBe('Test User');

    const byThread = (await run(['audit', '--thread', created.thread.id, '--json'], { cwd: dir })).json();
    expect(byThread.entries.map((e: any) => e.action)).toEqual(['thread.closed', 'thread.created']);

    const byAuthor = (await run(['audit', '--author', 'Test User', '--json'], { cwd: dir })).json();
    expect(byAuthor.total).toBe(all.total);
    expect((await run(['audit', '--author', 'nobody', '--json'], { cwd: dir })).json().entries).toEqual([]);

    expect((await run(['audit'], { cwd: dir })).out).toMatch(/thread\.created/);
    expect((await run(['audit', '--limit', '0'], { cwd: dir })).code).toBe(2);
  });

  it('has nothing to report in a fresh repo', async () => {
    const { dir } = await makeRepo();
    await run(['init', '--skip-hooks'], { cwd: dir });
    expect((await run(['audit'], { cwd: dir })).out).toMatch(/No audit entries yet/);
  });
});
