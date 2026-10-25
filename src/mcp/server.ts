import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Services } from '../cli/context.js';
import { activeClaims, addClaims, ClaimSet, DEFAULT_CLAIM_HOURS, ownerKey } from '../core/claim.js';
import { AmbiguousIdError } from '../core/store/thread-store.js';
import { closeThread, samePerson, type Thread } from '../core/thread.js';
import { repoRelative } from '../hooks/edited-files.js';
import { fileHistory, overlapsFor, searchThreads } from '../surfacing/queries.js';
import { isLive, lastActiveAt } from '../surfacing/relevance.js';
import { ago, renderClaimWarning, renderContext, renderOverlapWarning } from '../surfacing/render.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });
const error = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }], isError: true });

/**
 * The local MCP server: the "pull" side of sticky-note. Hooks push context
 * automatically; these tools let an agent ask on purpose (e.g. check overlaps
 * before editing), and serve agents that have no hooks at all.
 */
export function createMcpServer(services: Services, version: string): McpServer {
  const server = new McpServer(
    { name: 'sticky-note', version },
    {
      instructions:
        "sticky-note is your team's shared record of what every teammate's AI agent is doing and has done in this repo. " +
        'Call check_overlaps before editing files, search_threads before starting non-trivial work (to learn what was tried and failed), ' +
        'and close_thread when the user confirms a goal is done. Tell the user about anything relevant you find.',
    },
  );

  const repoFiles = async (files: string[]) => {
    const root = await services.repoRoot();
    return files.map((f) => repoRelative(f, services.cwd, root)).filter((f): f is string => f !== null);
  };
  const now = () => new Date();

  server.registerTool(
    'list_threads',
    {
      title: 'List threads',
      description: 'List team threads (one per agent session or goal), newest first. Open threads only unless status is given.',
      inputSchema: {
        status: z.enum(['open', 'active', 'stuck', 'closed', 'all']).default('open').describe('"open" = active or stuck'),
        author: z.string().optional().describe('Name or email'),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status, author, limit }) => {
      const store = await services.store();
      const statuses = status === 'all' ? undefined : status === 'open' ? (['active', 'stuck'] as const) : [status];
      const { threads } = await store.list({ status: statuses ? [...statuses] : undefined, author });
      if (threads.length === 0) return text('No matching threads.');
      return text(threads.slice(0, limit).map((t) => summaryLine(t, now())).join('\n'));
    },
  );

  server.registerTool(
    'get_thread',
    {
      title: 'Get thread',
      description: 'Full details of one thread: notes, files, failed approaches, sessions, commits.',
      inputSchema: { id: z.string().describe('Thread id or unique prefix') },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const found = await findThread(services, id);
      if ('error' in found) return error(found.error);
      return text(JSON.stringify(found.thread, null, 2));
    },
  );

  server.registerTool(
    'get_stuck_threads',
    {
      title: 'Get stuck threads',
      description: 'Threads marked stuck: who is stuck, on what, and what they already tried. Useful for unblocking a teammate.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { threads } = await (await services.store()).list({ status: 'stuck' });
      if (threads.length === 0) return text('Nobody is stuck right now.');
      return text(renderContext('Stuck threads:', threads.map((t) => ({ thread: t, score: 0, reasons: [], matchedFiles: [] })), now()));
    },
  );

  server.registerTool(
    'search_threads',
    {
      title: 'Search threads',
      description:
        'Search all threads (including closed) by words in titles, notes, files and failed approaches. ' +
        'Use before starting work to find prior attempts and dead ends.',
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const { threads } = await (await services.store()).list();
      const results = searchThreads(threads, query).slice(0, limit);
      if (results.length === 0) return text(`No threads match "${query}".`);
      return text(renderContext(`Threads matching "${query}":`, results, now()));
    },
  );

  server.registerTool(
    'check_overlaps',
    {
      title: 'Check overlaps',
      description:
        "Before editing files: are teammates working on them (open threads) or have they claimed them? Returns nothing to worry about if clear.",
      inputSchema: { files: z.array(z.string()).min(1).describe('Paths, absolute or relative to the repo root') },
      annotations: { readOnlyHint: true },
    },
    async ({ files }) => {
      const store = await services.store();
      const [{ threads }, claimSets, me, paths] = await Promise.all([store.list(), store.listClaims(), services.identity(), repoFiles(files)]);
      const overlaps = overlapsFor(paths, threads, claimSets, { me, now: now() });
      if (overlaps.length === 0) return text(`No overlaps: no teammate has claimed or is working on ${paths.join(', ')}.`);
      const parts = overlaps.flatMap((o) => [
        ...(o.claims.length ? [renderClaimWarning(o.file, o.claims, now())] : []),
        ...(o.threads.length ? [renderOverlapWarning(o.file, o.threads, now())] : []),
      ]);
      return text(parts.join('\n\n'));
    },
  );

  server.registerTool(
    'get_presence',
    {
      title: "Who's working on what",
      description: "Teammates whose agents are active right now (heartbeat in the last 30 min), what they're on, and active file claims.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const store = await services.store();
      const [{ threads }, claimSets] = await Promise.all([store.list(), store.listClaims()]);
      const at = now();
      const live = threads.filter((t) => isLive(t, at));
      const claims = activeClaims(claimSets, at);
      const lines = live.length
        ? live.map((t) => `- ${(t.contributors.at(-1) ?? t.author).name}: "${t.title}" (branch ${t.branch ?? '-'}, active ${ago(new Date(lastActiveAt(t)!).toISOString(), at)}, files: ${t.files.slice(-3).join(', ') || '-'}) id ${t.id}`)
        : ['Nobody is active right now.'];
      if (claims.length) lines.push('', 'Claims:', ...claims.map((c) => `- ${c.file}: ${c.owner.name}${c.reason ? ` (${c.reason})` : ''} until ${c.expiresAt}`));
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'get_file_context',
    {
      title: 'File context',
      description: "Earlier threads that worked on a file (by files touched or by commits in the file's git history), including closed ones and failed approaches.",
      inputSchema: { file: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ file }) => {
      const [path] = await repoFiles([file]);
      if (!path) return error(`${file} is outside the repository.`);
      const { threads } = await (await services.store()).list();
      const commits = ((await services.git().tryRun(['log', '--format=%H', '-n', '50', '--', path])) ?? '').split('\n').filter(Boolean);
      const history = fileHistory(threads, path, commits).slice(0, 5);
      if (history.length === 0) return text(`No recorded team work on ${path}.`);
      return text(renderContext(`Earlier work on ${path}:`, history, now()));
    },
  );

  server.registerTool(
    'close_thread',
    {
      title: 'Close thread',
      description: "Mark a thread done. Only call when the user confirms the goal is complete. The summary is appended to the thread's notes.",
      inputSchema: { id: z.string(), summary: z.string().optional().describe('What was done and how') },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ id, summary }) => {
      const found = await findThread(services, id);
      if ('error' in found) return error(found.error);
      if (found.thread.status === 'closed') return text(`Thread ${found.thread.id} was already closed.`);
      const closed = closeThread(found.thread, { summary });
      await (await services.store()).save(closed, `thread ${closed.id}: closed`);
      return text(`Closed "${closed.title}" (${closed.id}). Teammates see it after the next sync.`);
    },
  );

  server.registerTool(
    'claim_files',
    {
      title: 'Claim files',
      description: `Tell teammates the user is working on files, so their agents are warned before editing them. Expires after ${DEFAULT_CLAIM_HOURS}h by default. Only on the user's request.`,
      inputSchema: {
        files: z.array(z.string()).min(1),
        reason: z.string().optional(),
        hours: z.number().positive().max(168).default(DEFAULT_CLAIM_HOURS),
      },
    },
    async ({ files, reason, hours }) => {
      const paths = await repoFiles(files);
      if (paths.length === 0) return error('None of those files are inside the repository.');
      const [store, me] = await Promise.all([services.store(), services.identity()]);
      const sets = await store.listClaims();
      const mine = sets.find((s) => samePerson(s.owner, me) || ownerKey(s.owner) === ownerKey(me)) ?? ClaimSet.parse({ schemaVersion: 1, owner: me });
      await store.saveClaims(addClaims(mine, paths, { reason, hours }), `claims: ${me.name} claimed ${paths.join(', ')}`);
      return text(`Claimed ${paths.join(', ')} for ${hours}h${reason ? ` (${reason})` : ''}. Teammates see it after the next sync.`);
    },
  );

  return server;
}

function summaryLine(t: Thread, now: Date): string {
  const status = isLive(t, now) ? 'in progress' : t.status;
  return `- ${t.id} [${status}] "${t.title}" by ${t.author.name}, ${ago(t.updatedAt, now)}${t.branch ? `, branch ${t.branch}` : ''}${t.files.length ? `, files: ${t.files.slice(0, 3).join(', ')}${t.files.length > 3 ? ', …' : ''}` : ''}`;
}

async function findThread(services: Services, id: string): Promise<{ thread: Thread } | { error: string }> {
  try {
    const thread = await (await services.store()).get(id);
    return thread ? { thread } : { error: `No thread matches "${id}". Use list_threads or search_threads to find ids.` };
  } catch (err) {
    if (err instanceof AmbiguousIdError) return { error: err.message };
    throw err;
  }
}

