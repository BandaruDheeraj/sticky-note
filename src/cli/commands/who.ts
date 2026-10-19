import { activeClaims } from '../../core/claim.js';
import { isLive, lastActiveAt } from '../../surfacing/relevance.js';
import { ago } from '../../surfacing/render.js';
import { defineCommand } from '../command.js';

const RECENT_MS = 24 * 3_600_000;

export const whoCommand = defineCommand({
  name: 'who',
  summary: "See who's working on what right now",
  description:
    'Lists teammates whose agents are active now (a session heartbeat in the last 30 minutes) and active file claims. ' +
    'Data is as fresh as your last sync; hooks sync in the background during sessions.',
  options: {
    recent: { type: 'boolean', short: 'r', description: 'Also include sessions active in the last 24h' },
  },

  async run({ out, services }, { options }) {
    const store = await services.store();
    const [{ threads }, claimSets] = await Promise.all([store.list(), store.listClaims()]);
    const now = new Date();

    const working = threads
      .map((t) => ({ thread: t, active: lastActiveAt(t), live: isLive(t, now) }))
      .filter((w) => w.active !== null && (w.live || (options.recent && now.getTime() - w.active < RECENT_MS)))
      .sort((a, b) => b.active! - a.active!);
    const claims = activeClaims(claimSets, now).sort((a, b) => a.file.localeCompare(b.file));

    out.json({
      ok: true,
      working: working.map((w) => ({
        person: w.thread.contributors.at(-1) ?? w.thread.author,
        live: w.live,
        lastActiveAt: new Date(w.active!).toISOString(),
        thread: { id: w.thread.id, title: w.thread.title, branch: w.thread.branch, files: w.thread.files },
      })),
      claims,
    });

    if (working.length === 0) out.print(options.recent ? 'Nobody has been active in the last 24h.' : 'Nobody is active right now. Try --recent.');
    else {
      out.table(
        working.map((w) => [
          (w.thread.contributors.at(-1) ?? w.thread.author).name,
          w.live ? out.style('active', 'green') : out.style('idle', 'dim'),
          ago(new Date(w.active!).toISOString(), now),
          w.thread.branch ?? '-',
          w.thread.files.length ? `${w.thread.files.slice(-2).join(', ')}${w.thread.files.length > 2 ? ` (+${w.thread.files.length - 2})` : ''}` : '-',
          `${w.thread.title} ${out.style(w.thread.id, 'dim')}`,
        ]),
        ['WHO', 'STATE', 'LAST ACTIVE', 'BRANCH', 'RECENT FILES', 'THREAD'],
      );
    }

    if (claims.length) {
      out.print();
      out.print(out.style('Claims', 'bold'));
      for (const c of claims) {
        out.print(`  ${c.file} — ${c.owner.name}${c.reason ? ` (${c.reason})` : ''}, until ${new Date(c.expiresAt).toLocaleTimeString()}`);
      }
    }
  },
});
