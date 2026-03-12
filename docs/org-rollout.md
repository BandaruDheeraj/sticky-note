# GitHub Action Org Rollout Guide

Sticky Note V3 includes a GitHub Action that auto-installs hooks on every
repo in your org. Push once, all repos get Sticky Note on their next push.

---

## How It Works

The workflow template (`sticky-note-install.yml`) runs on every push to
`main` and on `workflow_dispatch`:

1. Checks if `.claude/hooks/session-start.js` exists (already installed)
2. If **not installed**: runs `npx sticky-note-cli@latest init --ci --no-prompts`
3. If **already installed**: runs `npx sticky-note-cli@latest update --ci`
4. Commits: `"chore: install sticky note [sticky-note] [skip ci]"`

The `--ci --no-prompts` flag runs init non-interactively, reading config
from environment variables instead of prompting.

---

## Setup

### 1. Deploy the Cloud Backend

One deployment per org:

```bash
npx sticky-note-cli deploy-backend
```

Note the `STICKY_URL` and `STICKY_API_KEY` from the output.

### 2. Configure Org Secrets

In your GitHub org settings → Secrets and variables → Actions:

| Secret | Value | Required |
|--------|-------|----------|
| `STICKY_URL` | `https://sticky.your-team.workers.dev` | Yes (for cloud mode) |
| `STICKY_API_KEY` | `sticky_live_xxxxx` | Yes (for cloud mode) |

### 3. Configure Org Variables (Optional)

In your GitHub org settings → Secrets and variables → Actions → Variables:

| Variable | Value | Default |
|----------|-------|---------|
| `STICKY_STALE_DAYS` | Number of days before thread expiry | `14` |
| `STICKY_CONVENTIONS` | JSON array of team conventions | `[]` |
| `STICKY_MCP_SERVERS` | JSON array of MCP server configs | `[]` |

Example `STICKY_CONVENTIONS`:
```json
["Use TypeScript strict mode", "Test before commit", "PR reviews required"]
```

### 4. Add the Workflow to Each Repo

Copy the workflow template to each repo:

```bash
mkdir -p .github/workflows
cp templates/sticky-note-install.yml .github/workflows/
git add .github/workflows/sticky-note-install.yml
git commit -m "ci: add sticky-note auto-install"
git push
```

Or add it to your org's `.github` repository as a reusable workflow.

---

## What the Action Does on First Install

1. Creates `.claude/hooks/` with all hook scripts
2. Creates `.claude/settings.json` with hook registrations
3. Creates `.github/copilot-instructions.md` for Copilot CLI
4. Creates `.github/hooks/hooks.json` for Copilot CLI hooks
5. Creates `.sticky-note/` directory structure
6. Creates `CLAUDE.md` with project instructions
7. Writes `.env.sticky` from org secrets (gitignored)
8. Updates `.gitignore` and `.gitattributes`
9. Commits all files with `[skip ci]` to avoid loops

## What the Action Does on Update

1. Refreshes hook scripts to latest version
2. Preserves all existing data (threads, audit, config)
3. Commits only if files changed

---

## Per-Repo Opt-Out

If a repo shouldn't have Sticky Note, add an empty sentinel file:

```bash
touch .sticky-note-skip
git add .sticky-note-skip
git commit -m "chore: opt out of sticky-note"
```

The workflow checks for this file and skips installation.

---

## Manual Trigger

You can re-run the workflow manually via the Actions tab
(workflow_dispatch) to force an update on any repo.

---

## Troubleshooting

### Action fails with "Node.js >= 16 required"

The workflow uses `actions/setup-node@v4` with `node-version: 18`. If your
org restricts runner images, ensure Node.js 18+ is available.

### Action commits but hooks don't fire

Claude Code and Copilot CLI must be configured to read `.claude/settings.json`
and `.github/hooks/hooks.json` respectively. The init command creates these
files, but the AI tools must support hooks (Claude Code 1.0+, Copilot CLI 1.0+).

### Cloud features not working after install

Check that org secrets `STICKY_URL` and `STICKY_API_KEY` are set at the
org level (not repo level). The workflow writes `.env.sticky` from these
secrets on each run.
