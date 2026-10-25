# Sticky Note

**A shared, living record of what every teammate's AI coding agent is doing and has done.**

When one person's agent works on something, the next person's agent already knows what happened, what is in progress, and who is working where. Install it once per repo; after that there are no extra steps for anyone.

> [!IMPORTANT]
> **This is v4, a from-scratch TypeScript rewrite (alpha), on the `ailaney-rewrite` branch.** It is not yet published to npm: `npx sticky-note-cli` still installs v3. Follow [Install](#install) below to use v4. Features, commands and file formats may still change.

---

## What works today

| | |
|---|---|
| **Capture** | Each Claude Code session becomes a *thread*: title from your first prompt, branch, author, files edited, session start and end. |
| **Share** | Threads live on a git branch (`sticky-note/context`) and sync through your normal remote. No server and no new infrastructure; it works offline. |
| **Surface** | At session start, on each prompt, and before each file edit, your agent is told about relevant teammate work: stuck threads, work in progress right now, threads on the same branch, threads that touched the same files. You see a one-line summary in the transcript too. |
| **Overlap warnings** | Before your agent edits a file that's part of a teammate's open thread, or that a teammate has *claimed*, the agent is warned and so are you. Warnings never block the edit. |
| **Presence** | `sticky-note who` shows whose agents are active right now, on what thread, branch and files, plus active file claims. |
| **History on first touch** | The first time your agent reads or edits a file in a session, it's shown earlier threads that worked on that file, including closed ones and what didn't work. Commits made during a session are linked to its thread, so a file's git history leads back to the thread that changed it. |
| **MCP server** | Tools any MCP-capable agent can call on purpose: check overlaps before editing, search past work before starting, see who's active, read a file's history, claim files, close a thread. `init` registers it in `.mcp.json`. This also covers Cursor, Windsurf and other tools without hooks. |
| **CLI** | List, show, create, close and sync threads; claim files; see who's active; preview exactly what agents are shown. |

**Not built yet** (planned for Release 1): continuing (resuming) a teammate's thread, automatic stuck detection, MCP tools for audit, transcripts and environment, the remote MCP server for claude.ai, transcripts and line-level AI blame, Copilot CLI and Codex support, the cloud backend (real-time presence without git), and environment sync.

## Requirements

- **Node.js 20+**, available as `node` on the `PATH` that Claude Code uses. Check with `node -v`.
- **git** 2.30+
- **Claude Code**, for automatic capture and surfacing. The CLI works without it.

## Install

Until v4 is on npm, build it from source once per machine:

```sh
git clone -b ailaney-rewrite https://github.com/BandaruDheeraj/sticky-note.git ~/tools/sticky-note
cd ~/tools/sticky-note
npm install
npm run build          # produces dist/: cli.js plus chunks loaded on demand, with no runtime dependencies
```

Optionally put it on your `PATH` so you can type `sticky-note` instead of `node ~/tools/sticky-note/dist/cli.js`:

```sh
ln -s ~/tools/sticky-note/dist/cli.js /usr/local/bin/sticky-note
```

To update later: `git pull && npm install && npm run build` in that folder. Hooks pick up the new build on their next run.

## Set up a repository

Run this once in the root of the repo you want to share context in:

```sh
cd path/to/your-repo
node ~/tools/sticky-note/dist/cli.js init --hook-command "node $HOME/tools/sticky-note/dist/cli.js"
```

`init`:

1. writes `.sticky-note/config.json` (the data branch name and remote)
2. creates the data branch `sticky-note/context`, or reuses it if a teammate already pushed one
3. adds Claude Code hooks to `.claude/settings.json`, keeping any settings and hooks you already have
4. registers the sticky-note MCP server in `.mcp.json`, keeping any other servers

`--hook-command` tells the hooks and the MCP server how to run sticky-note. While v4 isn't on npm, point it at your build with an **absolute path**. The default, `npx --no-install sticky-note-cli`, will be right once v4 is published.

Then commit the setup so teammates get it:

```sh
git add .sticky-note/config.json .claude/settings.json .mcp.json
git commit -m "Set up sticky-note"
```

**Teammates:** after pulling that commit, install sticky-note (see [Install](#install)) and run `sticky-note init` once in their clone. `init` is safe to re-run at any time.

> [!NOTE]
> The hook command is stored in the shared `.claude/settings.json`, so with an absolute path everyone needs the build in the same place. Until v4 is on npm, the simplest options are to agree on a location (such as `~/tools/sticky-note`) or to put `sticky-note` on everyone's `PATH` and use `--hook-command sticky-note`.

### Check that it works

1. Open Claude Code **in the repo root**. If your editor opens a parent folder, Claude Code won't load the repo's hooks.
2. Run `/hooks`. You should see sticky-note on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`. Approve them if prompted.
3. Run `/mcp`. `sticky-note` should be listed as connected with 9 tools. Approve the project server if prompted.
4. Ask Claude something and let it finish the turn, then in a terminal:
   ```sh
   sticky-note threads
   ```
   Your session appears as a thread, titled from your first prompt.

## Try it: two-person demo

**Scripted (about 30 seconds, no Claude needed).** It plays two teammates' sessions through the real CLI and git, and prints what each person and each agent is shown:

```sh
npm run demo
```

**Live, with two real Claude Code sessions.** This creates `~/sticky-demo`: a shared remote plus clones for "Alice" and "Bob", each with its own git identity and hooks already installed. It then prints step-by-step instructions for two terminals:

```sh
npm run demo:setup        # or: scripts/demo-setup.sh /some/other/dir
```

Remove it afterwards with `rm -rf ~/sticky-demo`.

## Using it day to day

Nothing to do: work in Claude Code as usual. Behind the scenes:

| When | What sticky-note does |
|---|---|
| Session starts | Starts a background sync. Tells the agent (and you, in one line) about teammates' stuck threads, work in progress, and threads on your branch. |
| You send a prompt | The first prompt names your session's thread. Each prompt pulls in teammate threads related to what you asked or to the files you're working on. A thread is shown once, and again only if it changed. |
| Agent is about to edit a file | If a teammate claimed the file or has an open thread on it, the agent is warned before editing, and you see a line like `sticky-note: Alice is working on src/billing/invoice.ts ("Fix rounding")`. Once per file per session. On the first touch of a file, the agent also gets its history (below). |
| Agent reads a file | On the first read in a session, the agent is shown earlier threads that touched the file or whose commits changed it. |
| Agent edits a file | The file is noted locally. This is cheap: no git work. |
| Agent finishes a turn | The thread and edited files are committed to the data branch, along with a heartbeat (for `who`) and any commits you made this session. A new thread is pushed immediately, and after that a sync runs at most every 2 minutes. |
| Session ends | The session is marked ended and everything is pushed. |

What the agent receives looks like this:

```
[sticky-note] Team activity in this repo:
- IN PROGRESS · "Fix rounding in invoice totals" · Alice · 12m ago · branch main · id mvei8pya-06b9d2
  Files: src/billing/invoice.ts, src/billing/credit-note.ts
  Why shown: in progress now; same branch (main)
Details: `sticky-note show <id>`. Tell the user about anything here that affects their request.
```

### MCP tools

Agents call these on their own; the server tells them when (for example, check overlaps before editing).

| Tool | What it answers |
|---|---|
| `check_overlaps(files)` | Has a teammate claimed these files, or are they working on them? |
| `search_threads(query)` | What has the team already done or tried (including failed approaches) about this? |
| `get_file_context(file)` | Which threads worked on this file, by files touched or by commits in its git history? |
| `get_presence()` | Who's active right now, on what, and what's claimed? |
| `list_threads(status?, author?)` / `get_thread(id)` | Browse threads / read one in full |
| `get_stuck_threads()` | Who is stuck, on what, and what did they try? |
| `close_thread(id, summary?)` | Mark a goal done (only when the user confirms) |
| `claim_files(files, reason?, hours?)` | Claim files for the user |

The server reads local data and starts a background sync when it launches. To use it from another MCP client (Cursor, Windsurf, …), point the client at `sticky-note mcp`, run in the repo.

### Commands

| Command | What it does |
|---|---|
| `sticky-note init` | Set up (or repair) sticky-note in this repo. Options: `--branch`, `--remote`, `--hook-command`, `--skip-hooks` |
| `sticky-note status` | Setup, sync state (to push and to pull), and thread counts |
| `sticky-note threads` (alias `ls`) | Open threads, newest first. `-a` includes closed; `-s stuck`; `--author alice@example.com`; `-n 50` |
| `sticky-note show <id>` | One thread in full. Any unique id prefix works |
| `sticky-note new "<title>"` | Start a thread by hand. `-f <file>` (repeatable), `-t bugfix`, `-m "<notes>"` |
| `sticky-note close <id>` | Mark a thread done. `-s "<summary>"` is appended to its notes |
| `sticky-note sync` | Pull teammates' threads and push yours now |
| `sticky-note who` | Whose agents are active right now (a heartbeat in the last 30 min), on what, plus active claims. `-r` includes the last 24h |
| `sticky-note claim <files...>` | Tell teammates you're working on files; their agents are warned before editing them. `-m "<reason>"`, `--hours 2` (default 8) |
| `sticky-note unclaim <files...>` | Release claims; `--all` releases all of yours |
| `sticky-note claims` | List everyone's active claims |
| `sticky-note mcp` | Run the MCP server on stdio (MCP clients start this from `.mcp.json`) |
| `sticky-note context` | Preview what an agent would be shown. `-p "<prompt>"`, `-f <file>`, `-a` to see every thread's score and reasons |

Every command accepts `--json` (machine-readable output), `--cwd <dir>` and `-h`/`--help`.

## How it works

**Storage.** Each thread is one JSON file, `threads/<id>.json`, on the `sticky-note/context` branch. Each person's file claims are one file, `claims/<person>.json`, so teammates never write the same claims file. That branch is checked out in a private git worktree at `.git/sticky-note/worktree`, so your working tree, your current branch and your `git status` are never touched. Commits on the data branch skip your repo's git hooks.

**Sync.** `sync` fetches the data branch, rebases your thread commits onto it, and pushes. If you and a teammate changed the *same* thread before syncing, it merges the two versions field by field instead of raising a git conflict:

- lists (files, contributors, sessions) are combined
- status, notes and title come from the most recent version
- a close always wins, so a teammate's agent can't silently reopen a closed thread

If a teammate pushes first, sync retries.

**Local state** (never committed) lives in `.git/sticky-note/`:

| Path | Contents |
|---|---|
| `worktree/` | The checked-out data branch |
| `sessions/` | Per-session scratch state shared between hook calls |
| `logs/hooks.log` | One `start` and one `ok`/`FAILED` line per hook call, plus background sync output |

**Reliability.** Hooks never fail or block Claude Code: errors go to the log and the hook exits 0. If a hook is killed (for example on timeout), the next write recovers: leftover changes are committed, stale git locks cleared, and a lock held by a dead process is taken over immediately.

**Opting in.** Hooks do nothing in a repo without `.sticky-note/config.json`.

## Troubleshooting

| Symptom | Check |
|---|---|
| `sticky-note threads` stays empty after a session | Was Claude Code opened in the repo root? Run `/hooks` in the session. Then look at `.git/sticky-note/logs/hooks.log`: no lines at all means the hooks never ran. |
| Log shows `start` with no `ok` | The hook was killed (timeout). The next hook recovers automatically; report it if it keeps happening. |
| Hooks error with a syntax error | `node` on Claude Code's `PATH` is older than 20. Run `node -v` in a plain terminal. |
| A teammate's work isn't showing up | Run `sticky-note sync` on both sides, then `sticky-note context -a` to see how threads score and why. |
| A thread shows **IN PROGRESS** though nobody is working on it | Its session didn't end cleanly. It stops counting as live 30 minutes after its last heartbeat. Automatic crash recovery is planned. |
| `who` shows someone who just stopped, or misses someone who just started | Presence is as fresh as the last sync: hooks sync in the background during sessions (at most every 2 minutes). Run `sticky-note sync` to refresh now. |

For full error stacks from the CLI, set `STICKY_DEBUG=1`.

## Development

```sh
npm install
npm run build        # bundle to dist/ (cli.js + lazily loaded chunks such as the MCP SDK)
npm run typecheck
npm test             # unit and integration tests (real temp git repos)
npm run test:e2e     # builds, then runs dist/cli.js as real processes: two teammates, a shared remote
npm run dev -- threads   # run from source without building
```

To develop sticky-note *with* sticky-note, point this repo's hooks at your local build:

```sh
npm run build
node dist/cli.js init --hook-command 'node "$CLAUDE_PROJECT_DIR/dist/cli.js"'
```

### Layout

```
src/
  core/        threads, claims, config, git, locking, session state
    store/     ThreadStore interface + git data-branch backend (sync, merge, recovery)
  cli/         Cli class, command registry, output; commands/ has one file per command
  hooks/       agent-neutral events and handlers; adapters/ per agent; install/ per agent
  surfacing/   relevance ranking, shared queries (overlaps, history, search), rendering, injection policy
  mcp/         MCP server and tools, stdio runner, .mcp.json installer
test/          unit and integration tests; e2e/ end-to-end tests against the built CLI
```

### Adding a command

Create `src/cli/commands/<name>.ts` with `defineCommand({ name, summary, args, options, run })` and add it to `src/cli/commands/index.ts`. Parsing, validation, `--help`, `--json` and exit codes are handled for you. Multi-word names such as `env add-server` work as subcommands.

### Adding an agent

Implement an `AgentAdapter` in `src/hooks/adapters/` that translates the agent's hook payloads into the neutral events in `src/hooks/events.ts`, and register it in `adapters/index.ts`. The handlers are shared by every agent.

## License

MIT
