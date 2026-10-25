import { ResumeIntentStore } from '../../core/resume.js';
import { localStateDir } from '../../core/paths.js';
import { AmbiguousIdError } from '../../core/store/thread-store.js';
import type { Thread } from '../../core/thread.js';
import { searchThreads } from '../../surfacing/queries.js';
import { defineCommand } from '../command.js';
import { printThread } from '../format.js';
import { CliError, UsageError } from '../errors.js';

export const resumeCommand = defineCommand({
  name: 'resume',
  summary: 'Continue a thread, in your next prompt or this session',
  description:
    'Finds a thread by id or by words from its title and notes, then arms a one-time resume: the next prompt ' +
    'in this repo (in a new session, or this one) attaches to it instead of starting a new thread. A closed ' +
    'thread is reopened. Works mid-session: run this in a terminal while Claude Code is open, then send a prompt.',
  args: [{ name: 'query', description: 'Thread id, unique id prefix, or search words', required: true, variadic: true }],
  examples: ['sticky-note resume m2abc1', 'sticky-note resume invoice rounding bug'],

  async run({ out, services }, { rest }) {
    const query = rest.join(' ').trim();
    if (!query) throw new UsageError('Give a thread id or some search words');

    const store = await services.store();
    const { threads } = await store.list();

    let thread: Thread | undefined;
    try {
      thread = (await store.get(query)) ?? undefined;
    } catch (err) {
      if (err instanceof AmbiguousIdError) throw new CliError(err.message, 1, 'Use more characters of the id.');
      throw err;
    }

    if (!thread) {
      const results = searchThreads(threads, query);
      if (results.length === 0) {
        throw new CliError(`No thread matches "${query}"`, 1, 'Run "sticky-note threads -a" to list ids, or try different words.');
      }
      // Only auto-pick when there's a clear winner; otherwise ask instead of guessing wrong.
      if (results.length > 1 && results[0]!.score === results[1]!.score) {
        out.json({ ok: false, ambiguous: true, candidates: results.slice(0, 5).map((r) => ({ id: r.thread.id, title: r.thread.title, score: r.score })) });
        out.print(`Multiple threads match "${query}":`);
        out.table(
          results.slice(0, 5).map((r) => [out.style(r.thread.id, 'cyan'), String(r.score), r.thread.title]),
          ['ID', 'SCORE', 'TITLE'],
        );
        out.print('Re-run with a specific id.');
        return 1;
      }
      thread = results[0]!.thread;
    }

    const resume = new ResumeIntentStore(await localStateDir(services.git()));
    await resume.set(thread.id);

    out.json({ ok: true, armed: thread.id, thread });
    out.success(`Armed resume for ${out.style(thread.id, 'cyan')}: "${thread.title}"`);
    out.print(out.style('Send your next prompt here (new session or this one) — it will continue this thread.', 'dim'));
    out.print();
    printThread(out, thread);
  },
});
