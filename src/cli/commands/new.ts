import { createThread, WorkType } from '../../core/thread.js';
import { defineCommand } from '../command.js';
import { UsageError } from '../errors.js';

export const newCommand = defineCommand({
  name: 'new',
  summary: 'Start a new thread',
  args: [{ name: 'title', description: 'What this thread is about', required: true, variadic: true }],
  options: {
    file: { type: 'string', short: 'f', multiple: true, valueName: '<path>', description: 'File this work touches' },
    type: { type: 'string', short: 't', valueName: '<type>', description: `Work type: ${WorkType.options.join(', ')}` },
    message: { type: 'string', short: 'm', valueName: '<text>', description: 'Initial narrative' },
  },
  examples: ['sticky-note new "Fix login redirect loop" -t bugfix -f src/auth.ts'],

  async run({ out, services }, { args, options }) {
    const workType = WorkType.safeParse(options.type ?? 'other');
    if (!workType.success) throw new UsageError(`Invalid --type "${options.type}"`, `Expected one of: ${WorkType.options.join(', ')}`);

    const [store, author, branch] = await Promise.all([services.store(), services.identity(), services.git().currentBranch()]);
    const thread = createThread({
      title: args.title!,
      author,
      branch,
      workType: workType.data,
      files: options.file,
      narrative: options.message,
    });
    await store.save(thread, `thread ${thread.id}: created`);
    await store.appendAudit(author, { action: 'thread.created', threadId: thread.id, detail: thread.title });

    out.json({ ok: true, thread });
    out.success(`Created thread ${out.style(thread.id, 'cyan')}: ${thread.title}`);
  },
});
