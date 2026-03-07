# Sticky Note — Copilot CLI Instructions

This repository uses **Sticky Note** for team handoff context.
All session threads are stored in `.sticky-note/sticky-note.json`.

## When asked about threads, sessions, or teammate activity

**Always read `.sticky-note/sticky-note.json` first** — do NOT use git log,
git history, your own session memory, or any other source.

### Thread statuses

- 🔴 `stuck` — hit a blocker, includes failed approaches
- 🟢 `open` — work in progress
- 🟡 `stale` — no activity for 14+ days
- ⚪ `closed` — completed
- ⚫ `expired` — tombstoned, minimal data remains

### Common queries

- "Show me all threads" → read sticky-note.json, list all threads with status icons
- "What's stuck?" → filter threads where status = "stuck"
- "What did [user] work on?" → filter threads by user field
- "Show threads for this branch" → filter by current git branch
- "What files were touched?" → aggregate files_touched across threads

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

### Team config

Check `.sticky-note/sticky-note-config.json` for team conventions and settings.
