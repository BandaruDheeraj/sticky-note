import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Services } from '../../src/cli/context.js';
import { addClaims, ClaimSet } from '../../src/core/claim.js';
import { GitBranchStore } from '../../src/core/store/git-branch-store.js';
import { closeThread, createThread } from '../../src/core/thread.js';
import { installMcpServer, splitCommand } from '../../src/mcp/install.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { runCli } from '../helpers/cli.js';
import { cleanupTmpDirs, makeRepo } from '../helpers/repo.js';

afterEach(cleanupTmpDirs);

const alice = { name: 'Alice', email: 'alice@example.com' };
const BRANCH = 'sticky-note/context';

async function setup() {
  const repo = await makeRepo();
  await runCli(['init', '--skip-hooks', '--skip-mcp'], { cwd: repo.dir });
  const store = new GitBranchStore({ repoDir: repo.dir, dataBranch: BRANCH, remote: 'origin' });
  const server = createMcpServer(new Services(repo.dir), '0.0.0-test');
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
  };
  return { ...repo, store, client, call };
}

describe('MCP server', () => {
  it('exposes the tools with instructions', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_overlaps',
      'claim_files',
      'close_thread',
      'get_file_context',
      'get_presence',
      'get_stuck_threads',
      'get_thread',
      'list_threads',
      'search_threads',
    ]);
    expect(client.getInstructions()).toMatch(/Call check_overlaps before editing files/);
  });

  it('check_overlaps reports claims and live teammate work, or all clear', async () => {
    const { dir, store, call } = await setup();
    await store.saveClaims(addClaims(ClaimSet.parse({ schemaVersion: 1, owner: alice }), ['db/schema.sql'], { reason: 'migration' }));
    await store.save(
      createThread({ title: 'Auth refactor', author: alice, branch: 'main', files: ['src/auth.ts'], session: { id: 's', agent: 'claude-code', startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() } }),
    );

    const hit = await call('check_overlaps', { files: ['db/schema.sql', path.join(dir, 'src/auth.ts'), 'src/free.ts'] });
    expect(hit.text).toContain('db/schema.sql is claimed by a teammate');
    expect(hit.text).toContain('Alice: migration');
    expect(hit.text).toContain('Alice (working on it right now): "Auth refactor"');
    expect(hit.text).not.toContain('src/free.ts');

    expect((await call('check_overlaps', { files: ['src/free.ts'] })).text).toBe('No overlaps: no teammate has claimed or is working on src/free.ts.');
  });

  it('search_threads finds prior attempts, including closed threads and failed approaches', async () => {
    const { store, call } = await setup();
    await store.save(
      closeThread({
        ...createThread({ title: 'Speed up CSV export', author: alice, branch: 'main', files: ['src/export/csv.ts'] }),
        failedApproaches: [{ description: 'streaming with worker threads', reason: 'memory blowup', at: new Date().toISOString() }],
      }),
    );
    await store.save(createThread({ title: 'Unrelated', author: alice, branch: 'main' }));

    const r = await call('search_threads', { query: 'csv worker' });
    expect(r.text).toContain('"Speed up CSV export"');
    expect(r.text).toContain("Tried, didn't work: streaming with worker threads (memory blowup)");
    expect(r.text).not.toContain('Unrelated');
    expect((await call('search_threads', { query: 'nothing-matches-this' })).text).toMatch(/No threads match/);
  });

  it('get_file_context follows git history back to threads', async () => {
    const { dir, git, store, call } = await setup();
    await writeFile(path.join(dir, 'rates.ts'), 'x\n');
    await git.run(['add', 'rates.ts']);
    await git.run(['commit', '-q', '-m', 'rates']);
    const sha = await git.run(['rev-parse', 'HEAD']);
    await store.save({ ...createThread({ title: 'Cache rates', author: alice, branch: 'main' }), commits: [sha] });

    const r = await call('get_file_context', { file: 'rates.ts' });
    expect(r.text).toContain('Earlier work on rates.ts:');
    expect(r.text).toContain(`changed rates.ts (commit ${sha.slice(0, 7)})`);
    expect((await call('get_file_context', { file: 'other.ts' })).text).toBe('No recorded team work on other.ts.');
  });

  it('lists, gets, and closes threads; reports bad ids as tool errors', async () => {
    const { store, call } = await setup();
    const t = createThread({ title: 'Ship pagination', author: alice, branch: 'main' });
    await store.save(t);
    await store.save({ ...createThread({ title: 'Blocked on CI', author: alice, branch: 'main' }), status: 'stuck' });

    expect((await call('list_threads')).text).toMatch(/\[active\] "Ship pagination" by Alice/);
    expect((await call('get_stuck_threads')).text).toContain('STUCK · "Blocked on CI"');
    expect(JSON.parse((await call('get_thread', { id: t.id.slice(0, 10) })).text)).toMatchObject({ id: t.id, title: 'Ship pagination' });
    expect(await call('get_thread', { id: 'nope' })).toMatchObject({ isError: true });

    expect((await call('close_thread', { id: t.id, summary: 'Done via cursor param' })).text).toMatch(/^Closed "Ship pagination"/);
    expect(await store.get(t.id)).toMatchObject({ status: 'closed', narrative: 'Done via cursor param' });
    expect((await call('close_thread', { id: t.id })).text).toMatch(/already closed/);
    expect((await call('list_threads', { status: 'closed' })).text).toContain('Ship pagination');
  });

  it('claim_files claims for the current person; get_presence shows claims', async () => {
    const { call } = await setup();
    expect((await call('claim_files', { files: ['src/a.ts'], reason: 'refactor', hours: 2 })).text).toMatch(/^Claimed src\/a.ts for 2h \(refactor\)/);
    const presence = (await call('get_presence')).text;
    expect(presence).toContain('Nobody is active right now.');
    expect(presence).toContain('- src/a.ts: Test User (refactor)');
    expect(await call('claim_files', { files: ['/elsewhere/x.ts'] })).toMatchObject({ isError: true });
  });
});

describe('installMcpServer', () => {
  it('registers sticky-note alongside other servers, idempotently', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['gh'] }, 'sticky-note': { command: 'node', args: ['.claude/sticky-note-mcp.js'] } } }));

    expect((await installMcpServer(dir, 'node "$CLAUDE_PROJECT_DIR/dist/cli.js"')).changed).toBe(true);
    const config = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(config.mcpServers.github).toEqual({ command: 'npx', args: ['gh'] });
    expect(config.mcpServers['sticky-note']).toEqual({ type: 'stdio', command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/dist/cli.js', 'mcp'] });
    expect((await installMcpServer(dir, 'node "$CLAUDE_PROJECT_DIR/dist/cli.js"')).changed).toBe(false);

    await installMcpServer(dir, 'npx --no-install sticky-note-cli');
    const npx = JSON.parse(await readFile(path.join(dir, '.mcp.json'), 'utf8'));
    expect(npx.mcpServers['sticky-note']).toEqual({ type: 'stdio', command: 'npx', args: ['--no-install', 'sticky-note-cli', 'mcp'] });
  });

  it('splits shell-style commands', () => {
    expect(splitCommand('node "/a b/cli.js" --x')).toEqual(['node', '/a b/cli.js', '--x']);
    expect(splitCommand("node '/a b'/cli.js")).toEqual(['node', '/a b/cli.js']);
    expect(splitCommand('  sticky-note  ')).toEqual(['sticky-note']);
  });
});
