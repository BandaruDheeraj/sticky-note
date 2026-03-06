# 📌 Sticky Note v2

**Human-to-human handoff for AI coding assistants.**

Git-backed shared memory layer that captures session threads and surfaces
teammate context in Claude Code, Copilot CLI, and Codex — automatically.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/sticky-note.svg)](https://www.npmjs.com/package/sticky-note)

---

## The Problem

Every developer using AI coding assistants starts every session from zero.
The handoff between teammates happens in Slack and stand-ups — everywhere
except inside the AI tool where the work actually happened.

## The Solution

Sticky Note captures what happened in each AI session (files touched, status,
narrative, failed approaches) and surfaces it to teammates automatically on
their next session start — ranked by relevance. No dashboards. No extra tools.
Just shared files in your repo.

---

## What's New in V2

- **Two-file split** — Threads in `sticky-note.json`, audit trail in `sticky-note-audit.jsonl`
- **Relevance scoring** — Context injected based on file overlap, branch match, and recency
- **Richer threads** — Narrative summaries, failed approaches, work type, activities
- **Tombstone expiry** — Old threads are automatically cleaned up via `gc`
- **Presence tracking** — See who's currently active in the repo
- **Codex support** — Wrapper script for post-session capture
- **Separate config** — Team settings in `sticky-note-config.json`

---

## Quick Start

### 1. Install

```bash
npx sticky-note init
```

This runs an interactive setup that:
- ✅ Checks for git and Python 3.10+
- 📋 Asks for team config (MCP servers, conventions, stale days)
- 📁 Creates all hook scripts and config files

### 2. Commit

```bash
git add .claude .github .sticky-note .gitignore .gitattributes
git commit -m "feat: add sticky-note hooks"
```

### 3. Push & Pull

```bash
git push        # Share with team
git pull        # Teammates — no additional setup needed
```

### 4. Work

Open Claude Code or Copilot CLI and start working. Sticky Note runs
in the background via hooks — capturing threads and surfacing context.

**First thing to try** — ask your AI agent:

> "Show me the active sticky note threads"

---

## How It Works

### Session Start
Loads teammates' recent threads, scores them by relevance to your current
branch and files, and injects the most relevant context before your first message.

### During Work
Every tool use is logged in the JSONL audit trail. When you mention a file
a teammate was working on, their thread context is surfaced inline via
relevance scoring.

### Session End
Captures files touched, generates a narrative summary, detects failed
approaches, and writes a thread record teammates will see next time.

### Error Handling
Errors are captured as "stuck" threads that teammates see labeled **[STUCK]**
with failed approach details — so they know what was tried and what went wrong.

---

## What Gets Captured

| Data              | Captured | Example                              |
|-------------------|----------|--------------------------------------|
| Files touched     | ✅        | `src/auth.ts`, `lib/db.py`          |
| Thread status     | ✅        | open, stuck, stale, closed, expired  |
| Author            | ✅        | OS username                          |
| Timestamp         | ✅        | ISO 8601                             |
| Narrative         | ✅        | "Fixed auth token refresh flow"      |
| Failed approaches | ✅        | What was tried, errors, files        |
| Work type         | ✅        | bug-fix, feature, debugging, etc.    |
| Code content      | ❌        | Never captured                       |
| Conversation      | ❌        | Never captured                       |
| Credentials       | ❌        | Never captured                       |

---

## Thread Lifecycle

```
open → stale  (auto, after stale_days with no activity)
open → closed (on session end)
stuck → closed (on session end or manual)
closed → expired (auto, tombstoned by gc after stale_days)
```

Expired threads keep only their ID, status, user, and closed timestamp.

---

## Relevance Scoring

When context is injected, threads are ranked by:

| Signal          | Weight | Description                           |
|-----------------|--------|---------------------------------------|
| File overlap    | 3      | Shared files with current session     |
| Branch match    | 2      | Same git branch                       |
| Recency         | 2      | Decays 0.2/day from last activity     |
| Stuck status    | +2     | Boost for stuck threads               |
| Prompt keywords | 1      | File names mentioned in your prompt   |
| Same developer  | 1      | Your own previous threads             |

Top thread gets full detail; threads 2–5 get one-liner summaries.

---

## File Structure

```
.claude/
├── settings.json             # Claude Code hook config
└── hooks/
    ├── sticky_utils.py       # Shared utilities
    ├── session-start.py      # Load & inject teammate context
    ├── session-end.py        # Capture session thread
    ├── inject-context.py     # Per-prompt relevance scoring
    ├── track-work.py         # JSONL audit + presence heartbeat
    ├── parse-transcript.py   # Narrative + failed approach extraction
    ├── on-stop.py            # Handoff summary on stop
    ├── on-error.py           # Stuck thread on error
    └── sticky-codex.sh       # Optional Codex wrapper

.github/
└── hooks/
    └── hooks.json            # Copilot CLI hook config

.sticky-note/
├── sticky-note.json          # Shared threads (git-tracked)
├── sticky-note-config.json   # Team config (git-tracked)
├── sticky-note-audit.jsonl   # Audit trail (local only)
└── .sticky-presence.json     # Active users (local only)
```

---

## CLI Commands

```bash
npx sticky-note init           # Interactive setup
npx sticky-note init --codex   # Setup with Codex wrapper
npx sticky-note update         # Update hook scripts (preserves data)
npx sticky-note status         # Diagnostic report
npx sticky-note threads        # List threads with status icons
npx sticky-note audit          # Query audit trail
npx sticky-note gc             # Tombstone expired threads
npx sticky-note --version      # Show version
npx sticky-note --help         # Show help
```

### Audit Filters

```bash
npx sticky-note audit --user alice
npx sticky-note audit --file src/auth.ts
npx sticky-note audit --since 2025-01-01
npx sticky-note audit --session abc-123
npx sticky-note audit --limit 100
```

---

## Configuration

Edit `.sticky-note/sticky-note-config.json`:

```json
{
  "stale_days": 14,
  "mcp_servers": [],
  "skills": [],
  "conventions": ["Use TypeScript strict mode", "Test before commit"],
  "hook_version": "2.0.0"
}
```

| Key            | Description                              | Default |
|----------------|------------------------------------------|---------|
| `stale_days`   | Days before threads expire + gc cleanup  | `14`    |
| `mcp_servers`  | Shared MCP server references             | `[]`    |
| `skills`       | Team skill definitions                   | `[]`    |
| `conventions`  | Team coding conventions (injected)       | `[]`    |

---

## Requirements

- **Git** repository (any host)
- **Python 3.10+** (for hook scripts)
- **Node.js 16+** (for `npx` installer only)
- **Claude Code**, **Copilot CLI**, and/or **Codex**

---

## Supported Tools

| Tool        | Hook Config                 | Integration                     |
|-------------|-----------------------------|---------------------------------|
| Claude Code | `.claude/settings.json`     | Full — all 6 hooks + transcript |
| Copilot CLI | `.github/hooks/hooks.json`  | Full — all hooks                |
| Codex       | `sticky-codex.sh` wrapper   | Post-session capture            |

All tools call the same Python scripts and share the same data files.

---

## Concurrent Usage & Merge Strategy

`npx sticky-note init` adds a `.gitattributes` rule:

```
.sticky-note/sticky-note.json merge=union
```

This tells git to **keep lines from both sides** instead of conflicting.
Threads have unique UUIDs, so concurrent pushes merge cleanly.

The audit trail (`sticky-note-audit.jsonl`) is local-only and never
committed, so it never conflicts.

---

## FAQ

**Q: Does this capture my code or conversations?**
A: No. Only file paths, timestamps, usernames, and status metadata.

**Q: What happens with merge conflicts in sticky-note.json?**
A: `merge=union` in `.gitattributes` handles most cases automatically.

**Q: Can I close a thread manually?**
A: Edit `sticky-note.json` and change the thread's `status` to `"closed"`,
or run `npx sticky-note gc` to tombstone expired threads.

**Q: Does this work offline?**
A: Yes. Everything is local until you `git push`.

**Q: How do I set up Codex?**
A: Run `npx sticky-note init --codex`, then alias the wrapper:
`alias sticky-codex=".claude/hooks/sticky-codex.sh"`

---

## License

[MIT](LICENSE) — fully open source, no restrictions.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
