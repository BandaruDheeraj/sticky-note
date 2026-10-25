import { flattenAudit } from '../../core/audit.js';
import { defineCommand } from '../command.js';
import { UsageError } from '../errors.js';
import { ago } from '../../surfacing/render.js';

export const auditCommand = defineCommand({
  name: 'audit',
  summary: 'See who changed what with AI, and when',
  description: 'Thread creations, resumes, closes, and file claims, newest first. Each entry is attributed to the person who did it.',
  options: {
    author: { type: 'string', valueName: '<name|email>', description: 'Only this person' },
    thread: { type: 'string', valueName: '<id>', description: 'Only this thread (id or prefix)' },
    limit: { type: 'string', short: 'n', valueName: '<n>', description: 'Show at most n entries (default 50)' },
  },
  examples: ['sticky-note audit', 'sticky-note audit --author alice@example.com', 'sticky-note audit --thread m2abc1'],

  async run({ out, services }, { options }) {
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit <= 0) throw new UsageError(`Invalid --limit "${options.limit}"`);

    const store = await services.store();
    let records = flattenAudit(await store.listAudit());
    if (options.author) {
      const needle = options.author.toLowerCase();
      records = records.filter((r) => r.actor.name.toLowerCase() === needle || r.actor.email?.toLowerCase() === needle);
    }
    if (options.thread) records = records.filter((r) => r.threadId === options.thread || r.threadId?.startsWith(options.thread!));
    records.sort((a, b) => b.at.localeCompare(a.at));
    const shown = records.slice(0, limit);

    out.json({ ok: true, total: records.length, entries: shown });
    if (shown.length === 0) {
      out.print('No audit entries yet.');
      return;
    }
    const now = new Date();
    out.table(
      shown.map((r) => [ago(r.at, now), r.actor.name, r.action, r.threadId ?? r.file ?? '-', r.detail ?? '']),
      ['WHEN', 'WHO', 'ACTION', 'TARGET', 'DETAIL'],
    );
    if (records.length > shown.length) out.print(out.style(`… ${records.length - shown.length} more (use --limit)`, 'dim'));
  },
});
