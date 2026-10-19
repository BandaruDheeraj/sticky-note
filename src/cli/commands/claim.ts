import { activeClaims, addClaims, ClaimSet, DEFAULT_CLAIM_HOURS, ownerKey, removeClaims } from '../../core/claim.js';
import { samePerson } from '../../core/thread.js';
import { repoRelative } from '../../hooks/edited-files.js';
import { defineCommand } from '../command.js';
import type { CommandContext } from '../context.js';
import { UsageError } from '../errors.js';
import { ago } from '../../surfacing/render.js';

async function myClaims({ services }: CommandContext) {
  const [store, me] = await Promise.all([services.store(), services.identity()]);
  const sets = await store.listClaims();
  const mine = sets.find((s) => samePerson(s.owner, me) || ownerKey(s.owner) === ownerKey(me));
  return { store, me, set: mine ?? ClaimSet.parse({ schemaVersion: 1, owner: me }) };
}

async function toRepoPaths(ctx: CommandContext, files: string[]): Promise<string[]> {
  const repoRoot = await ctx.services.repoRoot();
  return files.map((f) => {
    const rel = repoRelative(f, ctx.cwd, repoRoot);
    if (!rel) throw new UsageError(`${f} is outside the repository`);
    return rel;
  });
}

export const claimCommand = defineCommand({
  name: 'claim',
  summary: 'Tell teammates you are working on files',
  description:
    "Teammates' agents are warned before editing a claimed file, and `who` lists it. " +
    `Claims expire after ${DEFAULT_CLAIM_HOURS}h unless --hours is given; claiming again refreshes them.`,
  args: [{ name: 'files', description: 'Files to claim (paths relative to the current directory)', required: true, variadic: true }],
  options: {
    message: { type: 'string', short: 'm', valueName: '<reason>', description: 'Why, shown in warnings' },
    hours: { type: 'string', valueName: '<n>', description: `How long the claim lasts (default ${DEFAULT_CLAIM_HOURS})` },
  },
  examples: ['sticky-note claim src/auth.ts src/session.ts -m "migrating to JWT"', 'sticky-note claim db/schema.sql --hours 2'],

  async run(ctx, { rest, options }) {
    const hours = options.hours === undefined ? DEFAULT_CLAIM_HOURS : Number(options.hours);
    if (!(hours > 0)) throw new UsageError(`Invalid --hours "${options.hours}"`);
    const files = await toRepoPaths(ctx, rest);
    const { store, set } = await myClaims(ctx);
    const next = addClaims(set, files, { reason: options.message, hours });
    await store.saveClaims(next, `claims: ${next.owner.name} claimed ${files.join(', ')}`);

    ctx.out.json({ ok: true, claims: next.claims });
    ctx.out.success(`Claimed ${files.join(', ')} for ${hours}h${options.message ? `: ${options.message}` : ''}`);
    ctx.out.print(ctx.out.style('Teammates see it after their next sync (run `sticky-note sync` to share now).', 'dim'));
  },
});

export const unclaimCommand = defineCommand({
  name: 'unclaim',
  summary: 'Release file claims',
  args: [{ name: 'files', description: 'Files to release; omit with --all to release everything', variadic: true }],
  options: { all: { type: 'boolean', description: 'Release all your claims' } },

  async run(ctx, { rest, options }) {
    if (rest.length === 0 && !options.all) throw new UsageError('Name files to release, or pass --all');
    const files = await toRepoPaths(ctx, rest);
    const { store, set } = await myClaims(ctx);
    const next = removeClaims(set, files);
    const released = set.claims.length - next.claims.length;
    if (released > 0) await store.saveClaims(next, `claims: ${next.owner.name} released ${released}`);

    ctx.out.json({ ok: true, released, claims: next.claims });
    ctx.out.success(released ? `Released ${released} claim(s)` : 'Nothing to release');
  },
});

export const claimsCommand = defineCommand({
  name: 'claims',
  summary: 'List active file claims',

  async run({ out, services }) {
    const store = await services.store();
    const now = new Date();
    const claims = activeClaims(await store.listClaims(), now).sort((a, b) => a.file.localeCompare(b.file));
    out.json({ ok: true, claims });
    if (claims.length === 0) return out.print('No active claims.');
    out.table(
      claims.map((c) => [c.file, c.owner.name, ago(c.claimedAt, now), `expires ${new Date(c.expiresAt).toLocaleTimeString()}`, c.reason ?? '']),
      ['FILE', 'BY', 'CLAIMED', 'EXPIRES', 'REASON'],
    );
  },
});
