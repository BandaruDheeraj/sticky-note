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
bin/cli.js              # npx entry point (init/update/status)
templates/hooks/*.py    # Python hook scripts installed into repos
templates/*.json        # Config templates for Claude Code & Copilot CLI
```

## Merge Strategy for sticky-note.json

**Important:** `sticky-note.json` is a shared data file that multiple
developers write to concurrently. When merge conflicts arise:

1. **threads array**: Keep all threads from both sides. Duplicate thread IDs
   should not occur (UUIDs), but if they do, keep the one with the newer
   `updated_at` timestamp.

2. **audit array**: Concatenate both sides, sort by timestamp, trim to 500
   entries (keep newest).

3. **config block**: Accept the incoming change (theirs) for config updates
   since config should be set once and propagated.

Consider adding a `.gitattributes` rule:
```
.claude/sticky-note.json merge=union
```

## Code Style

- Python: Follow PEP 8, target Python 3.10+
- JavaScript: No transpilation, ES modules, Node 16+
- Keep scripts self-contained with zero external dependencies

## Testing

Hook scripts can be tested by running them directly:
```bash
echo '{}' | python .claude/hooks/session-start.py
```

## Reporting Issues

Please include:
- Your OS (macOS/Linux/Windows WSL)
- Python and Node.js versions
- Output of `npx sticky-note status`
- The relevant section of `.claude/sticky-note.json`
