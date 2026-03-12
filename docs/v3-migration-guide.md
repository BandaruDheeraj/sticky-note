# V2 → V3 Migration Guide

Sticky Note V3 adds an optional cloud backend (Cloudflare KV) for real-time
handoff, distributed presence, and HTTP audit queries. V2 local-only mode
continues to work — V3 is a superset, not a replacement.

---

## Prerequisites

- Node.js 16+
- Existing V2.5 installation (`npx sticky-note-cli init` already run)
- A Cloudflare account (free tier works) — only if you want cloud features

---

## Step 1: Update Sticky Note

```bash
npm install -g sticky-note-cli@3
# or
npx sticky-note-cli@3 update
```

This refreshes all hook scripts to V3 with the cloud transport layer.
Local-only mode is unchanged — hooks still read/write `.sticky-note/` files
when `STICKY_URL` is not set.

---

## Step 2: Deploy the Cloud Backend (Optional)

Skip this step if you want to stay in local-only mode.

```bash
npx sticky-note-cli deploy-backend
```

This command:
1. Checks for `wrangler` CLI (prompts to install if missing)
2. Creates a Cloudflare KV namespace
3. Deploys the Sticky Note Worker
4. Writes `.env.sticky` with your `STICKY_URL` and `STICKY_API_KEY`

The `.env.sticky` file is gitignored — each developer gets their own copy
with the same team URL and API key.

---

## Step 3: Migrate Existing Data

```bash
npx sticky-note-cli migrate --to cloud
```

This reads your local V2 data and uploads it:

| Local source | Cloud destination |
|---|---|
| `.sticky-note/sticky-note.json` | `PUT /threads/:id` for each thread |
| `.sticky-note/audit/*.jsonl` | `POST /audit` for each record |
| `.sticky-note/presence/*.json` | `POST /presence` for each user |

The command reports counts: threads migrated, audit records, and any errors.

Local files are **not deleted** — they remain as a cache/fallback.

---

## Step 4: Share with Your Team

Distribute the cloud credentials to teammates:

1. Share `STICKY_URL` and `STICKY_API_KEY` (e.g., via org secrets, 1Password, etc.)
2. Each teammate creates `.env.sticky` in their repo root:

```
STICKY_URL=https://sticky.your-team.workers.dev
STICKY_API_KEY=sticky_live_xxxxx
```

Or use the GitHub Action for zero-touch org rollout (see
[org-rollout.md](org-rollout.md)).

---

## What Changes After Migration

### With `STICKY_URL` set (cloud mode)

- Thread reads/writes go through the cloud backend
- Audit entries are written to the cloud table
- Presence heartbeats are distributed (all machines, real-time)
- Local `.sticky-note/` files are still written as cache
- Git blame attribution stays local (no change)
- Git Notes stay local (no change)

### Without `STICKY_URL` (local mode)

Everything works exactly like V2.5. No network calls, no cloud dependency.

---

## Rollback

To revert to local-only mode:

```bash
# Remove the cloud config
rm .env.sticky
```

Hooks detect the absence of `STICKY_URL` and fall back to local file I/O.
Your local `.sticky-note/` files are still current because they were written
as cache during cloud mode.

No data loss, no schema changes, instant rollback.

---

## Troubleshooting

### "Cloud unreachable, using local fallback"

This message appears once per session when `STICKY_URL` is set but the
backend is not reachable. Hooks silently fall back to local I/O. Check:

- Is the Worker deployed? Run `npx sticky-note-cli deploy-backend`
- Is the URL correct in `.env.sticky`?
- Is the API key valid?

### Migration shows 0 threads

Your `.sticky-note/sticky-note.json` might be empty or missing. Run
`npx sticky-note-cli status` to check the local data state before migrating.

### Duplicate threads after migration

The `migrate` command uses thread UUIDs as keys. Running it twice is safe —
existing threads are overwritten with the same data, not duplicated.
