import { text } from 'node:stream/consumers';
import { ADAPTERS } from '../../hooks/adapters/index.js';
import { runHook } from '../../hooks/runner.js';
import { defineCommand } from '../command.js';
import { UsageError } from '../errors.js';

export const runHookCommand = defineCommand({
  name: 'run-hook',
  hidden: true,
  summary: 'Handle a coding-agent hook event (called by the agent, not by people)',
  description: 'Reads the hook payload as JSON on stdin. Always exits 0 so a sticky-note problem never blocks the agent.',
  args: [{ name: 'agent', description: `Agent that fired the hook: ${Object.keys(ADAPTERS).join(', ')}`, required: true }],

  async run({ out, stdin }, { args }) {
    const adapter = ADAPTERS[args.agent!];
    if (!adapter) throw new UsageError(`Unknown agent "${args.agent}"`, `Expected one of: ${Object.keys(ADAPTERS).join(', ')}`);
    const output = await runHook(adapter, await text(stdin));
    if (output) out.print(output);
  },
});
