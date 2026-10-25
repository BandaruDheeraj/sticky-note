import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTmpDirs } from '../helpers/repo.js';
import { assertBuilt, BIN, BRANCH, makeTeam, sn, snJson, step, waitForRemoteThread } from './helpers.js';

beforeAll(assertBuilt);
afterAll(cleanupTmpDirs);

describe('e2e 1: threads via the CLI, across two teammates', () => {
  it('create → see → share → close → see the close', async () => {
    const { team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];

    step('both teammates run init');
    for (const p of team) expect((await sn(p.dir, ['init', '--skip-hooks', '--skip-mcp'])).code).toBe(0);
    for (const p of team) expect(await p.git.run(['status', '--porcelain'])).toBe('?? .sticky-note/');

    step('Alice creates a thread and sees it');
    const created = await snJson(alice.dir, ['new', 'Add CSV export', '-t', 'feature', '-f', 'src/export.ts', '-m', 'Started with the users table']);
    const id: string = created.thread.id;
    expect((await sn(alice.dir, ['threads'])).out).toMatch(/Add CSV export/);
    const shown = (await sn(alice.dir, ['show', id.slice(0, 8)])).out;
    expect(shown).toContain('src/export.ts');
    expect(shown).toContain('Started with the users table');

    step("Bob doesn't see it until Alice syncs");
    await sn(bob.dir, ['sync']);
    expect((await snJson(bob.dir, ['threads'])).threads).toEqual([]);

    step('Alice syncs; Bob syncs and sees it');
    expect((await sn(alice.dir, ['sync'])).out).toMatch(/pushed \d+/);
    expect((await sn(bob.dir, ['sync'])).out).toMatch(/pulled \d+/);
    const bobView = await snJson(bob.dir, ['show', id]);
    expect(bobView.thread).toMatchObject({ title: 'Add CSV export', author: { name: 'Alice' }, status: 'active', files: ['src/export.ts'] });

    step("Bob closes Alice's thread; Alice sees it closed after syncing");
    await sn(bob.dir, ['close', id, '-s', 'Shipped in #42']);
    await sn(bob.dir, ['sync']);
    await sn(alice.dir, ['sync']);
    expect((await snJson(alice.dir, ['threads'])).threads).toEqual([]); // closed are hidden by default
    const closed = (await snJson(alice.dir, ['show', id])).thread;
    expect(closed.status).toBe('closed');
    expect(closed.narrative).toBe('Started with the users table\n\nShipped in #42');

    step('status reflects everything and both sides agree');
    const status = await snJson(alice.dir, ['status']);
    expect(status).toMatchObject({ counts: { active: 0, stuck: 0, closed: 1 }, store: { ahead: 0, behind: 0 } });
    expect(await snJson(bob.dir, ['show', id])).toEqual(await snJson(alice.dir, ['show', id]));

    step("neither teammate's working tree or current branch was touched");
    for (const p of team) {
      expect(await p.git.currentBranch()).toBe('main');
      expect(await p.git.run(['status', '--porcelain'])).toBe('?? .sticky-note/');
    }
  });

  it('concurrent edits to the same thread merge instead of conflicting', async () => {
    const { team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--skip-hooks']);

    const id: string = (await snJson(alice.dir, ['new', 'Shared work'])).thread.id;
    await sn(alice.dir, ['sync']);
    await sn(bob.dir, ['sync']);

    step('both close the same thread offline with different summaries, then sync');
    await sn(alice.dir, ['close', id, '-s', 'alice summary']);
    await sn(bob.dir, ['close', id, '-s', 'bob summary']);
    expect((await sn(alice.dir, ['sync'])).code).toBe(0);
    const bobSync = await sn(bob.dir, ['sync']);
    expect(bobSync.code).toBe(0);
    expect(bobSync.out).toMatch(/merged 1 thread/);
    await sn(alice.dir, ['sync']);
    expect(await snJson(alice.dir, ['show', id])).toEqual(await snJson(bob.dir, ['show', id]));
    expect((await snJson(alice.dir, ['show', id])).thread.status).toBe('closed');
  });
});

describe('e2e 2: capture via Claude Code hooks', () => {
  it('a session becomes a thread, continues across turns, and reaches teammates', async () => {
    const { remote, team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--hook-command', 'sticky-note']);

    step('init installed all six Claude Code hooks');
    const settings = JSON.parse(await readFile(path.join(alice.dir, '.claude', 'settings.json'), 'utf8'));
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);

    step('session start + first prompt: no thread is committed yet');
    await alice.hook('s1', { hook_event_name: 'SessionStart', source: 'startup' });
    await alice.hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'Add pagination to the orders API' });
    expect((await snJson(alice.dir, ['threads'])).threads).toEqual([]);

    step('turn 1: edits, then Stop commits the thread with its files');
    await alice.hook('s1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(alice.dir, 'src/orders.ts') } });
    await alice.hook('s1', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'test/orders.test.ts' } });
    await alice.hook('s1', { hook_event_name: 'Stop' });
    let [thread] = (await snJson(alice.dir, ['threads'])).threads;
    expect(thread).toMatchObject({ title: 'Add pagination to the orders API', author: { name: 'Alice' }, files: ['src/orders.ts', 'test/orders.test.ts'] });
    expect(thread.sessions).toMatchObject([{ id: 's1', endedAt: null }]);

    step('turn 2 continues the same thread');
    await alice.hook('s1', { hook_event_name: 'UserPromptSubmit', prompt: 'also add a cursor param' });
    await alice.hook('s1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/cursor.ts' } });
    await alice.hook('s1', { hook_event_name: 'Stop' });
    const all = (await snJson(alice.dir, ['threads', '-a'])).threads;
    expect(all).toHaveLength(1);
    expect(all[0].files).toEqual(['src/orders.ts', 'test/orders.test.ts', 'src/cursor.ts']);

    step("turn 1's background sync published the new thread mid-session");
    await waitForRemoteThread(remote, thread.id);

    step('session end marks it ended and pushes; Bob sees the finished thread');
    await alice.hook('s1', { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
    await sn(bob.dir, ['sync']);
    [thread] = (await snJson(bob.dir, ['threads'])).threads;
    expect(thread.files).toContain('src/cursor.ts');
    expect(thread.sessions[0].endedAt).not.toBeNull();

    step('a second session starts a new thread (resume is not built yet)');
    await alice.hook('s2', { hook_event_name: 'UserPromptSubmit', prompt: 'follow-up on pagination' });
    await alice.hook('s2', { hook_event_name: 'Stop' });
    expect((await snJson(alice.dir, ['threads'])).threads.map((t: any) => t.title)).toEqual(['follow-up on pagination', 'Add pagination to the orders API']);

    step('the hook log has a start/ok pair for every event and no failures');
    const log = await readFile(path.join(alice.dir, '.git', 'sticky-note', 'logs', 'hooks.log'), 'utf8');
    expect(log).not.toMatch(/FAILED/);
    expect(log.match(/ start$/gm)!.length).toBe(log.match(/ ok \d+ms$/gm)!.length);
    expect(existsSync(path.join(alice.dir, '.git', 'sticky-note', 'sessions', 's1.json'))).toBe(false);
  });
});

describe('e2e 3: surfacing to a teammate', () => {
  it("Bob is told about Alice's live work at start, on a related prompt, and before editing her file", async () => {
    const { remote, team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--skip-hooks']);

    step('Alice is mid-session editing src/billing/invoice.ts (session still open)');
    await alice.hook('a1', { hook_event_name: 'SessionStart', source: 'startup' });
    await alice.hook('a1', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix rounding in invoice totals' });
    await alice.hook('a1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/billing/invoice.ts' } });
    await alice.hook('a1', { hook_event_name: 'Stop' });
    const aliceThread = (await snJson(alice.dir, ['threads'])).threads[0];
    await sn(alice.dir, ['sync']);
    await waitForRemoteThread(remote, aliceThread.id);

    step('Bob starts a session: sees Alice in progress (agent context + a line for Bob)');
    await sn(bob.dir, ['sync']); // stands in for Bob's own background sync having finished
    const start = await bob.hook('b1', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(start?.hookSpecificOutput?.additionalContext).toContain('IN PROGRESS · "Fix rounding in invoice totals" · Alice');
    expect(start?.systemMessage).toMatch(/^sticky-note: 1 related thread \(1 in progress\)/);

    step('a related prompt surfaces nothing new: Bob already saw this version');
    expect(await bob.hook('b1', { hook_event_name: 'UserPromptSubmit', prompt: 'refactor invoice.ts tax code' })).toBeNull();

    step('an unrelated prompt surfaces nothing');
    expect(await bob.hook('b1', { hook_event_name: 'UserPromptSubmit', prompt: 'update the README badges' })).toBeNull();

    step("before Bob's agent edits invoice.ts: an overlap warning, once");
    const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(bob.dir, 'src/billing/invoice.ts') } };
    const warn = await bob.hook('b1', edit);
    expect(warn?.hookSpecificOutput?.additionalContext).toContain('Alice (working on it right now): "Fix rounding in invoice totals"');
    expect(warn?.systemMessage).toBe('sticky-note: Alice is working on src/billing/invoice.ts ("Fix rounding in invoice totals")');
    expect(await bob.hook('b1', edit)).toBeNull();

    step('Alice adds more work; Bob\'s next related prompt shows the updated thread');
    await alice.hook('a1', { hook_event_name: 'UserPromptSubmit', prompt: 'also round credit notes' });
    await alice.hook('a1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/billing/credit-note.ts' } });
    await alice.hook('a1', { hook_event_name: 'Stop' });
    await sn(alice.dir, ['sync']);
    await sn(bob.dir, ['sync']);
    const related = await bob.hook('b1', { hook_event_name: 'UserPromptSubmit', prompt: 'look at invoice.ts again' });
    expect(related?.hookSpecificOutput?.additionalContext).toContain('src/billing/credit-note.ts');

    step('`sticky-note context` previews exactly what hooks inject');
    const preview = await snJson(bob.dir, ['context', '-f', 'src/billing/invoice.ts']);
    expect(preview.ranked[0]).toMatchObject({ title: 'Fix rounding in invoice totals' });
    expect(preview.injected).toContain('Alice');

    step("after Alice's session ends and syncs, it's no longer shown as in progress");
    await alice.hook('a1', { hook_event_name: 'SessionEnd', reason: 'other' });
    await sn(bob.dir, ['sync']);
    const later = await bob.hook('b2', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(later?.hookSpecificOutput?.additionalContext ?? '').not.toContain('IN PROGRESS');
  });
});

describe('e2e 4: presence, claims, and history across teammates', () => {
  it('who, claim warnings, and git history leading back to a teammate\'s thread', async () => {
    const { team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--skip-hooks']);

    step('Bob claims the schema and shares it');
    expect((await sn(bob.dir, ['claim', 'db/schema.sql', '-m', 'adding the orders table'])).code).toBe(0);
    await sn(bob.dir, ['sync']);

    step("Bob's session is active; Alice's `who` shows him and his claim");
    await bob.hook('b1', { hook_event_name: 'UserPromptSubmit', prompt: 'Add an orders table' });
    await bob.hook('b1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'db/migrations/002_orders.sql' } });
    await bob.hook('b1', { hook_event_name: 'Stop' });
    await sn(bob.dir, ['sync']);
    await sn(alice.dir, ['sync']);
    const who = await snJson(alice.dir, ['who']);
    expect(who.working).toMatchObject([{ person: { name: 'Bob' }, live: true, thread: { title: 'Add an orders table' } }]);
    expect(who.claims).toMatchObject([{ file: 'db/schema.sql', owner: { name: 'Bob' }, reason: 'adding the orders table' }]);
    expect((await sn(alice.dir, ['who'])).out).toMatch(/Bob\s+active/);

    step("Alice's agent is warned before editing Bob's claimed file");
    const warn = await alice.hook('a1', { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'db/schema.sql' } });
    expect(warn?.systemMessage).toBe('sticky-note: Bob has claimed db/schema.sql (adding the orders table)');

    step('Alice commits code during a session and pushes it normally');
    const { writeFile } = await import('node:fs/promises');
    await alice.hook('a2', { hook_event_name: 'SessionStart', source: 'startup' });
    await alice.hook('a2', { hook_event_name: 'UserPromptSubmit', prompt: 'Cache exchange rates' });
    await writeFile(path.join(alice.dir, 'rates.ts'), 'export const ttl = 60;\n');
    await alice.git.run(['add', 'rates.ts']);
    await alice.git.run(['commit', '-q', '-m', 'cache exchange rates']);
    await alice.git.run(['push', '-q', 'origin', 'main']);
    await alice.hook('a2', { hook_event_name: 'Stop' });
    await alice.hook('a2', { hook_event_name: 'SessionEnd', reason: 'other' });

    step("Bob pulls the code; his agent reading rates.ts is shown Alice's thread via git history");
    await bob.git.run(['pull', '-q', 'origin', 'main']);
    await sn(bob.dir, ['sync']);
    const history = await bob.hook('b1', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(bob.dir, 'rates.ts') } });
    expect(history?.hookSpecificOutput?.additionalContext).toContain('Earlier work on rates.ts:');
    expect(history?.hookSpecificOutput?.additionalContext).toContain('"Cache exchange rates" · Alice');
    expect(history?.hookSpecificOutput?.additionalContext).toMatch(/changed rates\.ts \(commit [0-9a-f]{7}\)/);

    step('Bob releases the claim; Alice no longer sees it');
    await sn(bob.dir, ['unclaim', '--all']);
    await sn(bob.dir, ['sync']);
    await sn(alice.dir, ['sync']);
    expect((await snJson(alice.dir, ['claims'])).claims).toEqual([]);
  });
});

describe('e2e 5: the MCP server, launched the way .mcp.json says', () => {
  it("Bob's agent asks before editing and searches before starting work", async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { readFile } = await import('node:fs/promises');
    const { team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--hook-command', `node "$CLAUDE_PROJECT_DIR/../../never-used"`]);

    step('init registered the server in .mcp.json');
    const mcpJson = JSON.parse(await readFile(path.join(bob.dir, '.mcp.json'), 'utf8'));
    expect(mcpJson.mcpServers['sticky-note']).toMatchObject({ type: 'stdio', command: 'node' });
    expect(mcpJson.mcpServers['sticky-note'].args.at(-1)).toBe('mcp');

    step('Alice is working on src/payments/refund.ts and once gave up on idempotency keys');
    await alice.hook('a1', { hook_event_name: 'UserPromptSubmit', prompt: 'Handle duplicate refund webhooks' });
    await alice.hook('a1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/payments/refund.ts' } });
    await alice.hook('a1', { hook_event_name: 'Stop' });
    await sn(alice.dir, ['sync']);
    await sn(bob.dir, ['sync']);

    step("Bob's MCP client launches `sticky-note mcp` over stdio (like Claude Code, Cursor, ...)");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      cwd: bob.dir,
      env: { ...process.env, STICKY_NO_BACKGROUND_SYNC: '1' } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    try {
      const call = async (name: string, args: Record<string, unknown>) =>
        ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text;

      expect((await client.listTools()).tools).toHaveLength(10);

      step('check_overlaps before editing refund.ts → Alice is on it');
      expect(await call('check_overlaps', { files: ['src/payments/refund.ts'] })).toContain('Alice (working on it right now): "Handle duplicate refund webhooks"');

      step('search_threads before starting → finds her thread');
      expect(await call('search_threads', { query: 'refund webhooks' })).toContain('"Handle duplicate refund webhooks" · Alice');

      step('get_presence → Alice is active');
      expect(await call('get_presence', {})).toMatch(/- Alice: "Handle duplicate refund webhooks"/);

      step('claim_files from the agent → shows up in the CLI');
      await call('claim_files', { files: ['src/payments/ledger.ts'], reason: 'ledger rewrite' });
      expect((await snJson(bob.dir, ['claims'])).claims).toMatchObject([{ file: 'src/payments/ledger.ts', owner: { name: 'Bob' } }]);
    } finally {
      await client.close();
    }
  });
});

describe('e2e 6: resuming a thread, including handing it to a teammate', () => {
  it('Alice resumes her own paused thread, then Bob picks it up where she left off', async () => {
    const { team } = await makeTeam('Alice', 'Bob');
    const [alice, bob] = team as [(typeof team)[0], (typeof team)[0]];
    for (const p of team) await sn(p.dir, ['init', '--skip-hooks', '--skip-mcp']);

    step('Alice starts investigating a bug, then her session ends mid-investigation');
    await alice.hook('a1', { hook_event_name: 'UserPromptSubmit', prompt: 'Investigate why checkout totals are off by a cent' });
    await alice.hook('a1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/checkout/totals.ts' } });
    await alice.hook('a1', { hook_event_name: 'Stop' });
    await sn(alice.dir, ['sync']);
    const threadId = (await snJson(alice.dir, ['threads'])).threads[0].id;

    step('a day later, Alice resumes it herself in a new session');
    const armed = await snJson(alice.dir, ['resume', threadId]);
    expect(armed.armed).toBe(threadId);
    const resumed1 = await alice.hook('a2', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(resumed1?.hookSpecificOutput?.additionalContext).toContain(`Resumed thread "Investigate why checkout totals are off by a cent" (id ${threadId})`);
    await alice.hook('a2', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/checkout/rounding.ts' } });
    await alice.hook('a2', { hook_event_name: 'Stop' });
    await alice.hook('a2', { hook_event_name: 'SessionEnd', reason: 'other' });
    await sn(alice.dir, ['sync']);

    step('the thread now shows both sessions and both files, under one id');
    const afterResume = (await snJson(alice.dir, ['show', threadId])).thread;
    expect(afterResume.sessions).toHaveLength(2);
    expect(afterResume.files.sort()).toEqual(['src/checkout/rounding.ts', 'src/checkout/totals.ts']);

    step("the audit trail shows who created and who resumed it");
    const auditOut = (await sn(alice.dir, ['audit', '--thread', threadId])).out;
    expect(auditOut).toMatch(/thread\.resumed/);
    expect(auditOut).toMatch(/thread\.created/);

    step('Bob picks it up next: he resumes the same thread from his own clone');
    await sn(bob.dir, ['sync']);
    await sn(bob.dir, ['resume', threadId]);
    const bobStart = await bob.hook('b1', { hook_event_name: 'SessionStart', source: 'startup' });
    expect(bobStart?.hookSpecificOutput?.additionalContext).toContain('rounding.ts');
    await bob.hook('b1', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/checkout/tests.ts' } });
    await bob.hook('b1', { hook_event_name: 'Stop' });
    await sn(bob.dir, ['sync']);
    await sn(alice.dir, ['sync']);

    step('one thread, one history, contributed to by both of them');
    const final = (await snJson(alice.dir, ['show', threadId])).thread;
    expect(final.sessions).toHaveLength(3);
    expect(final.files).toContain('src/checkout/tests.ts');
    expect(final.contributors.map((c: { name: string }) => c.name).sort()).toEqual(['Alice', 'Bob']);
  });
});
