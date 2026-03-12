# Changelog

## V3.0.0 (feature/v3)

### New: Cloud Backend (Cloudflare KV)
- **`sticky-server/`** — Cloudflare Worker with KV adapter (AGPL-3.0).
  REST API: threads CRUD, append-only audit, distributed presence, team config.
- **Adapter interface** for future backends (Supabase, D1).
- **Auto-detected project namespacing** — one Worker deployment serves all repos
  in an org. KV keys namespaced by git remote origin.
- **API key authentication** via `X-Sticky-API-Key` header.

### New: Cloud Transport in All Hooks
- All 7 hook scripts gain a cloud transport layer. When `STICKY_URL` is set in
  `.env.sticky`, hooks read/write through the cloud backend instead of local
  files. V2.5 local file I/O is the automatic fallback.
- `sticky-utils.js` — `cloudReadThreads()`, `cloudWriteThread()`,
  `cloudAppendAudit()`, `cloudReadPresence()`, `cloudWritePresence()`, and more.
- Offline fallback: one-time `[STICKY-NOTE] Cloud unreachable` warning, then
  silent local I/O for the rest of the session.

### New: Distributed Presence
- Real-time heartbeat via `POST /presence` from `track-work.js`.
- `session-end.js` clears presence on session close.
- `inject-context.js` shows who's active across all machines.
- Conflict warning when two developers edit the same file simultaneously.

### New: MCP Server
- `npx sticky-note-cli mcp-server` — stdio transport MCP server with 8 tools:
  `get_open_threads`, `get_stuck_threads`, `search_threads`,
  `get_session_context`, `write_thread`, `get_team_config`, `get_presence`,
  `get_audit_trail`.

### New: GitHub Action Auto-Install
- `templates/sticky-note-install.yml` — org-wide workflow that auto-installs
  hooks on every repo. Reads org secrets (`STICKY_URL`, `STICKY_API_KEY`) and
  org variables (`STICKY_STALE_DAYS`, `STICKY_CONVENTIONS`, `STICKY_MCP_SERVERS`).
- `init --ci --no-prompts` flag for non-interactive setup.

### New: CLI Commands
- `deploy-backend` — provision Cloudflare KV namespace, deploy Worker, write
  `.env.sticky`.
- `migrate --to cloud` — lift all V2 local data (threads, audit, presence) to
  the cloud backend.
- `mcp-server` — start MCP server over stdio.
- `init --v3` — V3 setup flow with cloud backend configuration prompts.
- `status` — now includes cloud backend reachability check.

### New: Codex Cloud Injection
- `sticky-codex.sh` and `sticky-codex.ps1` updated to read thread context
  from cloud before session start.

### Changed
- `on-stop.js` now extracts narrative, files_touched, work_type, tool_calls,
  and prompts from the audit trail and git diff. Previously created bare
  threads when `session-end.js` didn't fire (common on Windows).

### Documentation
- `docs/prd-v3.md` — full product requirements document.
- `docs/v3-migration-guide.md` — V2 → V3 migration steps.
- `docs/org-rollout.md` — GitHub Action org rollout guide.
- `README.md` — updated with V3 features and commands.

### License
- Client (hooks, CLI, templates): MIT (unchanged).
- Cloud backend (`sticky-server/`): AGPL-3.0.

---

## V2.5.0 (feature/v2.5)

### New: Built-in Attribution Engine
- **Line-level attribution** via `git blame` → Git Notes → thread resolution.
  Three-tier SHA lookup: Git Notes first, audit JSONL fallback, then
  file+date heuristic. Attribution survives rebase and amend via
  `post-rewrite` git hook.
- New hook: `sticky-attribution.js` (attribution linking)
- New hook: `sticky-git-notes.js` (Git Notes read/write)
- New hook: `post-rewrite.js` (copies notes across rewrites)
- New CLI command: `get-line-attribution --file <path> [--lines start:end]`

### New: Two-Tier Context Injection
- **Eager** (session start): unchanged from V2 — scores threads by file
  overlap, branch, recency, user, and stuck status. Injects top threads
  within token budget.
- **Lazy** (file touch): new `pre-tool-use.js` hook fires when you first
  read or edit a file. Runs `git blame`, resolves SHAs to threads, injects
  that file's thread context with exact line ranges. Only injects threads
  not already covered by eager injection.

### New: Auto-Checkpointing
- Each prompt is tagged in Git Notes with the topic, user, timestamp, and
  session ID. Enables precise "what were you working on when you edited
  this line" attribution instead of just "you were in a session."

### New: Smart Thread Resume
- New CLI command: `resume-thread` with natural language search.
  `--query "auth refresh"`, `--user alice`, `--file src/auth.ts`, or
  positional: `resume-thread "pick up where Alice left off"`.
- Searches thread narratives, failed approaches, handoff summaries, and
  file attribution. Returns best match + alternatives.
- Resumed threads track full history: `contributors[]`, `resumed_by`,
  `resumed_at`, `resume_history[]`.

### New: Copilot CLI Support
- `.github/copilot-instructions.md` template with self-serve context
  injection instructions (Copilot CLI has no lifecycle hooks).
- `.github/hooks/hooks.json` for Copilot CLI hook registration.
- All hooks detect Copilot CLI vs Claude Code and adapt output format.

### New: Windows Support
- `sticky-codex.ps1` PowerShell wrapper for Codex on Windows.
- Git hook shims generate `.bat` on Windows, `sh` on Unix.
- CRLF handling, Windows path normalization, shell safety fixes.

### New: Documentation
- `docs/smart-injection.md` — two-tier injection architecture
- `docs/thread-resume.md` — resume command reference
- `docs/how-git-blame-attribution-works.md` — attribution engine internals
- `docs/making-sticky-note-work-with-copilot-cli.md` — Copilot CLI guide
- `CLAUDE.md` and `templates/CLAUDE.md` — Claude Code project instructions

### New: Testing & Debugging
- 16 smoke tests (`test/smoke.test.js`) covering all core CLI commands.
- `STICKY_DEBUG=1` env var enables stderr logging for silent catch blocks.
- `debugLog()` in CLI replaces ~10 previously silent error handlers.

### Changed
- `inject-context.js` now writes auto-checkpoints via Git Notes on each
  prompt.
- `track-work.js` now writes Git Notes with line-range attribution for
  write tools (edit, create, write, multi_edit).
- `session-end.js` expanded with V2.5 thread schema fields (contributors,
  resume history).
- `CONTRIBUTING.md` corrected: all hooks are JavaScript (was incorrectly
  listing Python).
- `package.json` version bumped to 2.5.0, test script points to smoke
  tests.

### Removed
- `docs/v35-migration.md` (unreleased roadmap document).

---

## V2.0.0 (main)

### Core
- **Thread tracking**: open, stuck, stale, closed, expired statuses.
  Threads capture narrative, failed approaches, files touched, work type,
  prompts, and activities.
- **Git-backed storage**: `.sticky-note/sticky-note.json` with
  `merge=union` strategy for conflict-free multi-dev merges.
- **Per-user audit logs**: `.sticky-note/audit/<user>.jsonl` — one JSONL
  line per tool call with timestamp, user, session, tool, and file.
- **Per-user presence**: `.sticky-note/presence/<user>.json` — last seen
  timestamp and active files.
- **Configurable**: `.sticky-note/sticky-note-config.json` for stale days,
  token budget, MCP servers, skills, and conventions.

### Context Injection (Eager Only)
- `inject-context.js` fires at session start. Scores threads by:
  - File overlap with `git diff HEAD~5` (weight 3)
  - Branch match (weight 2)
  - Recency decay (weight 2 max)
  - Stuck status boost (+2)
  - Same developer bonus (1)
  - Prompt keyword matches (1 each)
- Injects top-scored threads within configurable token budget (default 1000).
- Shows scoring transparency block for debugging.

### Session Lifecycle Hooks
- `session-start.js` — ages stale threads, loads presence, resolves resume
  signals, writes session/head signal files.
- `track-work.js` — logs each tool call to per-user audit JSONL, updates
  presence heartbeat.
- `session-end.js` — parses transcript, creates/updates thread with
  narrative, failed approaches, work type classification, file list.
  Runs automatic tombstone sweep.
- `on-error.js` / `on-stop.js` — capture error/stop events, update audit.
- `parse-transcript.js` — extracts prompts, tool calls, and results from
  Claude Code / Copilot CLI transcripts.

### CLI Commands
- `init` — interactive setup: creates hooks, config, instruction files,
  git aliases, updates .gitignore/.gitattributes.
- `update` — refreshes hook scripts, preserves data.
- `status` — diagnostic report: thread counts, hook health, audit status.
- `threads` — lists open/stuck threads with metadata.
- `resume` — basic thread resume by ID (`--list`, `--clear`, `<id>`).
- `audit` — query audit trail with filters (`--file`, `--user`, `--since`,
  `--session`, `--limit`).
- `who` — show active team members and their files.
- `switch` — safe branch switching with auto-stash/pop of .sticky-note/.
- `gc` — tombstone sweep for expired threads.
- `reset` — wipe all threads (`--force`, `--keep-audit`).

### Integration
- Claude Code via `.claude/settings.json` hook registration.
- Codex via `sticky-codex.sh` wrapper script.
- MCP server auto-detection and provisioning from team config.
- Git alias `git sw` for safe branch switching.
