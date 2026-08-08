# STICKY NOTE — PRD V3.0
# Human-to-Human · Cloudflare KV Cloud · MIT client + AGPL server source
# Claude Code + Copilot CLI + Codex · GitHub Action install
# Real-time handoff · No push required · Presence · Audit API + MCP

═══════════════════════════════════════════════════════════════

## 0. V2.5 BASELINE — WHAT EXISTS TODAY

Version: 2.5.3 (npm: sticky-note-cli)
License: MIT
Storage: git-tracked JSON + JSONL + per-user presence files
Tools: Claude Code (full hooks), Copilot CLI (full hooks), Codex (wrapper)

### Implemented features (V2.5.3, shipped)

Thread lifecycle: open → stale → closed → expired (tombstone gc)
Stuck threads: error hook marks threads stuck, inject-context boosts them
Per-user audit: .sticky-note/audit/<user>.jsonl (JSONL, one line per tool call)
Per-user presence: .sticky-note/presence/<user>.json (local, git-tracked)
Relevance scoring: file overlap (3), branch (2), recency (2), stuck (+2),
  prompt keywords (1), same dev (1), resume signal (+10)
Two-tier injection (V2.5):
  Eager — session start injects stuck + top-scored threads
  Lazy — pre-tool-use hook runs git blame → SHA → thread resolution
Attribution engine (V2.5): git blame → Git Notes → audit fallback → heuristic
Auto-checkpointing (V2.5): each prompt tagged in Git Notes with topic/session
Smart resume (V2.5): natural language search across narratives + files
Thread schema (V2.5): contributors[], resumed_by, resumed_at, resume_history[]
Copilot CLI support (V2.5): copilot-instructions.md + hooks.json + self-serve
Windows support (V2.5): PowerShell Codex wrapper, CRLF handling, path normalization

### Codebase structure

bin/cli.js              Single CLI entry point (init, update, status, threads,
                        resume, resume-thread, audit, who, switch, gc, reset,
                        get-line-attribution, checkpoint)
templates/hooks/        14 hook scripts (JS) — deployed to .claude/hooks/ on init
templates/              Config templates, instruction file templates
test/smoke.test.js      16 smoke tests
.github/workflows/      Tag-based npm publish workflow

### What V2.5 does NOT have

- No cloud backend — all data is git-tracked, requires push/pull
- No distributed presence — presence is local file, same machine only
- No real-time sync — teammates see nothing until git push
- No HTTP API — audit is grep on JSONL files
- No MCP server — MCP references in config but no server implementation
- No GitHub Action for org install — per-repo npx init only
- No Codex real-time injection — Codex wrapper captures post-session only
- No AI-generated handoff summaries — narrative is last assistant message
- No cross-tool session linking at runtime — resume is manual, between sessions

═══════════════════════════════════════════════════════════════

## 1. WHAT CHANGES FROM V2.5

| Capability         | V2.5 (today)                          | V3                                      |
|--------------------|---------------------------------------|-----------------------------------------|
| Storage            | .sticky-note/sticky-note.json (git)   | Cloudflare KV (or git-based fallback)    |
| Audit              | .sticky-note/audit/*.jsonl (git)      | Cloud append-only table + HTTP API       |
| Sync               | git push/pull                         | Real-time (no push required)             |
| Presence           | Local gitignored file, same machine   | Distributed heartbeat, all machines      |
| Codex              | Post-session wrapper capture          | Real-time context injection via cloud    |
| Org install        | Per-repo npx init                     | GitHub Action for zero-touch rollout     |
| Audit queries      | grep on JSONL files                   | HTTP API + MCP tool                      |
| Handoff summaries  | Last assistant message (300 chars)    | AI-generated structured summary (cloud)  |
| Cross-tool linking | Manual resume between sessions        | Real-time session linking via cloud      |

### What does NOT change

Thread schema: identical — same fields, same tombstone pattern, same UUIDs.
Hook interface: same 14 hook scripts, same lifecycle events.
CLI commands: all existing commands preserved, new commands added.
Relevance scoring: identical inject-context.js logic.
Expiry: same lazy tombstone sweep on session-end.
Attribution engine: same git blame → Git Notes → audit → heuristic pipeline.
Two-tier injection: same eager/lazy model, cloud replaces git-read for source.

V2 → V3 migration is a data lift, not a schema change.

### Script changes

Each hook script gains a cloud transport layer: if STICKY_URL is set,
HTTP calls replace local file reads/writes. V2 local file I/O is the
fallback when STICKY_URL is not configured.

Affected files (transport switch):
  templates/hooks/sticky-utils.js    — new: cloudRead(), cloudWrite() helpers
  templates/hooks/session-start.js   — read threads from cloud or local
  templates/hooks/session-end.js     — write thread to cloud or local
  templates/hooks/inject-context.js  — read threads from cloud or local
  templates/hooks/track-work.js      — write audit to cloud or local
  templates/hooks/on-error.js        — write stuck thread to cloud or local
  templates/hooks/on-stop.js         — write handoff to cloud or local

New files:
  sticky-server/                     — Cloudflare Worker + adapters (AGPL)
  bin/cli.js                         — new commands: deploy-backend, migrate, init --v3

Unchanged files (no cloud dependency):
  templates/hooks/pre-tool-use.js        — git blame is always local
  templates/hooks/sticky-attribution.js  — git blame is always local
  templates/hooks/sticky-git-notes.js    — Git Notes are always local
  templates/hooks/post-rewrite.js        — Git Notes are always local
  templates/hooks/parse-transcript.js    — transcript parsing is always local

### License change

Client layer (hooks, scripts, npx CLI, bin/): MIT — unchanged from V2.5
Cloud backend source (sticky-server/):        AGPL-3.0
No supported self-hosting path in V3. V4 managed service is the
zero-ops upgrade from BYOK.

═══════════════════════════════════════════════════════════════

## 2. WHY V3 EXISTS — THE GAPS V2.5 CANNOT CLOSE

### Gap 1 — Real-time handoff without a push

Teammate gets stuck at 2pm. You come online at 2:05pm.
In V2.5 you see nothing until they git push and you git pull.
In V3 the stuck thread hits the cloud store the moment their
session-end.js fires — no push, no pull, instant visibility.

Today's workaround: teammates manually push after each session.
This is fragile (forgotten pushes), slow (full git round-trip),
and impossible in environments where push requires CI gates.

### Gap 2 — Distributed presence

V2.5 presence is a local JSON file per user, tracked in git.
It tells you who was active at the time of your last pull,
not who is active right now. Two people on different machines
can edit the same file with no conflict warning.

V3 presence is a real distributed heartbeat — every developer
on the team, anywhere, every 5 minutes. Active session indicator
and conflict warnings now work for remote teams in real time.

### Gap 3 — Audit at scale

V2.5 audit is per-user JSONL files grepped locally.
Works well for small teams. A 20-developer repo with months
of history means grepping megabytes of JSONL across N files.
No indexing, no date range queries without parsing every line.

V3 moves audit to an append-only cloud table with indexed
queries by project, file, user, tool, and date range.

### Gap 4 — Codex real-time injection

V2.5 Codex support is a wrapper script that captures context
post-session. The Codex agent itself runs without any injected
thread context — it's blind to what teammates have done.

V3 cloud store enables the Codex wrapper to read thread context
before session start and have it available immediately.

### Gap 5 — Org-scale install

V2.5 requires `npx sticky-note-cli init` per repo. For a 50-repo
org, that's 50 manual setups and 50 PRs to merge hook files.

V3 GitHub Action installs Sticky Note on every repo on first push.
Org secrets provide STICKY_URL and STICKY_API_KEY. Zero-touch.

### Note on Copilot CLI /share

Developers already run /share gist and paste summaries into new
sessions. V3 automates this — same workflow, structured context
instead of a gist document, available instantly from cloud.

═══════════════════════════════════════════════════════════════

## 3. DATASTORE — CLOUDFLARE KV (OR GIT-BASED FALLBACK)

Two modes. The backend is determined by whether STICKY_URL is set.

### Mode 1 — Cloud (Cloudflare KV)

When `STICKY_URL` is configured in `.env.sticky` (gitignored):

```
STICKY_URL=https://sticky.team.workers.dev
STICKY_API_KEY=sticky_live_xxxxx
```

All thread, audit, and presence data flows through a Cloudflare Worker
backed by KV. Real-time sync, distributed presence, HTTP audit queries.

Why Cloudflare KV:
- Free tier: 100k reads/day, 1k writes/day — covers most teams at $0
- Zero SQL schema to manage — key-value fits our thread/audit model
- Single `wrangler deploy` provisions everything
- Agent-friendly: 3 commands to go from zero to running backend

### Mode 2 — Git-based (V2.5 default)

When `STICKY_URL` is NOT set (or `.env.sticky` doesn't exist):

Everything works exactly like V2.5 today. Local file I/O, git-tracked.
No network calls, no cloud dependency, no configuration needed.

This is the default. Installing `sticky-note-cli@3.x` without
configuring a backend gives you the same git-based experience as V2.5.

### Deploy command

Provisions Cloudflare KV namespace + deploys Worker + writes .env.sticky:

```bash
npx sticky-note-cli deploy-backend
```

Requires: Cloudflare account + `wrangler` CLI (prompted to install if missing).

### Future backends (V3.1+)

The adapter interface is designed for extensibility. Supabase (PostgreSQL)
and Cloudflare D1 are natural V3.1 additions if teams need SQL audit
queries. V3 ships with Cloudflare KV only.

═══════════════════════════════════════════════════════════════

## 4. WHAT STAYS THE SAME FROM V2.5

Thread schema: identical. Same fields, same tombstone pattern.
  open, stuck, stale, closed, expired — same lifecycle.
  contributors[], resumed_by, resumed_at, resume_history[] — same V2.5 additions.

Audit record format: same shape — now written to cloud table
  instead of per-user JSONL, but same fields (timestamp, user,
  session, tool, file, action).

Hook lifecycle: same 6 events — session-start, inject-context,
  pre-tool-use, track-work, on-error/on-stop, session-end.

Relevance scoring: identical weights and formula from inject-context.js.

Attribution: same git blame → Git Notes → audit → heuristic pipeline.
  Attribution is always local (git blame runs on the local repo).
  Git Notes still stored in refs/notes/sticky-note.

Expiry: same lazy tombstone sweep on session-end.

CLI UX: all existing commands work identically.
  `npx sticky-note-cli init` still works for V2-only (local) mode.
  `npx sticky-note-cli update` still refreshes hook scripts.

Two-file mental model maps directly:
  sticky-note.json        → threads table in cloud store
  audit/<user>.jsonl      → audit table in cloud store
  presence/<user>.json    → presence table in cloud store

V2 → V3 migration reads all three local sources and writes to cloud.

═══════════════════════════════════════════════════════════════

## 5. NEW IN V3 — DISTRIBUTED PRESENCE

Real heartbeat, all developers, all machines.

### Write path

track-work.js POSTs to /presence every 5 minutes (when STICKY_URL set):

```json
{ "user": "alice", "project": "my-app", "active_files": ["src/auth.ts"], "last_active": "2026-03-11T20:30:00Z" }
```

session-end.js DELETEs the presence record on session close.

### Read path

session-start.js reads /presence and injects:

```
"Alice is actively working on auth/refresh.ts (8 min ago)"
"Bob ended his session 3hrs ago. Thread status: stuck."
```

### Conflict warning

At next UserPromptSubmit, if an active session is writing to files
you just opened:

```
[CONFLICT] Alice is actively editing auth/refresh.ts.
Coordinate before making changes.
```

### Configuration

Presence TTL: 15 minutes. Stale records auto-expire.
V2.5 fallback: when STICKY_URL is not set, presence still writes to
local .sticky-note/presence/<user>.json (same as today).

═══════════════════════════════════════════════════════════════

## 6. NEW IN V3 — AUDIT HTTP API

Same record format as V2.5 per-user JSONL, now queryable via HTTP.

### HTTP endpoints

```
GET /audit?project=X
GET /audit?project=X&file=src/auth/refresh.ts
GET /audit?project=X&user=alice&since=2026-03-01
GET /audit?project=X&tool=claude-code
```

### MCP tool (mid-session)

```
get_audit_trail(file?, user?, since?, tool?)
```

### CLI (unchanged interface, cloud backend)

```bash
npx sticky-note-cli audit --file src/auth.ts
npx sticky-note-cli audit --user alice --since 2026-03-01
```

When STICKY_URL is set, the CLI hits the cloud API instead of
grepping local JSONL files. Same flags, same output format.

No dashboard in V3. Programmatic access only. Dashboard is V4.

═══════════════════════════════════════════════════════════════

## 7. NEW IN V3 — GITHUB ACTION AUTO-INSTALL

File: .github/workflows/sticky-note-install.yml
Trigger: push to main + workflow_dispatch

### Steps

1. Check if `.claude/hooks/session-start.js` exists (hooks already installed)
2. If not: `npx sticky-note-cli@latest init --ci --no-prompts`
3. If yes: `npx sticky-note-cli@latest update --ci`
4. Commit: `"chore: install sticky note [sticky-note] [skip ci]"`

### Org configuration

Org secrets (written to .env.sticky by the action):
- `STICKY_URL` — cloud backend URL
- `STICKY_API_KEY` — API key for cloud backend

Org variables (passed to init):
- `STICKY_MCP_SERVERS` — shared MCP server config
- `STICKY_CONVENTIONS` — team coding conventions
- `STICKY_STALE_DAYS` — thread expiry days

### init --ci flag

New flag for non-interactive init. Skips all prompts, uses
env vars and org variables for configuration. Exits non-zero
if git repo not found or Node.js < 16.

═══════════════════════════════════════════════════════════════

## 8. MCP SERVER

8 tools, same interface as V2.5 config references but now backed
by real cloud endpoints.

```
get_open_threads()           → GET /threads?status=open
get_stuck_threads()          → GET /threads?status=stuck
search_threads(query)        → GET /threads?q=<query>
get_session_context(id)      → GET /threads/<id>
write_thread(thread)         → PUT /threads/<id>
get_team_config()            → GET /config
get_presence()               → GET /presence
get_audit_trail(filters)     → GET /audit?<filters>
```

MCP server is a thin HTTP client wrapper. It reads STICKY_URL
and STICKY_API_KEY from environment, translates MCP tool calls
to REST requests, and returns JSON responses.

Ships as: `npx sticky-note-cli mcp-server` (stdio transport).

═══════════════════════════════════════════════════════════════

## 9. npx COMMANDS — V3 ADDITIONS

### New commands

```bash
npx sticky-note-cli init --v3          # V3 setup: Cloudflare KV backend prompts + cloud config
npx sticky-note-cli deploy-backend     # Provision Cloudflare KV + deploy Worker
npx sticky-note-cli migrate --to cloud # V2 local → V3 cloud data lift
npx sticky-note-cli status             # Updated: backend reachability + MCP health
npx sticky-note-cli mcp-server         # Start MCP server (stdio transport)
```

### Existing commands (unchanged interface)

```bash
npx sticky-note-cli init               # Still works for V2-only (local) setup
npx sticky-note-cli update             # Still refreshes hook scripts
npx sticky-note-cli threads            # Cloud-backed when STICKY_URL set
npx sticky-note-cli resume <id>        # Cloud-backed when STICKY_URL set
npx sticky-note-cli resume-thread      # Cloud-backed when STICKY_URL set
npx sticky-note-cli audit              # Cloud-backed when STICKY_URL set
npx sticky-note-cli who                # Cloud-backed when STICKY_URL set
npx sticky-note-cli switch <branch>    # Unchanged (local git operation)
npx sticky-note-cli gc                 # Cloud-backed when STICKY_URL set
npx sticky-note-cli reset              # Cloud-backed when STICKY_URL set
npx sticky-note-cli get-line-attribution  # Unchanged (always local git blame)
npx sticky-note-cli checkpoint         # Unchanged (always local Git Notes)
```

═══════════════════════════════════════════════════════════════

## 10. CLOUD BACKEND — ENDPOINTS

### sticky-server/ (Cloudflare Worker, AGPL)

```
POST   /threads            Create thread
GET    /threads             List threads (?status=, ?q=, ?project=)
GET    /threads/:id         Get single thread
PUT    /threads/:id         Update thread
DELETE /threads/:id         Delete thread (tombstone)

GET    /audit               Query audit (?project=, ?file=, ?user=, ?since=, ?tool=)
POST   /audit               Append audit record

GET    /presence            List active developers (?project=)
POST   /presence            Heartbeat (upsert)
DELETE /presence/:user      Clear presence on session end

GET    /config              Team config
PUT    /config              Update team config
```

### Adapter interface

```typescript
interface StickyAdapter {
  getThreads(project: string, filters?: ThreadFilters): Promise<Thread[]>
  getThread(id: string): Promise<Thread | null>
  putThread(thread: Thread): Promise<void>
  deleteThread(id: string): Promise<void>
  appendAudit(record: AuditRecord): Promise<void>
  queryAudit(filters: AuditFilters): Promise<AuditRecord[]>
}

interface PresenceAdapter {
  getPresence(project: string): Promise<PresenceRecord[]>
  upsertPresence(record: PresenceRecord): Promise<void>
  deletePresence(user: string, project: string): Promise<void>
}
```

V3 ships one implementation:
- `adapters/cf-kv.js` — Cloudflare KV (threads, audit, and presence)

The adapter interface allows future backends (Supabase, D1) in V3.1+.

═══════════════════════════════════════════════════════════════

## 11. IMPLEMENTATION PHASES

### Phase 1 — Cloud backend (Cloudflare KV)
sticky-server/worker.js, wrangler.toml, adapter interface,
CF KV adapter, basic auth (API key).
6 thread endpoints + /audit + /presence.

### Phase 2 — Script migration
Add cloudRead/cloudWrite to sticky-utils.js.
Update 7 hook scripts with HTTP transport + V2.5 git fallback.
All hooks check STICKY_URL: if set → cloud, else → local files.

### Phase 3 — Distributed presence
Real heartbeat in track-work.js, presence delete in session-end.js,
conflict warning in inject-context.js. All via Cloudflare KV.

### Phase 4 — Codex real-time injection
Update sticky-codex.sh/ps1 to read from cloud before session.
POST session context to cloud on Codex session end.

### Phase 5 — GitHub Action + CI
.github/workflows/sticky-note-install.yml template.
init --ci flag, org secrets/vars support.

### Phase 6 — MCP server + migration
npx sticky-note-cli mcp-server (stdio).
npx sticky-note-cli migrate --to cloud.

### Phase 7 — Hardening
AGPL license on sticky-server/.
V2 → V3 migration guide.
Org rollout documentation.
Edge cases: offline fallback, retry logic, rate limiting.

═══════════════════════════════════════════════════════════════

## 12. DELIVERABLES CHECKLIST

### Cloud backend (sticky-server/)
[ ] sticky-server/worker.js — Cloudflare Worker entry point
[ ] sticky-server/wrangler.toml — Worker configuration
[ ] sticky-server/adapters/cf-kv.js — Cloudflare KV adapter
[ ] sticky-server/LICENSE — AGPL-3.0

### Hook script updates (templates/hooks/)
[ ] sticky-utils.js — cloudRead(), cloudWrite(), cloudDelete() helpers
[ ] session-start.js — cloud thread + presence read
[ ] session-end.js — cloud thread write + presence delete
[ ] inject-context.js — cloud thread read + conflict warning
[ ] track-work.js — cloud audit write + presence heartbeat
[ ] on-error.js — cloud stuck thread write
[ ] on-stop.js — cloud handoff summary write

### CLI updates (bin/cli.js)
[ ] init --v3 — Cloudflare KV backend setup flow
[ ] init --ci --no-prompts — non-interactive for GitHub Action
[ ] deploy-backend — provision Cloudflare KV + deploy Worker + write .env.sticky
[ ] migrate --to cloud — V2 local → V3 cloud data lift
[ ] mcp-server — MCP server (stdio transport)
[ ] status — updated with backend reachability check

### GitHub Action
[ ] templates/sticky-note-install.yml — org auto-install workflow

### MCP server
[ ] 8 tools: get_open_threads, get_stuck_threads, search_threads,
    get_session_context, write_thread, get_team_config, get_presence,
    get_audit_trail

### Documentation
[ ] docs/prd-v3.md — this document
[ ] docs/v3-migration-guide.md — V2 → V3 migration guide
[ ] docs/org-rollout.md — GitHub Action org rollout guide
[ ] README.md — updated with V3 section
[ ] CHANGELOG.md — V3.0.0 entry

═══════════════════════════════════════════════════════════════

## 13. MIGRATION PATH

### npx sticky-note-cli migrate --to cloud

Reads:
- .sticky-note/sticky-note.json → all threads (including expired tombstones)
- .sticky-note/audit/*.jsonl → all audit records across all users
- .sticky-note/presence/*.json → current presence records

Writes to STICKY_URL:
- POST /threads for each thread
- POST /audit for each audit record
- POST /presence for each presence record

Reports: threads migrated, audit records migrated, errors.

### Backward compatibility

When STICKY_URL is NOT set:
- All hooks behave exactly as V2.5 — local file reads/writes
- No cloud dependency, no network calls
- Same .sticky-note/ file structure

When STICKY_URL IS set:
- Hooks use cloud backend for threads, audit, presence
- Local .sticky-note/ files still written as cache/fallback
- Git blame attribution always local (no change)
- Git Notes always local (no change)

### Rollback

Delete .env.sticky (removes STICKY_URL).
Hooks automatically fall back to local file I/O.
Local cache files are still current.

═══════════════════════════════════════════════════════════════

## 14. DESIGN DECISIONS (RESOLVED)

1. **AI-generated handoff summaries**: Deferred to V3.1.
   V3 keeps V2.5 transcript parsing in on-stop.js. No LLM dependency.

2. **Codex real-time injection**: Needs investigation.
   Unclear whether Codex sandbox allows outbound HTTP. V3 implements
   the cloud read/write path in the Codex wrapper, but real-time
   injection is best-effort until Codex sandboxing is confirmed.
   Codex post-session capture works regardless (runs outside sandbox).

3. **Conflict warning timing**: Prompt + pre-write.
   Presence check runs in inject-context.js (every prompt) AND
   pre-tool-use.js (before file writes). Cost is negligible on
   Cloudflare KV free tier (~3k reads/day for a 20-dev team).

4. **Offline fallback**: Silent fallback + one-time warning.
   When STICKY_URL is set but unreachable, hooks fall back to local
   file I/O and print `[STICKY-NOTE] Cloud unreachable, using local
   fallback` once per session. No retries, no queuing. Local cache
   stays current for manual migration later.

5. **Multi-project routing**: One Worker, auto-detected project namespacing.
   Single Cloudflare Worker deployment serves all repos in an org.
   KV keys are namespaced by project: `{project}:thread:{uuid}`,
   `{project}:audit:{timestamp}`, `{project}:presence:{user}`.

   Project name is auto-detected from git remote origin:
   `git@github.com:AcmeCorp/my-app.git` → `AcmeCorp/my-app`
   Override: set `"project"` in `.sticky-note/sticky-note-config.json`
   for repos without a remote or non-standard remote URLs.

   Users never see or manage KV keys. The Worker prefixes all
   operations automatically based on the project header sent by hooks.

   `npx sticky-note-cli deploy-backend` deploys once per org.
   `npx sticky-note-cli init --v3` auto-writes `.env.sticky` per repo.
