# Sticky Note — Cowork & Remote Session Full-Fidelity Capture

**Date:** 2026-08-21
**Status:** Draft
**Scope:** Phase 1 — claude.ai cowork sessions and mobile sessions

---

## Problem

Claude Code CLI and Desktop sessions are tracked via hooks (PostToolUse, SessionStart, etc.) that fire automatically and capture granular session data. Sessions that run in claude.ai cowork or mobile have no equivalent capture mechanism — no hooks fire, no transcript is written locally, and no thread is created. This means any AI work done outside a local terminal disappears with no record.

Additionally, the existing local audit trail is too thin for **AI blame** — the ability to trace any line of code back to the prompt, reasoning chain, and tool calls that produced it. The current audit JSONL records only tool name + file + line ranges. Full args, results, AI reasoning, and thinking blocks are only in Claude Code's local transcript JSONL, which is not shared with the team or pushed to the cloud.

---

## Goals

1. Full-fidelity event capture for claude.ai cowork and mobile sessions — same richness as local sessions.
2. Enrich local session capture so the shared audit trail supports AI blame (not just the local transcript).
3. Unified event schema across all session types (local hooks and remote MCP).
4. Single source of truth: `sticky-note.json` in git + Cloudflare KV as live cache.

**Out of scope (Phase 1):** Codex app, GitHub Copilot Desktop — adapter interfaces for those come later.

---

## Architecture

```
Local sessions                        Remote sessions (cowork / mobile)
─────────────                         ──────────────────────────────────
Hooks (PostToolUse etc.)              claude.ai remote MCP connector
        │                                           │
        ▼                                           ▼
Enriched audit JSONL              Worker /mcp endpoint (HTTP/SSE)
+ transcript JSONL push                append_event write tool
        │                                           │
        └──────────────┬───────────────────────────┘
                       ▼
             Cloudflare KV (live cache)
             GitHub REST API → .sticky-note/sticky-note.json (source of truth)
```

Both paths write the same event schema to the same storage layer. AI blame queries either path identically.

---

## Event Schema

Every captured action — regardless of session type — is stored as a structured event. Events are ordered by `seq` (monotonically increasing integer within a thread) and `ts` (ISO timestamp).

### Core fields (all events)

```json
{
  "thread_id": "uuid",
  "session_id": "uuid",
  "seq": 1,
  "ts": "2026-08-21T14:32:00.123Z",
  "type": "<event_type>",
  "data": { ... }
}
```

### Event types

**`session_open`** — first event written when a session begins
```json
{
  "type": "session_open",
  "data": {
    "model": "claude-sonnet-4-6",
    "mcp_servers": ["sticky-note"],
    "claude_md_hash": "a3f2c1...",
    "branch": "main",
    "user": "dheer",
    "sticky_version": "3.1.0"
  }
}
```

**`user_prompt`** — verbatim user message
```json
{
  "type": "user_prompt",
  "data": { "content": "fix the auth sliding window bug" }
}
```

**`ai_thinking`** — extended thinking block (before response)
```json
{
  "type": "ai_thinking",
  "data": { "content": "The issue is likely in the expiry calculation..." }
}
```

**`ai_response`** — assistant message with token metadata
```json
{
  "type": "ai_response",
  "data": {
    "content": "I'll look at the token refresh logic first...",
    "model": "claude-sonnet-4-6",
    "input_tokens": 12400,
    "output_tokens": 847,
    "cache_read_tokens": 8200
  }
}
```

**`tool_call`** — full tool invocation including all args
```json
{
  "type": "tool_call",
  "data": {
    "tool": "Edit",
    "args": {
      "file_path": "src/auth.ts",
      "old_string": "...",
      "new_string": "..."
    }
  }
}
```

**`tool_result`** — full result returned by the tool
```json
{
  "type": "tool_result",
  "data": {
    "tool": "Edit",
    "result": "File updated successfully",
    "duration_ms": 42,
    "lines_changed": ["40-55"]
  }
}
```

**`tool_error`** — tool call that failed or threw
```json
{
  "type": "tool_error",
  "data": {
    "tool": "Bash",
    "args": { "command": "npx sticky-note update" },
    "error": "command not found: npx"
  }
}
```

**`tool_denied`** — tool call the user rejected at the permission prompt
```json
{
  "type": "tool_denied",
  "data": {
    "tool": "Bash",
    "args": { "command": "rm -rf dist/" },
    "reason": "user denied"
  }
}
```

**`context_compressed`** — context window compaction event
```json
{
  "type": "context_compressed",
  "data": {
    "tokens_before": 180000,
    "tokens_after": 42000,
    "summary": "Working on auth token refresh bug in src/auth.ts..."
  }
}
```

**`git_commit`** — commit made during the session
```json
{
  "type": "git_commit",
  "data": {
    "sha": "abc123def456",
    "message": "fix auth sliding window expiry",
    "files": ["src/auth.ts"],
    "diff_stat": "+12 -4"
  }
}
```

**`subagent_spawn`** / **`subagent_result`** — Agent tool invocations
```json
{ "type": "subagent_spawn",
  "data": { "description": "Explore auth codebase", "agent_type": "Explore" } }

{ "type": "subagent_result",
  "data": { "summary": "Found token expiry logic in src/auth.ts:L120-145" } }
```

**`checkpoint`** — user or AI topic switch mid-session
```json
{
  "type": "checkpoint",
  "data": { "topic": "fixing auth token sliding window expiry" }
}
```

**`session_close`** — final event with narrative and classification
```json
{
  "type": "session_close",
  "data": {
    "narrative": "Fixed sliding window expiry bug in auth token refresh...",
    "work_type": "bug-fix",
    "handoff_summary": "Token expiry now uses relative time from last activity...",
    "failed_approaches": ["tried resetting expiry on every read — caused infinite refresh loop"],
    "files_touched": ["src/auth.ts", "tests/auth.test.ts"]
  }
}
```

---

## Local Session Changes

### 1. Enrich `track-work.js` (PostToolUse hook)

**Current:** writes `{ tool, file, lines_changed }` — no args, no result.

**New:** writes full `tool_call` + `tool_result` event pair to audit JSONL:
```json
{ "type": "tool_call", "tool": "Edit", "args": { "file_path": "...", "old_string": "...", "new_string": "..." }, ... }
{ "type": "tool_result", "tool": "Edit", "result": "...", "lines_changed": ["40-55"], "duration_ms": 42, ... }
```

Full args are available in `hookInput.tool_input`. Full result is available in `hookInput.tool_response`.

### 2. Capture `tool_denied` events

Extend `on-error.js` (the existing PostToolUseFailure hook) to write `tool_denied` events when the user rejects a permission prompt. The hook already fires in this case — it just needs to write the structured event to the audit JSONL.

### 3. Capture `user_prompt` in UserPromptSubmit hook

The `inject-context.js` hook already fires on UserPromptSubmit. Add a `user_prompt` event write there.

### 4. Push transcript JSONL to KV at session end

`session-end.js` already writes the local transcript. Add a step to push the full transcript JSONL to the Worker at:
```
PUT /threads/{thread_id}/transcript
```
This makes AI blame accessible to teammates without local file access.

### 5. Capture `ai_thinking` and `ai_response` from transcript

The local transcript JSONL (Claude Code's own format) contains assistant messages and thinking blocks. At session end, parse these out and include them in the pushed event stream.

### 6. Capture `context_compressed` events

Claude Code emits a context compression event in its transcript. Parse and forward this as a `context_compressed` event — it marks a critical boundary for AI blame (reasoning before and after compression operated on different context).

---

## Remote Session Changes (Cloudflare Worker)

### New `/mcp` endpoint

The Worker exposes an MCP-over-HTTP endpoint at `/mcp` using HTTP+SSE transport. claude.ai connects this as a remote connector in project settings.

Authentication: `X-Sticky-API-Key` header (same as existing Worker auth).

### New write tools

**`open_thread(prompt, branch, user, model, mcp_servers, claude_md_hash)`**
- Creates thread in KV with status `open`
- Writes `session_open` + `user_prompt` events
- Returns `thread_id` for subsequent calls
- Also triggers GitHub REST API commit to add thread to `sticky-note.json`

**`append_event(thread_id, type, data)`**
- Appends one event to the thread's event stream in KV
- `seq` is assigned server-side; implementation uses timestamp ordering as the primary sort key since KV has no native atomic increment (exact mechanism is an implementation detail for the plan phase)
- Called for every action: `ai_thinking`, `ai_response`, `tool_call`, `tool_result`, `tool_error`, `tool_denied`, `context_compressed`, `git_commit`, `subagent_spawn`, `subagent_result`, `checkpoint`
- No git commit on every call — KV only (low latency path)

**`set_checkpoint(thread_id, topic)`**
- Shorthand for `append_event(..., "checkpoint", { topic })`
- Updates thread's active checkpoint label in KV

**`close_thread(thread_id, narrative, work_type, handoff_summary, failed_approaches, files_touched)`**
- Writes `session_close` event
- Updates thread status to `closed` in KV
- Triggers GitHub REST API commit to update `sticky-note.json` with final thread state + all events

### Two-phase commit

- **Fast path (KV):** Every `append_event` writes to KV immediately. Live data always in KV.
- **Slow path (GitHub REST):** `open_thread` and `close_thread` trigger async GitHub REST commits. Events between open and close are flushed to git at close time.
- **Crash recovery:** If `close_thread` never fires (session crash), a background Worker cron job flushes open threads older than 30 minutes to git with status `stale`.

### GitHub REST API commit path

```
GET  /repos/{owner}/{repo}/contents/.sticky-note/sticky-note.json  → read current sha + content
PUT  /repos/{owner}/{repo}/contents/.sticky-note/sticky-note.json  → write updated content + sha
```

Requires a GitHub PAT (fine-grained, contents read+write on the repo) stored as a Worker secret. Added to `init` wizard as an optional step when cloud backend is configured.

---

## KV Storage Schema

```
{project}:thread:{uuid}           → thread metadata (status, files, narrative, etc.)
{project}:thread:{uuid}:events    → ordered event array (full event stream)
{project}:thread:{uuid}:transcript → raw transcript JSONL (local sessions, pushed at close)
```

Events are stored as a JSON array in a single KV value. For very long sessions (>1000 events), the array is chunked: `:events:0`, `:events:1`, etc.

---

## CLAUDE.md Updates

The CLAUDE.md template gains a **Cowork & Mobile Sessions** section instructing Claude to:

1. Call `open_thread` at session start with the verbatim first user prompt
2. Call `append_event` for every action as it happens — not just "meaningful" ones
3. Call `append_event` with `ai_thinking` type to capture reasoning before tool calls
4. Call `set_checkpoint` when the user switches topics
5. Call `close_thread` at session end with full narrative and classification

The instruction is precise enough that Claude follows it without judgment calls about what is "worth" capturing.

---

## Init Wizard Changes

`npx sticky-note init` gains two new prompts when cloud backend is configured:

1. **GitHub PAT** — for REST API commits from the Worker. Stored as Worker secret `GITHUB_PAT`. Repo and owner inferred from `git remote get-url origin`.
2. **Remote MCP connector URL** — outputs the Worker `/mcp` URL + required header (`X-Sticky-API-Key`) for the user to paste into claude.ai project settings.

---

## AI Blame Query Path

Given a file + line number, AI blame resolves:

1. `get-line-attribution --file src/auth.ts --lines 40:55` → returns `thread_id` + `session_id`
2. Fetch `{project}:thread:{uuid}:events` from KV
3. Filter events by timestamp window around the `git_commit` that touched those lines
4. Return the sequence: `user_prompt` → `ai_thinking` → `tool_call` (Edit on that file) → `tool_result`

This gives the full chain: what was asked → how the AI reasoned → what it did → what the result was.

---

## What Is Not Captured

- Tool result content for `Read` calls on large files is truncated to 10KB to avoid KV value size limits. Full content is in the local transcript for local sessions.
- AI blame for lines changed by the user (not the AI) will show no thread — this is correct behavior.
- Secrets are redacted from event data before writing (best-effort pattern matching, same policy as transcript capture today).
