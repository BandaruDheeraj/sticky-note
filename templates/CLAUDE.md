<!-- sticky-note:start — DO NOT EDIT between markers; updated by `npx sticky-note update` -->
# Sticky Note — AI Assistant Instructions

This repository uses **Sticky Note** for team handoff context.
All session threads are stored in `.sticky-note/sticky-note.json`.

## When asked about threads, sessions, or teammate activity

**Always read `.sticky-note/sticky-note.json` first** — do NOT use git log,
git history, your own session memory, or any other source.

```bash
cat .sticky-note/sticky-note.json
```

### Thread fields

| Field              | Meaning                                    |
|--------------------|--------------------------------------------|
| `status`           | open, stuck, stale, closed, expired        |
| `user`             | Who created the thread                     |
| `tool`             | Which AI tool created it (claude-code, copilot-cli) |
| `branch`           | Git branch the work happened on            |
| `files_touched`    | Files modified during the session          |
| `narrative`        | Summary of what happened                   |
| `failed_approaches`| What was tried and didn't work             |
| `handoff_summary`  | Handoff notes for teammates                |
| `last_note`        | Most recent status note                    |
| `work_type`        | bug-fix, feature, debugging, refactor, etc.|
| `prompts`          | User prompts from the session (for cross-tool resume) |
| `related_session_ids` | Session IDs that resumed this thread    |
| `contributors`     | All users who worked on this thread (V2.5) |
| `resumed_by`       | Most recent user to resume this thread (V2.5) |
| `resumed_at`       | ISO timestamp of most recent resume (V2.5) |
| `resume_history`   | Full resume chain: user, timestamp, session (V2.5) |

### Status icons

- [STUCK] `stuck` — hit a blocker, includes failed approaches
- [OPEN] `open` — work in progress (or resumed)
- [STALE] `stale` — no activity for 14+ days
- [CLOSED] `closed` — completed
- [EXPIRED] `expired` — tombstoned, minimal data remains

### Smart injection (V2.5)

Context injection uses a **two-tier model** via Claude Code hooks:

- **Eager:** Stuck/relevant threads are injected at session start
  (via the `UserPromptSubmit` hook in `inject-context.js`)
- **Lazy:** Other threads are injected when you first touch a file they authored
  (via git blame attribution in the `PreToolUse` hook in `pre-tool-use.js`)

Each thread is injected **at most once per session** with line-range detail
showing exactly which lines each thread authored.

**Fallback (no hooks):** If hooks are not running (e.g., in Copilot CLI or
other tools), self-serve context injection instead:
1. At session start: read `.sticky-note/sticky-note.json` and check for
   stuck/open threads. Summarize any that exist.
2. Before editing a file for the first time: run
   `npx sticky-note get-line-attribution --file <path>` to check for prior
   thread context. Review attribution before making changes.

### Checkpointing (V2.5)

When switching between different work topics during a session, set a checkpoint
so edits are attributed to the correct topic:

```bash
npx sticky-note checkpoint "fixing auth token sliding window expiry"
```

**AI assistants should set checkpoints automatically** when the user shifts
to a different task mid-session. This enables precise attribution — each
edit is tagged with what you were working on, not just the session start prompt.

### Resuming threads

Users can resume a previous thread with `npx sticky-note resume <id>`.
This writes a `.sticky-resume` signal file that hooks detect automatically.
The resumed thread reopens as `open`, and its full context is injected at
session start.

**Smart resume (V2.5):** Users can also use natural language:
```bash
npx sticky-note resume-thread --query "auth refresh work" --user alice
npx sticky-note resume-thread "pick up where Alice left off"
```
This searches thread narratives and file attribution to find the best match.

**When a session starts with a resumed thread**, always present a brief recap
to the user: what was worked on, what was accomplished, any problems hit,
and what's left to do. Then ask how they'd like to proceed.

### Resuming threads mid-session

When a user asks to resume a thread **during an active session**, do NOT
tell them to exit. Instead, run the resume command directly:

```bash
npx sticky-note resume <thread-id>
```

The command outputs the thread's **full context** (narrative, files, failed
approaches, prompts). Read and present this context to the user immediately —
do NOT tell them to start a new session. The inject-context hook will also
pick up the resumed thread on subsequent prompts.

### File attribution (V2.5)

To see which threads are related to a specific file:
```bash
npx sticky-note get-line-attribution --file src/auth/refresh.ts
npx sticky-note get-line-attribution --file src/auth/refresh.ts --lines 200:260
```
Returns thread data with line-level attribution (which thread authored which lines).

### Example queries the user might ask

- "Show me all threads" → read sticky-note.json, list all threads
- "What's stuck?" → filter threads where status = "stuck"
- "What did Alice work on?" → filter threads where user = "alice"
- "Show threads for this branch" → filter by current branch name
- "What files were touched?" → aggregate files_touched across threads
- "Resume thread X" → run `npx sticky-note resume <id>` directly (works mid-session)
- "Pick up Alice's auth work" → run `npx sticky-note resume-thread --query "auth" --user alice`
- "Who contributed to this thread?" → check the `contributors` field

### Displaying threads

When listing threads, **always show the `user` (author) and `tool` fields**
so users can see who created each thread and which AI assistant was used.
Use these labels for the tool field:

- 🤖 `claude-code` — created by Claude Code
- 🛠️ `copilot-cli` — created by GitHub Copilot CLI
- ❓ `unknown` — tool not detected

Example format:
```
[CLOSED] closed · dbandaru · 🛠️ copilot-cli · feature/v2
  Last note: updated auth middleware
  Files: src/auth.js, src/middleware.js
  Contributors: dbandaru, alice
```

### Git commit rules for sticky-note files

**Always commit** (shared with the team):
- `.sticky-note/sticky-note.json` — the thread memory (this is the whole point)
- `.sticky-note/sticky-note-config.json` — team settings
- `.sticky-note/audit/*.jsonl` — per-user audit logs (team-wide action trail)
- `.sticky-note/presence/*.json` — per-user presence (who's active)

**Never commit** (transient, already in `.gitignore`):
- `.sticky-note/.sticky-resume` — transient resume signal
- `.sticky-note/.sticky-session` — transient session ID
- `.sticky-note/.sticky-head` — transient HEAD snapshot
- `.sticky-note/.sticky-injected` — transient injection tracking (V2.5)
- `.sticky-note/.sticky-active-resume` — transient active resume marker (V2.5)

When a session ends or the user asks to commit, **always include
`sticky-note.json` and the `audit/` and `presence/` directories**
so teammates see updated thread state and activity.

### Audit trail

Per-user audit logs are stored in `.sticky-note/audit/<username>.jsonl`
(one JSON object per line). Use `npx sticky-note audit` to query the
merged trail across all team members.

### Team presence

Per-user presence is stored in `.sticky-note/presence/<username>.json`.
Use `npx sticky-note who` to see who's active.

### Branch switching

**IMPORTANT:** Before switching git branches, always use:
```bash
npx sticky-note switch <branch>
```
This auto-stashes `.sticky-note/` data before switching and restores it
after. A raw `git checkout` or `git switch` will fail if sticky-note
files have uncommitted changes. The alias `git sw <branch>` also works
if set up by `npx sticky-note init`.

### ⚠️ Overlap warnings

Sticky-note detects when your files overlap with other teammates'
open or stuck threads. When the MCP server is available, use the
`check_overlaps` tool before editing files for the most reliable detection.

Hooks also inject overlap context through two fallback channels:

1. **Injected context** — `[STICKY-NOTE] ⚠️ OVERLAP DETECTED` appears in
   your hook output. This fires on every user prompt.
2. **Tool call deny** — Your first tool call may be denied with a reason
   containing overlap details (Copilot CLI only).

When you detect an overlap (via MCP tool or hook), surface it to the user:

```
⚠️ Overlap detected: [user] is working on [files] — [narrative summary]
   Status: [STUCK/OPEN] | Resume: npx sticky-note resume [id]
```

## Sticky Note MCP Server

You have access to a `sticky-note` MCP server. Use it:

1. **At session start**: Call `get_stuck_threads()` and `get_environment_status()`
   to check for team blockers and environment changes. Surface any warnings.

2. **Before editing files**: Call `check_overlaps(files)` with the files you
   plan to edit. If overlaps exist, warn the user before proceeding.

3. **For prior work context**: Call `get_thread_context_for_files(files)` or
   `search_threads(query)` to find relevant thread history.

4. **For audit history**: Call `get_audit_trail(file)` to understand who
   changed a file and when.

These tools are the primary way sticky-note communicates with you.
Hook-injected context supplements but does not replace MCP tool calls.

### `[STICKY-NOTE]` tags

All sticky-note hooks prefix their output with `[STICKY-NOTE]`. When you
see this tag in hook output, **briefly surface it to the user** so they
know what sticky-note did. Examples:

- `[STICKY-NOTE] ⚠️ Stuck Threads` → mention the stuck threads
- `[STICKY-NOTE] 3 relevant threads injected` → note context was loaded
- `[STICKY-NOTE] Tracked Edit on src/auth.ts (lines 40-55)` → confirm the edit was logged
- `[STICKY-NOTE] Session closed — thread created (5 files, 3 commits)` → confirm session saved
- `[STICKY-NOTE] Marked thread as STUCK` → acknowledge the error was recorded

Do NOT hide or suppress these tags. The user expects transparency about
when sticky-note is acting on their behalf.

## Team conventions

Check `.sticky-note/sticky-note-config.json` for team conventions,
MCP servers, and configuration.
<!-- sticky-note:end -->
