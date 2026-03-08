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

### Smart injection (V2.5)

Context injection uses a **two-tier model**:

- **Eager:** Stuck threads are injected at session start (before you type anything)
- **Lazy:** Other threads are injected when you first touch a file they authored
  (via built-in git blame attribution in the preToolUse hook)

Each thread is injected **at most once per session** with line-range detail
showing exactly which lines each thread authored.

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
```
Returns thread data with line-level attribution (which thread authored which lines).

### Common queries

- "Show me all threads" → read sticky-note.json, list all threads with status icons
- "What's stuck?" → filter threads where status = "stuck"
- "What did [user] work on?" → filter threads by user field
- "Show threads for this branch" → filter by current git branch
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

### Team config

Check `.sticky-note/sticky-note-config.json` for team conventions and settings.
<!-- sticky-note:end -->
