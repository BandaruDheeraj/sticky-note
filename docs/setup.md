# Sticky Note — Setup Guide

## Quick start

```bash
npx sticky-note-cli init
```

That's the only command. The wizard handles everything.

---

## What the wizard does

When you run `init` in a git repo, it:

1. Scans for existing MCP servers and skills in your project
2. Asks a few team config questions (MCP servers, conventions, stale thread age)
3. Asks whether to set up the **Cloudflare cloud backend** for real-time team sync
4. Writes hook scripts to `.claude/hooks/` and `.github/hooks/`
5. Registers the sticky-note MCP server in `~/.claude/settings.json`
6. Updates `.gitignore` and `.gitattributes`
7. Creates `.sticky-note/sticky-note-config.json`

---

## Setup scenarios

### A. Local-only (no cloud sync)

Answer **N** when asked about the cloud backend. Threads are stored in git
(the `sticky-note/data` orphan branch) and shared through normal `git push/pull`.

```
Set up Cloudflare cloud backend for real-time team sync? (y/N): N
```

Teammates run the same `init` after pulling. No cloud account needed.

### B. Cloud backend (real-time sync)

Answer **y** when asked about the cloud backend. The wizard will:

1. Install `wrangler` if not found (`npm install -g wrangler`)
2. Open your browser for Cloudflare login (`wrangler login`)
3. Create a Cloudflare KV namespace
4. Deploy a Cloudflare Worker named after your repo:
   ```
   sticky-{owner}-{repo}.{account}.workers.dev
   ```
5. Generate an API key and set it on the Worker
6. Write `.env.sticky` with `STICKY_URL` and `STICKY_API_KEY`
7. Save `STICKY_URL` to `.sticky-note/sticky-note-config.json` (commit this!)
8. Print the API key to share with teammates

```
Set up Cloudflare cloud backend for real-time team sync? (y/N): y

  Cloud Backend Setup...

  Step 1: Creating KV namespace...
  [OK] KV namespace created
  Step 2: Deploying Worker as "sticky-dheeraj-my-repo"...
  [OK] Worker deployed: https://sticky-dheeraj-my-repo.workers.dev
  Step 3: Setting API key on Worker...
  [OK] STICKY_API_KEY set on Worker
  [OK] .env.sticky written with STICKY_URL and STICKY_API_KEY
  [OK] sticky_url written to .sticky-note/sticky-note-config.json

  ┌─────────────────────────────────────────────────────────────┐
  │  Share this with teammates (once, via DM or 1Password):      │
  │  STICKY_API_KEY=<your-key>                                   │
  │                                                              │
  │  STICKY_URL is committed to git — teammates get it on pull.  │
  └─────────────────────────────────────────────────────────────┘
```

After init completes:

```bash
git add .claude .github .sticky-note .gitignore .gitattributes CLAUDE.md
git commit -m "feat: add sticky-note hooks"
git push
```

**Restart Claude Code** to activate the MCP server.

---

## Teammate setup

After you push, a teammate does:

```bash
git pull
npx sticky-note-cli init
```

The wizard detects `STICKY_URL` already in `.sticky-note/sticky-note-config.json`
and skips provisioning — it just asks for the API key:

```
  Cloud backend detected: https://sticky-dheeraj-my-repo.workers.dev
  Enter your STICKY_API_KEY (get it from your team lead): <paste key>
  [OK] .env.sticky written
```

Then they restart Claude Code. That's it.

---

## Push existing threads to cloud

After first setting up the cloud backend, push your existing local threads:

```bash
npx sticky-note-cli migrate --to cloud
```

Run this once. Going forward, session-end hooks push new threads automatically.

---

## MCP server tools

Once Claude Code is restarted, these tools are available in every session:

| Tool | What it does |
|---|---|
| `get_stuck_threads()` | List all stuck threads — blockers from teammates |
| `check_overlaps(files)` | Warn if files you're editing are owned by another thread |
| `search_threads(query)` | Find threads by keyword |
| `get_thread_context_for_files(files)` | Prior work context for files you're about to edit |
| `get_full_transcript(id)` | Full verbatim conversation for a thread |
| `get_audit_trail(file)` | Who changed a file and when |

The MCP server fetches from the cloud backend at startup when `STICKY_URL` is set,
so tools reflect the live team state rather than just local data.

---

## Transcript capture

Every session's complete transcript — every message, response, and thinking
block — is captured automatically. Stored locally in the git data branch and
pushed to the cloud backend at session end.

To read a transcript:

```bash
npx sticky-note-cli transcript <thread-id>
npx sticky-note-cli transcript <thread-id> --raw   # raw JSONL
```

To disable: set `"capture_transcripts": false` in `.sticky-note/sticky-note-config.json`.

---

## Key files

| File | Purpose | Commit? |
|---|---|---|
| `.sticky-note/sticky-note-config.json` | Team settings + `STICKY_URL` | ✅ Yes |
| `.sticky-note/sticky-note.json` | Thread memory (V2 local) | ✅ Yes |
| `.env.sticky` | `STICKY_URL` + `STICKY_API_KEY` | ❌ No (secrets) |
| `.claude/hooks/` | AI assistant hooks | ✅ Yes |
| `.claude/settings.json` | Hook wiring (project-level) | ✅ Yes |

---

## claude.ai Cowork (V3.2)

To capture sessions from claude.ai (cowork or projects), you need the cloud backend running
and a remote MCP connector configured in your claude.ai project settings.

### 1. GitHub PAT (optional but recommended)

After the cloud backend step, `npx sticky-note init` asks:

```
Optional: GitHub PAT for Worker → git commits (enables remote cowork session tracking).
Create at https://github.com/settings/tokens/new (fine-grained, Contents read+write).
PAT (leave blank to skip):
```

Enter a PAT to let the Worker commit thread metadata to `sticky-note.json` after each session.
The init wizard stores it as `GITHUB_PAT` Worker secret automatically.

If you skip this, cowork events still land in KV — they just won't appear in git history.

### 2. Connector URL

After the PAT step (or after skipping), the wizard prints:

```
── claude.ai Cowork MCP Connector ──────────────────────────
To track cowork sessions, add this connector in claude.ai project settings:
  URL:    https://sticky-{owner}-{repo}.workers.dev/mcp
  Header: X-Sticky-API-Key: <your-key>

The CLAUDE.md project system prompt (paste into claude.ai project instructions):
  1. Call open_thread at session start with the verbatim first user prompt
  2. Call append_event for every action: ai_thinking, ai_response, tool_call,
     tool_result, tool_error, tool_denied, context_compressed, git_commit,
     subagent_spawn, subagent_result, checkpoint
  3. Call set_checkpoint when the user switches topics
  4. Call close_thread at session end with narrative and work_type
```

### 3. Configure claude.ai

1. Open your claude.ai project → **Settings** → **Integrations** → **Add MCP Server**
2. Enter the URL and header from step 2
3. Paste the system prompt block into your project instructions

The next cowork session will open a thread, stream events live, and commit thread metadata to git.

### Manual Worker secrets

If you need to set secrets without the wizard:

```bash
cd sticky-server
wrangler secret put GITHUB_PAT     # fine-grained PAT, Contents read+write
wrangler secret put GITHUB_REPO    # value: owner/repo  e.g. acme/frontend
```

---

## Troubleshooting

**MCP tools not available after init**
→ Restart Claude Code. MCP servers are loaded at startup.

**`wrangler login` hangs**
→ The browser opened — complete the login there, then return to the terminal.

**KV write limit hit (free tier = 1,000 writes/day)**
→ Resets at midnight UTC. For production use, upgrade to Workers Paid ($5/month → 1M writes/day).

**Threads not showing in cloud**
→ Run `npx sticky-note-cli migrate --to cloud` to push existing local threads.

**`.env.sticky` missing on teammate machine**
→ They need to run `npx sticky-note-cli init` and enter the API key when prompted.
