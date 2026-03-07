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

### Status icons

- 🔴 `stuck` — hit a blocker, includes failed approaches
- 🟢 `open` — work in progress (or resumed)
- 🟡 `stale` — no activity for 14+ days
- ⚪ `closed` — completed
- ⚫ `expired` — tombstoned, minimal data remains

### Resuming threads

Users can resume a previous thread with `npx sticky-note resume <id>`.
This writes a `.sticky-resume` signal file that hooks detect automatically.
The resumed thread reopens as `open`, and its full context is injected at
session start.

**When a session starts with a resumed thread**, always present a brief recap
to the user: what was worked on, what was accomplished, any problems hit,
and what's left to do. Then ask how they'd like to proceed.

### Resuming threads mid-session

When a user asks to resume a thread **during an active session**, do NOT
tell them to exit. Instead, run the resume command directly:

```bash
npx sticky-note resume <thread-id>
```

The next prompt will automatically pick up the resumed thread's context
(the inject-context hook detects the signal file and reopens the thread).

### Example queries the user might ask

- "Show me all threads" → read sticky-note.json, list all threads
- "What's stuck?" → filter threads where status = "stuck"
- "What did Alice work on?" → filter threads where user = "alice"
- "Show threads for this branch" → filter by current branch name
- "What files were touched?" → aggregate files_touched across threads
- "Resume thread X" → run `npx sticky-note resume <id>` directly (works mid-session)

### Displaying threads

When listing threads, **always show the `tool` field** so users can see
which AI assistant created each thread. Use these labels:

- 🤖 `claude-code` — created by Claude Code
- 🛠️ `copilot-cli` — created by GitHub Copilot CLI
- ❓ `unknown` — tool not detected

Example format:
```
⚪ closed · dbandaru · 🛠️ copilot-cli · feature/v2
  Last note: updated auth middleware
  Files: src/auth.js, src/middleware.js
```

### Audit trail

For detailed session events, read `.sticky-note/sticky-note-audit.jsonl`
(one JSON object per line, local only).

## Team conventions

Check `.sticky-note/sticky-note-config.json` for team conventions,
MCP servers, and configuration.
