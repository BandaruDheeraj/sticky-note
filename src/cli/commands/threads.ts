import { ThreadStatus } from '../../core/thread.js';
import { defineCommand } from '../command.js';
import { UsageError } from '../errors.js';
import { relativeTime, statusLabel } from '../format.js';

export const threadsCommand = defineCommand({
  name: 'threads',
  aliases: ['ls'],
  summary: 'List threads',
  description: 'Lists open threads, most recently updated first. Closed threads are hidden unless --all or --status closed.',
  options: {
    all: { type: 'boolean', short: 'a', description: 'Include closed threads' },
    status: { type: 'string', short: 's', valueName: '<status>', description: `Only this status: ${ThreadStatus.options.join(', ')}` },
    author: { type: 'string', valueName: '<name|email>', description: 'Only threads by or with this person' },
    limit: { type: 'string', short: 'n', valueName: '<n>', description: 'Show at most n threads (default 20)' },
  },
  examples: ['sticky-note threads', 'sticky-note threads --status stuck', 'sticky-note ls -a --json'],

  async run({ out, services }, { options }) {
    const status = options.status ? ThreadStatus.safeParse(options.status) : null;
    if (status && !status.success) throw new UsageError(`Invalid --status "${options.status}"`);
    const limit = options.limit ? Number(options.limit) : 20;
    if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`Invalid --limit "${options.limit}"`);

    const store = await services.store();
    const { threads, invalid } = await store.list({
      status: status?.data ?? (options.all ? undefined : ['active', 'stuck']),
      author: options.author,
    });
    const shown = threads.slice(0, limit);

    for (const bad of invalid) out.warn(`Skipping unreadable ${bad.file}: ${bad.error}`);
    out.json({ ok: true, total: threads.length, threads: shown });

    if (shown.length === 0) {
      out.print('No threads yet. Start one with: sticky-note new "<title>"');
      return;
    }
    out.table(
      shown.map((t) => [out.style(t.id, 'cyan'), statusLabel(out, t.status), t.author.name, relativeTime(t.updatedAt), t.title]),
      ['ID', 'STATUS', 'AUTHOR', 'UPDATED', 'TITLE'],
    );
    if (threads.length > shown.length) out.print(out.style(`… ${threads.length - shown.length} more (use --limit)`, 'dim'));
  },
});
