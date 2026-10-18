import { closeThread } from '../../core/thread.js';
import { defineCommand } from '../command.js';
import { requireThread } from './shared.js';

export const closeCommand = defineCommand({
  name: 'close',
  summary: 'Mark a thread as done',
  args: [{ name: 'id', description: 'Thread id or unique prefix', required: true }],
  options: {
    summary: { type: 'string', short: 's', valueName: '<text>', description: 'Closing summary, appended to the narrative' },
  },
  examples: ['sticky-note close m2abc1 -s "Fixed by clearing the session cookie on logout"'],

  async run({ out, services }, { args, options }) {
    const store = await services.store();
    const thread = await requireThread(store, args.id!);
    if (thread.status === 'closed') {
      out.json({ ok: true, thread, alreadyClosed: true });
      out.print(`Thread ${thread.id} is already closed.`);
      return;
    }
    const closed = closeThread(thread, { summary: options.summary });
    await store.save(closed, `thread ${closed.id}: closed`);

    out.json({ ok: true, thread: closed });
    out.success(`Closed ${out.style(closed.id, 'cyan')}: ${closed.title}`);
  },
});
