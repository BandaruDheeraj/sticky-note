import path from 'node:path';
import { CONFIG_RELATIVE_PATH, Config, saveConfig } from '../../core/config.js';
import { GitBranchStore } from '../../core/store/git-branch-store.js';
import { defineCommand } from '../command.js';

export const initCommand = defineCommand({
  name: 'init',
  summary: 'Set up sticky-note in this repository',
  description:
    'Writes .sticky-note/config.json and creates the private data worktree. ' +
    'If the team already has a data branch on the remote, it is reused. Safe to re-run.',
  options: {
    branch: { type: 'string', valueName: '<name>', description: 'Data branch name (default: sticky-note/context)' },
    remote: { type: 'string', valueName: '<name>', description: 'Remote to sync with (default: origin)' },
  },
  examples: ['sticky-note init', 'sticky-note init --branch team/sticky --remote upstream'],

  async run({ out, services }, { options }) {
    const repoRoot = await services.repoRoot();
    const existing = await services.config();

    const config = Config.parse({
      ...existing.config,
      ...(options.branch && { dataBranch: options.branch }),
      ...(options.remote && { remote: options.remote }),
    });
    const changed = !existing.exists || JSON.stringify(config) !== JSON.stringify(existing.config);
    if (changed) await saveConfig(repoRoot, config);

    // Pick up a teammate's existing data branch before creating a fresh one.
    const git = services.git();
    if (await git.hasRemote(config.remote)) {
      const fetched = await git.tryRun(['fetch', '--quiet', config.remote, `+refs/heads/${config.dataBranch}:refs/remotes/${config.remote}/${config.dataBranch}`]);
      if (fetched === null) out.warn(`Could not fetch ${config.remote}/${config.dataBranch} (offline or not created yet); starting locally.`);
    }

    // Built from the fresh config, since services.store() would use the pre-init one.
    const store = new GitBranchStore({ repoDir: repoRoot, dataBranch: config.dataBranch, remote: config.remote });
    await store.init();
    const worktree = await store.worktreePath();

    out.json({ ok: true, config, configPath: path.join(repoRoot, CONFIG_RELATIVE_PATH), worktree });
    out.success(`${changed ? 'Wrote' : 'Kept'} ${CONFIG_RELATIVE_PATH}`);
    out.success(`Data branch ${out.style(config.dataBranch, 'cyan')} ready at ${path.relative(repoRoot, worktree)}`);
    if (changed) out.print(out.style(`Commit ${CONFIG_RELATIVE_PATH} so teammates share the same settings.`, 'dim'));
  },
});
