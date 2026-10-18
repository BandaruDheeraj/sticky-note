import { CONFIG_RELATIVE_PATH } from '../../core/config.js';
import { defineCommand } from '../command.js';

export const statusCommand = defineCommand({
  name: 'status',
  summary: 'Show setup, sync state and thread counts',

  async run({ out, services }) {
    const [repoRoot, { config, exists }, identity, branch, store] = await Promise.all([
      services.repoRoot(),
      services.config(),
      services.identity(),
      services.git().currentBranch(),
      services.store(),
    ]);
    const [storeStatus, { threads, invalid }] = await Promise.all([store.status(), store.list()]);
    const counts = { active: 0, stuck: 0, closed: 0 };
    for (const t of threads) counts[t.status]++;

    out.json({ ok: true, repoRoot, configured: exists, config, identity, branch, store: storeStatus, counts, invalid: invalid.length });

    const sync =
      storeStatus.remote === null
        ? 'local only (no remote)'
        : storeStatus.ahead === null
          ? `not yet pushed to ${storeStatus.remote}`
          : `${storeStatus.ahead} to push, ${storeStatus.behind} to pull (as of last fetch)`;

    out.table(
      [
        ['Repository', repoRoot],
        ['Config', exists ? CONFIG_RELATIVE_PATH : out.style('not initialized — run "sticky-note init"', 'yellow')],
        ['You', `${identity.name}${identity.email ? ` <${identity.email}>` : ''} on ${branch ?? 'detached HEAD'}`],
        ['Storage', `${storeStatus.backend} @ ${storeStatus.head ?? '-'}`],
        ['Sync', sync],
        ['Threads', `${counts.active} active, ${counts.stuck} stuck, ${counts.closed} closed`],
      ].map(([k, v]) => [out.style(k!, 'bold'), v!]),
    );
    if (invalid.length) out.warn(`${invalid.length} thread file(s) could not be read`);
  },
});
