# Changelog

## V3.1.1

### Improved: Cloud Setup Built Into Init Wizard
- `npx sticky-note init` now asks "Set up Cloudflare cloud backend for
  real-time team sync? (y/N)" after team configuration questions.
- Answering **y** provisions the cloud backend inline — no need to know to
  run `deploy-backend` separately first.
- `--v3` flag pre-answers yes, keeping the existing shorthand working.
- `deploy-backend` remains as a standalone command for re-provisioning an
  existing install or setting up cloud without running `init`.
- Extracted shared `provisionCloudBackend()` helper — no duplicated deploy
  logic between the two code paths.

---

## V3.1.0

### New: Full Transcript Capture
- `session-end.js` now persists each session's complete verbatim transcript
  (Claude Code's native `transcript_path` JSONL), not just the narrative
  summary extracted from it.
- Stored one file per thread at `transcripts/<thread-id>.jsonl` in the
  `sticky-note/data` storage layer, keyed by thread ID rather than commit
  SHA — appended to across resumed sessions, so a thread accumulates its
  full history.
- `sticky-utils.js` — new `getTranscriptsDir()`, `getTranscriptPath(id)`.
- New config keys: `capture_transcripts` (default `true`) and
  `redact_transcripts` (default `true`).

### New: Secret Redaction
- `sticky-utils.js` — new `redactSecrets()` / `REDACTION_PATTERNS`. Scrubs
  AWS/GitHub/Slack tokens, PEM private key blocks, bearer tokens, JWTs, and
  labeled `key=value` pairs (api_key, token, password, etc.) before a
  transcript is written.
- Also applied to the pre-existing `narrative`, `last_note`, and `prompts`
  summary fields in `session-end.js` and `on-stop.js`, which are extracted
  from the same raw transcript and were previously stored unredacted.
- Best-effort pattern matching, not a guarantee — documented as such.

### New: CLI Command
- `npx sticky-note-cli transcript <thread-id>` — show a thread's captured
  transcript(s), formatted as readable turns by default, `--raw` for the
  untouched JSONL, `--list` to see which threads have one captured.

### New: MCP Tool
- `get_full_transcript(id)` — ninth MCP tool; returns the full verbatim
  transcript(s) captured for a thread.

### Fixed: MCP server storage path
- `bin/mcp-server.js` resolved thread data from `<project>/.sticky-note/`
  unconditionally, which is the pre-V3 storage location. Since V3's default
  storage moved to `<git-dir>/sticky-note/` (the `sticky-note/data` orphan
  branch's local working copy), the MCP server could read stale or empty
  data on any repo using V3's default storage. `stickyDir()` now resolves
  the git-dir path first and falls back to the legacy path only if the
  former has no data.

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
- `migrate` — migrate to git data branch (default) or `--to cloud` to lift V2
  local data to the cloud backend.
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

## V2.7.0

### New: Team Environment Sync ("Vibe Coding Container")
- **Auto-provisioning engine** in session-start hook: copies skills, agents,
  commands to tool-specific directories; writes secret-free MCP servers to
  `.mcp.json`; merges permissions into `.claude/settings.local.json`
- **Hash-based change detection**: provisioning only runs when environment
  directory contents change (SHA-256 hash stored in `.env-provision-hash`)
- **`.sticky-note/environment/` directory**: manifest.json for MCP servers
  and permissions; `skills/`, `agents/`, `commands/` for .md files
- **`npx sticky-note bootstrap`**: interactive secrets provisioning for MCP
  servers with `${ENV_VAR}` placeholders. Resolves via shell env → .env →
  interactive prompt. Generates `.env.example`.
- **`npx sticky-note env status`**: shows provisioned/missing/needs-secrets
  per MCP server, resource counts, env var resolution status
- **`npx sticky-note env add-server`**: interactive command to add MCP
  servers to the team environment manifest
- **Dual-target provisioning**: skills copied to both
  `.claude/plugins/sticky-note-team/` (Claude Code) and
  `.github/extensions/sticky-note-team/` (Copilot CLI)
- **Auto-generated plugin.json**: Claude Code plugin metadata created
  automatically from provisioned skills
- **Backward compatibility**: old `mcp_servers[]`/`skills[]` in
  `sticky-note-config.json` auto-migrated to new environment format
- **MCP `get_environment_status()` tool**: reads manifest and reports
  what's provisioned vs missing vs needs-secrets to the AI

## V2.6.16

### Fix: MCP server connection (npx command)
- `npx -y sticky-note-cli mcp-server` failed with "could not determine
  executable to run" because the package name doesn't match the bin entry.
  Fixed to `npx -y -p sticky-note-cli sticky-note mcp-server`.
- Updated `.mcp.json`, session-start hook auto-registration, README, and
  plan docs with the corrected command.

### New: Styled overlap banners
- AI-rendered banner uses `━` bar borders, structured layout with
  `🔴 STUCK` / `🟡 OPEN` status indicators, user, branch, files,
  narrative, and resume command.
- stderr banner uses ANSI colors: yellow borders, red/green status,
  cyan branch names, dim narrative, pipe (`┃`) left border.
- Consistent format across all channels: pre-tool-use deny,
  inject-context, session-start, and instruction templates.

### Fix: Copilot CLI not calling MCP tools
- `.github/copilot-instructions.md` was missing the MCP Server section
  entirely — the AI never knew the tools existed.
- Restructured instructions so MCP tools are the **first section** with
  mandatory language. Manual file reads demoted to fallback.
- Updated both the active copy and the template.

## V2.6.13

### Fix: Teammate hook sharing (zero-config onboarding)
- `init` and `update` now detect overly broad `.claude/` gitignore entries
  and replace them with targeted `.claude/settings.local.json` ignore.
- `init` runs `git add --force .claude/hooks/ .claude/settings.json` so
  hook scripts are committed even if previously ignored.
- `update` does the same gitignore cleanup and force-add.
- Teammates now get working hooks on `git pull` — no `init` required.

## V2.6.0–2.6.12 (main)

### New: Overlap Detection
- `npx sticky-note overlap` detects file overlaps with other users'
  open/stuck threads.
- `npx sticky-note claim` declares file ownership (`--list`, `--clear`).
- `session-start.js` warns about overlaps at session start.
- Overlap warnings injected via three channels: `additionalContext`,
  stderr banner, and `preToolUse` deny (Copilot CLI only).

### New: preToolUse Deny as User-Visible Message Channel
- Copilot CLI's `additionalContext` is absorbed silently by the model.
  The only reliable way to surface urgent messages to users is via
  `preToolUse` deny with `permissionDecisionReason`.
- Deny fires once per session, keyed by `COPILOT_LOADER_PID` to
  isolate concurrent sessions (stored in `.overlap-warned` JSON).
- Twelve iterations (v2.6.1–v2.6.12) to discover and stabilize this
  pattern.

### New: Auto-Close Inactive Copilot CLI Threads
- Copilot CLI has no session-end signal, so threads stay open
  indefinitely. `session-start.js` now auto-closes `copilot-cli`
  threads after configurable inactivity (default 24h).
- New config: `copilot_cli_auto_close_hours` in
  `sticky-note-config.json`.

### Fixed
- Ghost injection: `session-start.js` was marking threads injected in
  Copilot CLI even though `sessionStart` output was dropped. Now skips
  `markThreadInjected` for Copilot CLI so `inject-context.js` can
  deliver them.
- Cross-session injection poisoning: `.sticky-injected` dedup now
  checks `session_id` before skipping, preventing one session's
  injections from suppressing another's.
- Concurrent session isolation: overlap dedup keyed by PID instead of
  shared session ID.

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
