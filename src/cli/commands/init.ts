import path from 'node:path';
import { CONFIG_RELATIVE_PATH, Config, saveConfig } from '../../core/config.js';
import { GitBranchStore } from '../../core/store/git-branch-store.js';
import { CLAUDE_SETTINGS_PATH, DEFAULT_HOOK_COMMAND, installClaudeCodeHooks } from '../../hooks/install/claude-code.js';
import { defineCommand } from '../command.js';

export const initCommand = defineCommand({
  name: 'init',
  summary: 'Set up sticky-note in this repository',
  description:
    'Writes .sticky-note/config.json, creates the private data worktree, and installs Claude Code hooks ' +
    'in .claude/settings.json. If the team already has a data branch on the remote, it is reused. Safe to re-run.',
  options: {
    branch: { type: 'string', valueName: '<name>', description: 'Data branch name (default: sticky-note/context)' },
    remote: { type: 'string', valueName: '<name>', description: 'Remote to sync with (default: origin)' },
    'skip-hooks': { type: 'boolean', description: 'Do not install agent hooks' },
    'hook-command': {
      type: 'string',
      valueName: '<cmd>',
      description: `How hooks invoke sticky-note (default: ${DEFAULT_HOOK_COMMAND})`,
    },
  },
  examples: [
    'sticky-note init',
    'sticky-note init --branch team/sticky --remote upstream',
    `sticky-note init --hook-command 'node "$CLAUDE_PROJECT_DIR/dist/cli.js"'   # developing sticky-note itself`,
  ],

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

    const hooks = options['skip-hooks'] ? null : await installClaudeCodeHooks(repoRoot, options['hook-command']);

    out.json({ ok: true, config, configPath: path.join(repoRoot, CONFIG_RELATIVE_PATH), worktree, hooks });
    out.success(`${changed ? 'Wrote' : 'Kept'} ${CONFIG_RELATIVE_PATH}`);
    out.success(`Data branch ${out.style(config.dataBranch, 'cyan')} ready at ${path.relative(repoRoot, worktree)}`);
    if (hooks) out.success(`${hooks.changed ? 'Installed' : 'Kept'} Claude Code hooks in ${CLAUDE_SETTINGS_PATH}`);
    if (changed || hooks?.changed) {
      out.print(out.style(`Commit ${CONFIG_RELATIVE_PATH}${hooks ? ` and ${CLAUDE_SETTINGS_PATH}` : ''} so teammates get the same setup.`, 'dim'));
    }
  },
});
