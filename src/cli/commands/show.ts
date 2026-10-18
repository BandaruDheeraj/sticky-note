import { defineCommand } from '../command.js';
import { printThread } from '../format.js';
import { requireThread } from './shared.js';

export const showCommand = defineCommand({
  name: 'show',
  summary: 'Show one thread in full',
  args: [{ name: 'id', description: 'Thread id or unique prefix', required: true }],
  examples: ['sticky-note show m2abc1'],

  async run({ out, services }, { args }) {
    const thread = await requireThread(await services.store(), args.id!);
    out.json({ ok: true, thread });
    printThread(out, thread);
  },
});
