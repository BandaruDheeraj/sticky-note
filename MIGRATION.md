# Sticky Note — V1 → V2 Migration Guide

## What Changed

| Area | V1 | V2 |
|------|----|----|
| **Files** | 1 file (`sticky-note.json` with embedded audit) | 2 files (`sticky-note.json` threads + `sticky-note-audit.jsonl`) |
| **Config** | Embedded in `sticky-note.json` | Separate `sticky-note-config.json` |
| **Audit format** | JSON array (rewritten on every tool use) | JSONL append-only (O(1) writes, no merge conflicts) |
| **Thread schema** | Basic (id, user, status, files, note) | Rich (+ narrative, failed_approaches, handoff_summary, branch, related_session_ids, last_activity_at) |
| **Thread expiry** | Threads accumulate forever | Lazy tombstone after `stale_days` (default: 14) |
| **Context injection** | Dump all threads | Relevance-scored top 3–5, < 300 tokens |
| **Presence** | None | `.sticky-presence.json` (gitignored, local only) |
| **MCP server** | None | `sticky-note-mcp` binary with 5 query tools |
| **Codex support** | None | `sticky-codex.sh` wrapper |

## How Migration Works

**Migration is automatic.** When any V2 hook script runs and detects a V1 schema, it migrates in-place:

1. Reads your existing `sticky-note.json`
2. Detects V1 format (has `audit` array, no `version` field)
3. Extracts `audit[]` → writes to `sticky-note-audit.jsonl` (one JSON object per line)
4. Extracts config fields (`stale_days`, `mcp_servers`, etc.) → writes to `sticky-note-config.json`
5. Strips `audit` and config from thread store → sets `version: "2"` → writes `sticky-note.json`
6. Adds `.sticky-presence.json` and `sticky-note-audit.jsonl` to `.gitignore`

**Nothing is deleted.** V1 data is restructured, not removed.

## Manual Migration via CLI

If you prefer to migrate explicitly:

```bash
npx sticky-note init
```

Running `init` on an existing project detects V1 and runs the same migration. It also updates hook scripts to V2 versions.

## What You Need to Do

### For most teams: Nothing

If you run `npx sticky-note init` or any hook fires, migration happens automatically.

### If you have custom scripts reading `sticky-note.json`:

**Before (V1):**
```json
{
  "project": "my-app",
  "threads": [...],
  "audit": [
    {"type": "tool_use", "user": "alice", ...}
  ],
  "stale_days": 14,
  "mcp_servers": []
}
```

**After (V2):**
```json
{
  "version": "2",
  "project": "my-app",
  "threads": [...]
}
```

- **Audit** → now in `sticky-note-audit.jsonl` (one JSON object per line)
- **Config** → now in `sticky-note-config.json`
- **Thread fields** → new optional fields added (backward compatible)

### If you have MCP clients (Cursor, Windsurf):

Add the MCP server to your client config:

```json
{
  "mcpServers": {
    "sticky-note": {
      "command": "npx",
      "args": ["-y", "sticky-note-mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Or run directly:
```bash
npx sticky-note-mcp --project /path/to/project
```

Available MCP tools:
- `get_session_context(id)` — full thread payload
- `get_stuck_threads()` — all stuck threads
- `search_threads(query)` — keyword search
- `get_audit_trail(file?, user?, since?, tool?)` — query audit log
- `get_presence()` — who's active right now

## Thread Schema Changes

New optional fields on threads (all backward compatible — existing threads still work):

| Field | Type | Description |
|-------|------|-------------|
| `narrative` | string | Auto-extracted session summary |
| `failed_approaches` | array | `[{description, error, files_tried}]` |
| `handoff_summary` | string | Structured: what done / what failed / next step |
| `related_session_ids` | array | Linked sessions on same files |
| `last_activity_at` | string | ISO timestamp, resets expiry clock |
| `branch` | string | Git branch at session start |

## Tombstone Expiry

Threads now expire instead of accumulating forever:

```
open → closed (session-end)
closed → expired (after stale_days, on next session-end or `npx sticky-note gc`)
```

Expired threads become tombstones — only `id`, `status`, `user`, and `closed_at` are preserved. Audit log references by ID remain valid.

Configure in `sticky-note-config.json`:
```json
{
  "stale_days": 14
}
```

Run manual garbage collection:
```bash
npx sticky-note gc
```

## Rollback

If you need to go back to V1:

1. Your V1 `sticky-note.json` is preserved in git history
2. `git checkout HEAD~1 -- .sticky-note/sticky-note.json` to restore
3. Delete `sticky-note-config.json` and `sticky-note-audit.jsonl`
4. Reinstall V1 hooks: `git checkout HEAD~1 -- .claude/hooks/`

## FAQ

**Q: Do I need to run migration manually?**
No. Any V2 hook script auto-migrates V1 data on first run.

**Q: Will V1 and V2 hooks conflict?**
No. V2 hooks detect V1 schema and migrate before proceeding. V1 hooks won't break V2 data (they'll just ignore new fields).

**Q: Is the audit log capped?**
No. JSONL is append-only and never parsed in full. Queries scan line-by-line, which stays fast for typical repo sizes (< 100ms for 100k lines).

**Q: Does presence work across machines?**
Not in V2. `.sticky-presence.json` is gitignored — it's local-only (shared dev boxes, pair programming). Distributed presence requires V3's cloud backend.

**Q: What if my team has mixed V1/V2 users?**
V2 hooks auto-migrate, so the first V2 user to run will upgrade the shared `sticky-note.json`. V1 hooks will still read the file (they ignore unknown fields). For best results, have the whole team update together.
