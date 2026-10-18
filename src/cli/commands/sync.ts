import { SyncConflictError } from '../../core/store/thread-store.js';
import { defineCommand } from '../command.js';
import { CliError } from '../errors.js';

export const syncCommand = defineCommand({
  name: 'sync',
  summary: 'Pull teammates\' threads and push yours',
  description: 'Fetches the data branch from the remote, rebases local thread commits onto it, and pushes.',

  async run({ out, services }) {
    const [store, { config }] = await Promise.all([services.store(), services.config()]);
    let result;
    try {
      result = await store.sync();
    } catch (err) {
      if (err instanceof SyncConflictError) throw new CliError(err.message, 1, 'Your local thread data is unchanged.');
      throw err;
    }

    out.json({ ok: true, ...result });
    if (result.skipped === 'no-remote') {
      out.warn(`No remote "${config.remote}" configured; threads are only stored locally.`);
      return;
    }
    out.success(`Synced ${config.dataBranch} with ${config.remote}: pulled ${result.pulled}, pushed ${result.pushed}${result.merged ? `, merged ${result.merged} thread(s)` : ''}`);
  },
});
