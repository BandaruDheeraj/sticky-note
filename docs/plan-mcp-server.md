# Plan B: Sticky-Note MCP Server

## Problem

Sticky-note has a fundamental communication problem: **hooks cannot reliably
surface messages to users.** We spent twelve releases (v2.6.0 through v2.6.12)
trying every approach:

| Attempt | Mechanism | Result |
|---------|-----------|--------|
| v2.6.1 | `sessionStart` output | Copilot CLI silently drops it |
| v2.6.2 | `userPromptSubmitted` output | AI absorbs context, doesn't show it |
| v2.6.3-6 | Stronger prompt language, exact banners | Unreliable AI compliance |
| v2.6.7 | `stderr` writes | Copilot CLI swallows stderr from hooks |
| v2.6.8-12 | `preToolUse` deny with PID isolation | Deny reason consumed silently by AI |

**Root cause:** All hook output goes to the AI model's context window, never
directly to the user's terminal. The AI decides whether to surface it. For
thread context, that's fine. For alerts that need user attention, it's broken.

**The solution:** An MCP server. When the AI calls an MCP tool, it **must**
process the response. Unlike hook output that gets silently absorbed, tool
responses are part of the AI's active reasoning — it has to do something with
the result. This gives us a reliable, bidirectional communication channel.

## Three Problems, One Server

### 1. The Notification Channel

The MCP server is the reliable way to surface information to users:
- Overlap warnings ("Alice is editing the same files")
- Environment status ("2 new skills from teammate, sentry needs auth token")
- Thread context ("3 stuck threads related to your current work")

The AI calls the tool, gets structured data back, and must incorporate it
into its response. No more hoping the AI surfaces injected context.

### 2. Third-Party Tool Support

AI tools beyond Claude Code and Copilot CLI (Cursor, Windsurf, Zed, Cline)
can query thread data via standard MCP protocol. Today these tools get zero
sticky-note integration. The MCP server gives them full access.

### 3. Edit Gating (Future)

A tool like `sticky_note_check_file` that the AI calls before editing a file.
Returns overlap data, attribution, and warnings. The AI can't bypass what's
built into the tool response — unlike custom instructions which are advisory.

## Architecture

```
bin/mcp-server.js (stdio JSON-RPC 2.0)
  |
  ├── reads .sticky-note/sticky-note.json     (threads)
  ├── reads .sticky-note/audit/<user>.jsonl    (audit trail)
  ├── reads .sticky-note/presence/<user>.json  (who's active)
  ├── reads .sticky-note/sticky-note-config.json (team config)
  ├── reads .sticky-note/environment/manifest.json (environment)
  └── reads .sticky-note/environment/skills/   (skill inventory)
```

Zero external dependencies. Node >= 16. Stdio transport (no HTTP server).
Registered in `.mcp.json` or `settings.local.json` as a local MCP server.

## Tools

### Core Tools (from prior implementation, issue #8)

| Tool | Description | When AI calls it |
|------|-------------|-----------------|
| `get_session_context(id)` | Full thread payload by UUID or session_id | Resuming work, checking thread state |
| `get_stuck_threads()` | All threads with status `stuck` | Session start, checking team blockers |
| `search_threads(query)` | Keyword search across non-expired threads | Finding related prior work |
| `get_audit_trail(file, user, since, tool, session, limit)` | Query JSONL audit log with filters | Understanding file history |
| `get_presence()` | Active developers seen in last 15 minutes | Checking who's online |

### New Tools (notification channel + environment)

| Tool | Description | When AI calls it |
|------|-------------|-----------------|
| `check_overlaps(files)` | Check if given files overlap with other users' open/stuck threads | Before editing files (edit gating) |
| `get_environment_status()` | Environment sync status: provisioned vs missing MCP servers, skills, agents. Flags missing secrets with docs URLs | Session start, after git pull |
| `get_thread_context_for_files(files)` | Thread attribution for specific files — who worked on them, what happened, what failed | Before editing files (lazy context) |

### Tool Response Format

Every tool returns structured JSON that the AI must process:

```jsonc
// check_overlaps response
{
  "overlaps": [
    {
      "user": "alice",
      "thread_id": "a1b2c3d4",
      "status": "stuck",
      "files": ["src/auth.ts", "src/middleware.ts"],
      "narrative": "fixing auth token refresh — tokens expire mid-request",
      "failed_approaches": ["retry logic", "token pre-fetch"],
      "severity": "high"
    }
  ],
  "warning": "WARNING: alice has a STUCK thread on 2 files you are about to edit. Consider coordinating.",
  "action": "display_to_user"
}
```

```jsonc
// get_environment_status response
{
  "status": "incomplete",
  "provisioned": {
    "mcp_servers": ["context7", "github"],
    "skills": ["react-doctor", "code-review"],
    "agents": ["security-reviewer"],
    "plugins": ["docker"]
  },
  "missing": {
    "mcp_servers": [
      {
        "name": "sentry",
        "reason": "missing_secret",
        "secret": "SENTRY_AUTH_TOKEN",
        "description": "Sentry API token",
        "docs_url": "https://sentry.io/settings/..."
      }
    ]
  },
  "new_since_last_session": {
    "skills": ["api-conventions"],
    "added_by": "bob",
    "added_at": "2026-03-18T15:30:00Z"
  },
  "action": "inform_user_of_missing_and_new"
}
```

## Why This Works Where Hooks Failed

| Hooks | MCP Server |
|-------|-----------|
| Output goes to context, AI may ignore | Tool response is part of active reasoning |
| Advisory — AI chooses whether to surface | Structural — AI must process the response |
| One-shot injection, no back-and-forth | AI can call tools multiple times |
| Copilot CLI drops `sessionStart` output | MCP protocol works identically in all tools |
| `preToolUse` deny is a hack (blocks unrelated tool) | Dedicated tool, purpose-built |

The key insight: **MCP tools are the only channel where the AI is obligated
to process and respond to the data.** Everything else is advisory context.

## Fully Automatic Registration

The MCP server registers itself with **zero user commands**. Teammates
never run `init` or `bootstrap` just to get the MCP server.

### How it works

The `session-start.js` hook (already fires on every session) checks if
`.mcp.json` has the `sticky-note` entry. If not, it adds it:

```javascript
// In session-start.js
function ensureMcpServerRegistered() {
  const mcpPath = path.join(cwd, '.mcp.json');
  let mcp = {};
  if (fs.existsSync(mcpPath)) {
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
  }
  mcp.mcpServers = mcp.mcpServers || {};
  if (!mcp.mcpServers['sticky-note']) {
    mcp.mcpServers['sticky-note'] = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'sticky-note-cli', 'mcp-server']
    };
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  }
}
```

### User Journey

```
Developer A: npx sticky-note init -> commits hooks -> pushes
Developer B: git pull                           (gets hooks)
Developer B: starts AI session (1st time)       (hook registers MCP server in .mcp.json)
Developer B: starts AI session (2nd time)       (MCP server is live, AI calls tools)
```

**One-session delay:** The AI tool reads `.mcp.json` at startup, before hooks
fire. So the hook registers the MCP server, but it becomes available on the
NEXT session. First session is hook-only (existing behavior), second session
onward gets the full MCP server.

This matches the existing "git pull -> it just works" experience for hooks.
No `init`, no `bootstrap`, no commands. Completely automatic.

### Registration entry

In `.mcp.json`:
```json
{
  "mcpServers": {
    "sticky-note": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "sticky-note-cli", "mcp-server"]
    }
  }
}
```

In `package.json` bin:
```json
{
  "bin": {
    "sticky-note": "./bin/cli.js",
    "sticky-note-mcp": "./bin/mcp-server.js"
  }
}
```

### `init` and `bootstrap` also register

For users who DO run `init` or `bootstrap`, the MCP server is registered
immediately (no one-session delay). The hook-based auto-registration is
the fallback for teammates who only do `git pull`.

## Integration with Custom Instructions

CLAUDE.md and copilot-instructions.md get updated to tell the AI:

```markdown
## Sticky Note MCP Server

You have access to a `sticky-note` MCP server. Use it:

1. **At session start**: Call `get_stuck_threads()` and `get_environment_status()`
   to check for team blockers and environment changes. Surface any warnings.

2. **Before editing files**: Call `check_overlaps(files)` with the files you
   plan to edit. If overlaps exist, warn the user before proceeding.

3. **When asked about prior work**: Call `search_threads(query)` or
   `get_audit_trail(file)` to find relevant context.

These are NOT optional. The MCP tools are the primary way sticky-note
communicates with you. Hook-injected context supplements but does not
replace MCP tool calls.
```

This replaces the unreliable "CRITICAL INSTRUCTION: TELL THE USER" hack
with a structural mechanism the AI can't skip — it either calls the tool
or it doesn't, and the instructions say to call it.

## Graceful Degradation

The MCP server is additive. If it's not registered yet (first session),
sticky-note falls back to the existing hook-based behavior:

| Session | MCP Server | Hooks | Experience |
|---------|-----------|-------|-----------|
| 1st after pull | Not yet available | Active | Hook-only (existing behavior, context injection works) |
| 2nd onward | Active | Active | Full experience (MCP tools + hooks for enrichment) |
| No hooks (Cursor, etc.) | Active (if registered) | None | MCP-only (still useful for threads, overlaps) |

## Integration with Plan A (Environment Sync)

The MCP server is how the AI learns about environment changes:

1. Plan A auto-provisions silently at session start (skills, agents, etc.)
2. If new secrets are needed, Plan A can't tell the user (hooks don't work)
3. AI calls `get_environment_status()` -> gets structured "missing sentry,
   needs SENTRY_AUTH_TOKEN" response -> tells the user

The sticky-note MCP server is also included in the environment manifest
by default, so `bootstrap` registers it alongside the team's other MCP servers.

## Phases

### Phase 1: Core Server (restore + enhance)
- Restore `bin/mcp-server.js` from git history (commit before 7c42698)
- Update to current thread format (V2, per-user audit, presence)
- Add `check_overlaps(files)` tool
- Add `get_environment_status()` tool
- Add `get_thread_context_for_files(files)` tool
- Register in `.mcp.json` during init/bootstrap

### Phase 2: Custom Instructions Update
- Update CLAUDE.md template with MCP server usage instructions
- Update copilot-instructions.md template with same
- Remove/downgrade the unreliable hook-based overlap prompting
- Keep hooks for silent context enrichment (they still work for that)

### Phase 3: Edit Gating (future)
- Add `check_before_edit(file)` tool that returns attribution + overlaps
- Instructions tell AI to call before every file edit
- Doesn't block — returns data, AI decides. But data is structural,
  not advisory, so compliance is much higher.

## Todos

1. Restore `bin/mcp-server.js` from git history
2. Update to current V2 thread format and per-user audit/presence
3. Implement `get_session_context(id)` tool
4. Implement `get_stuck_threads()` tool
5. Implement `search_threads(query)` tool
6. Implement `get_audit_trail(file, user, since, tool, session, limit)` tool
7. Implement `get_presence()` tool
8. Implement `check_overlaps(files)` tool (new)
9. Implement `get_environment_status()` tool (new)
10. Implement `get_thread_context_for_files(files)` tool (new)
11. Add `mcp-server` subcommand to bin/cli.js (or keep separate bin/mcp-server.js)
12. Auto-register in `.mcp.json` during init and bootstrap
13. Update CLAUDE.md template with MCP tool usage instructions
14. Update copilot-instructions.md template with MCP tool usage instructions
15. Downgrade hook-based overlap prompting (keep for enrichment, not alerts)
16. Add MCP server documentation to README.md
17. Test with Claude Code, Copilot CLI, and at least one third-party tool
18. Update issue #8 on GitHub with revised scope
