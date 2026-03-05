# 📌 Sticky Note

**Human-to-human handoff for AI coding assistants.**

Git-backed shared memory layer that captures session threads and surfaces
teammate context in Claude Code and Copilot CLI — automatically.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm version](https://img.shields.io/npm/v/sticky-note.svg)](https://www.npmjs.com/package/sticky-note)

---

## The Problem

Every developer using AI coding assistants starts every session from zero.
The handoff between teammates happens in Slack and stand-ups — everywhere
except inside the AI tool where the work actually happened.

## The Solution

Sticky Note captures what happened in each AI session (files touched, status,
notes) and surfaces it to teammates automatically on their next session start.
No dashboards. No extra tools. Just a shared JSON file in your repo.

---

## Quick Start (5 Steps)

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

### 3. Push

```bash
git push
```

### 4. Teammates Pull

```bash
git pull
```

That's it. No additional setup needed for teammates.

### 5. Work

Open Claude Code or Copilot CLI and start working. Sticky Note runs
in the background via hooks — capturing threads and surfacing context.

---

## How It Works

### Session Start
When you open Claude Code or Copilot CLI, Sticky Note loads your teammates'
recent threads and injects them as context before your first message.

### During Work
Every tool use (file edits, searches, etc.) is logged in the audit trail.
When you mention a file a teammate was working on, their thread context
is surfaced inline.

### Session End
When your session ends, Sticky Note captures the files you touched and
writes a thread record that your teammates will see next time.

### Error Handling (Copilot CLI)
If your session hits an error, it's captured as a "stuck" thread that
teammates see labeled **[STUCK]** — so they know where you left off.

---

## What Gets Captured

| Data             | Captured | Example                         |
|------------------|----------|---------------------------------|
| Files touched    | ✅        | `src/auth.ts`, `lib/db.py`     |
| Session status   | ✅        | open, stuck, stale, closed      |
| Author           | ✅        | OS username                     |
| Timestamp        | ✅        | ISO 8601                        |
| Summary note     | ✅        | "Fixed auth token refresh"      |
| Code content     | ❌        | Never captured                  |
| Conversation     | ❌        | Never captured                  |
| Credentials      | ❌        | Never captured                  |

---

## Thread Lifecycle

```
open → stale (auto, after stale_days)
open → closed (manual)
stuck → closed (manual)
```

Threads are **never deleted** — only their status changes.

---

## File Structure

```
.claude/
├── settings.json           # Claude Code hook config
└── hooks/
    ├── session-start.py    # Load & inject teammate context
    ├── session-end.py      # Capture session thread
    ├── inject-context.py   # Per-prompt file matching
    ├── track-work.py       # Audit trail per tool use
    ├── on-stop.py          # Checkpoint on stop (Claude Code)
    └── on-error.py         # Stuck thread on error (Copilot CLI)

.github/
└── hooks/
    └── hooks.json          # Copilot CLI hook config

.sticky-note/
└── sticky-note.json        # Shared data (threads + audit)
```

---

## Querying the Audit Trail

In V1, the audit trail is raw JSON. Use `jq` to query it:

```bash
# All audit entries
cat .sticky-note/sticky-note.json | jq '.audit'

# Entries by user
cat .sticky-note/sticky-note.json | jq '.audit[] | select(.user=="alice")'

# Entries for a specific file
cat .sticky-note/sticky-note.json | jq '.audit[] | select(.file | contains("auth"))'

# Recent sessions
cat .sticky-note/sticky-note.json | jq '.threads[] | select(.status=="open")'

# Stuck threads
cat .sticky-note/sticky-note.json | jq '.threads[] | select(.status=="stuck")'
```

---

## CLI Commands

```bash
npx sticky-note init      # Interactive setup
npx sticky-note update    # Update scripts (preserves data)
npx sticky-note status    # Diagnostic report
npx sticky-note --help    # Show help
```

---

## Configuration

Edit `.sticky-note/sticky-note.json` → `config` block:

```json
{
  "config": {
    "mcp_servers": ["server-name"],
    "skills": [],
    "conventions": ["Use TypeScript strict mode", "Test before commit"],
    "stale_days": 3,
    "hook_version": "1.0.0"
  }
}
```

| Key            | Description                              | Default |
|----------------|------------------------------------------|---------|
| `mcp_servers`  | Shared MCP server references             | `[]`    |
| `skills`       | Team skill definitions                   | `[]`    |
| `conventions`  | Team coding conventions (injected)       | `[]`    |
| `stale_days`   | Days before open threads become stale    | `3`     |

---

## Requirements

- **Git** repository (any host)
- **Python 3.10+** (for hook scripts)
- **Node.js 16+** (for `npx` installer only)
- **Claude Code** and/or **Copilot CLI**

---

## Supported Tools

| Tool          | Hook Config               | Notes                     |
|---------------|---------------------------|---------------------------|
| Claude Code   | `.claude/settings.json`   | All 6 hooks               |
| Copilot CLI   | `.github/hooks/hooks.json`| 5 hooks + errorOccurred   |

Both tools call the same Python scripts and share `sticky-note.json`.

---

## Concurrent Usage & Merge Strategy

When multiple teammates push changes to `sticky-note.json` at the same time,
git needs to merge both sides. Sticky Note handles this automatically:

### Automatic (default)

`npx sticky-note init` adds a `.gitattributes` rule:

```
.sticky-note/sticky-note.json merge=union
```

This tells git to **keep lines from both sides** instead of conflicting.
Since threads and audit entries are append-only (each on its own lines),
concurrent pushes merge cleanly in most cases.

### If a conflict does occur

In rare cases where the JSON structure itself breaks after a merge:

1. **threads array** — Keep all threads from both sides. They have unique
   UUIDs so there are no true duplicates.
2. **audit array** — Concatenate both sides, keep the newest 500 entries.
3. **config block** — Accept the incoming change (the pusher's config).

### V1 limitation

Sharing requires a `git push` + `git pull` cycle. If two teammates are
working simultaneously without pushing, they won't see each other's threads
until the next push/pull. Real-time sync is planned for V2.

---

## FAQ

**Q: Does this capture my code or conversations?**
A: No. Only file paths, timestamps, usernames, and status metadata.

**Q: What happens with merge conflicts in sticky-note.json?**
A: `merge=union` in `.gitattributes` handles most cases automatically.
See [Concurrent Usage & Merge Strategy](#concurrent-usage--merge-strategy) above.

**Q: Can I close a thread manually?**
A: Edit `sticky-note.json` and change the thread's `status` to `"closed"`.

**Q: Does this work offline?**
A: Yes. Everything is local until you `git push`.

---

## License

[MIT](LICENSE) — fully open source, no restrictions.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
