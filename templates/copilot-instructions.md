<!-- sticky-note:start — DO NOT EDIT between markers; updated by `npx sticky-note update` -->
# Sticky Note — Copilot CLI Instructions

This repository uses **Sticky Note** for team handoff context.
All session threads are stored in `.sticky-note/sticky-note.json`.

## When asked about threads, sessions, or teammate activity

**Always read `.sticky-note/sticky-note.json` first** — do NOT use git log,
git history, your own session memory, or any other source.

### Thread statuses

- [STUCK] `stuck` — hit a blocker, includes failed approaches
- [OPEN] `open` — work in progress (or resumed)
- [STALE] `stale` — no activity for 14+ days
- [CLOSED] `closed` — completed
- [EXPIRED] `expired` — tombstoned, minimal data remains

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

The command outputs the thread's **full context** (narrative, files, failed
approaches, prompts). Read and present this context to the user immediately —
do NOT tell them to start a new session. The inject-context hook will also
pick up the resumed thread on subsequent prompts.

### Common queries

- "Show me all threads" → read sticky-note.json, list all threads with status icons
- "What's stuck?" → filter threads where status = "stuck"
- "What did [user] work on?" → filter threads by user field
- "Show threads for this branch" → filter by current git branch
- "What files were touched?" → aggregate files_touched across threads
- "Resume thread X" → run `npx sticky-note resume <id>` directly (works mid-session)

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
```

### Git commit rules for sticky-note files

**Always commit** (shared with the team):
- `.sticky-note/sticky-note.json` — the thread memory (this is the whole point)
- `.sticky-note/sticky-note-config.json` — team settings

**Never commit** (local-only, already in `.gitignore`):
- `.sticky-note/sticky-note-audit.jsonl` — local audit log
- `.sticky-note/.sticky-presence.json` — local presence
- `.sticky-note/.sticky-resume` — transient resume signal
- `.sticky-note/.sticky-session` — transient session ID
- `.sticky-note/.sticky-head` — transient HEAD snapshot

When a session ends or the user asks to commit, **always include
`sticky-note.json`** so teammates see updated thread state.

### Audit trail

For detailed session events, read `.sticky-note/sticky-note-audit.jsonl`
(one JSON object per line, local only).

### Team config

Check `.sticky-note/sticky-note-config.json` for team conventions and settings.
<!-- sticky-note:end -->
