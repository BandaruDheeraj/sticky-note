import { defineCommand } from '../command.js';
import { UsageError } from '../errors.js';
import { rankThreads } from '../../surfacing/relevance.js';
import { renderContext } from '../../surfacing/render.js';
import { PROMPT_LIMIT, PROMPT_MIN_SCORE, SESSION_START_LIMIT, SESSION_START_MIN_SCORE } from '../../surfacing/policy.js';

export const contextCommand = defineCommand({
  name: 'context',
  summary: 'Preview the team context an agent would be given',
  description:
    'Shows how threads rank for a prompt and/or files, with scores and reasons, and the exact text hooks would inject. ' +
    'With no --prompt or --file, previews what a new session is given at start.',
  options: {
    prompt: { type: 'string', short: 'p', valueName: '<text>', description: 'Rank against this prompt text' },
    file: { type: 'string', short: 'f', multiple: true, valueName: '<path>', description: 'Rank against a repo-relative file' },
    all: { type: 'boolean', short: 'a', description: 'Show every scored thread, not just those that would be injected' },
  },
  examples: ['sticky-note context', 'sticky-note context -p "why does login loop?"', 'sticky-note context -f src/auth.ts --all'],

  async run({ out, services }, { options }) {
    if (options.prompt !== undefined && !options.prompt.trim()) throw new UsageError('--prompt is empty');
    const [store, me, branch] = await Promise.all([services.store(), services.identity(), services.git().currentBranch()]);
    const { threads } = await store.list();
    const now = new Date();

    const atStart = options.prompt === undefined && !options.file?.length;
    const ranked = rankThreads(threads, { me, branch, text: options.prompt, files: options.file, now });
    const [minScore, limit] = atStart ? [SESSION_START_MIN_SCORE, SESSION_START_LIMIT] : [PROMPT_MIN_SCORE, PROMPT_LIMIT];
    const selected = ranked.filter((r) => r.score >= minScore).slice(0, limit);
    const text = renderContext(atStart ? 'Team activity in this repo:' : 'Related work by your team:', selected, now);

    out.json({
      ok: true,
      mode: atStart ? 'session-start' : 'prompt',
      ranked: (options.all ? ranked : selected).map((r) => ({ id: r.thread.id, title: r.thread.title, score: r.score, reasons: r.reasons })),
      injected: text,
    });

    const shown = options.all ? ranked : selected;
    if (shown.length) {
      out.table(
        shown.map((r) => [
          out.style(r.thread.id, 'cyan'),
          String(r.score),
          selected.includes(r) ? 'yes' : out.style('no', 'dim'),
          r.thread.title,
          out.style(r.reasons.join('; '), 'dim'),
        ]),
        ['ID', 'SCORE', 'INJECT', 'TITLE', 'WHY'],
      );
      out.print();
    }
    out.print(text ? out.style('Injected text:', 'bold') : 'Nothing would be injected.');
    if (text) out.print(text);
  },
});
