# Changelog

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
