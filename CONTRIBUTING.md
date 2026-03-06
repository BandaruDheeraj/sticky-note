# Contributing to Sticky Note

Thanks for your interest in contributing to Sticky Note! This project is MIT
licensed and welcomes contributions from everyone.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch: `git checkout -b my-feature`
4. Make your changes
5. Run tests: `npm test`
6. Commit: `git commit -m "feat: description"`
7. Push and open a PR

## Development Setup

```bash
git clone https://github.com/sticky-note/sticky-note.git
cd sticky-note
npm install   # no deps, just sets up the project
python --version  # ensure 3.10+
```

## Project Structure

```
bin/cli.js                          # npx entry point (init/update/status/threads/audit/gc)
templates/hooks/*.py                # Python hook scripts installed into repos
templates/hooks/sticky-codex.sh     # Codex wrapper script
templates/*.json                    # Config templates for Claude Code & Copilot CLI
templates/gitignore-additions.txt   # Entries added to .gitignore on init
```

## V2 File Layout (installed in target repos)

```
.sticky-note/
  sticky-note.json          # Thread store (version: "2", mutable)
  sticky-note-config.json   # Config (stale_days, mcp_servers, conventions)
  sticky-note-audit.jsonl   # Audit log (append-only JSONL, gitignored)
  .sticky-presence.json     # Presence heartbeat (gitignored)
.claude/hooks/              # Hook scripts (Python)
.github/hooks/hooks.json    # Copilot CLI hook config
```

## Merge Strategy for sticky-note.json

**Important:** `sticky-note.json` is a shared data file that multiple
developers write to concurrently. When merge conflicts arise:

1. **threads array**: Keep all threads from both sides. Duplicate thread IDs
   should not occur (UUIDs), but if they do, keep the one with the newer
   `last_activity_at` timestamp.

2. **config block**: In V2, config is a separate file (`sticky-note-config.json`).
   Accept the incoming change (theirs) for config updates.

Consider adding a `.gitattributes` rule (done automatically by `init`):
```
.sticky-note/sticky-note.json merge=union
```

## Code Style

- Python: Follow PEP 8, target Python 3.10+
- JavaScript: No transpilation, ES modules, Node 16+
- Keep scripts self-contained with zero external dependencies

## Testing

Hook scripts can be tested by running them directly:
```bash
echo '{}' | python .claude/hooks/session-start.py
echo '{}' | python .claude/hooks/session-end.py
echo '{}' | python .claude/hooks/track-work.py
```

CLI commands:
```bash
node bin/cli.js status
node bin/cli.js threads
node bin/cli.js audit --user alice --since 2026-03-01
node bin/cli.js gc
```

## Reporting Issues

Please include:
- Your OS (macOS/Linux/Windows WSL)
- Python and Node.js versions
- Output of `npx sticky-note status`
- The relevant section of `.sticky-note/sticky-note.json`
