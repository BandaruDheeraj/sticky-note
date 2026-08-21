# Sticky Note — Cowork & Remote Session Full-Fidelity Capture

**Date:** 2026-08-21
**Status:** Draft
**Scope:** Phase 1 — claude.ai cowork and mobile sessions

---

## Problem

Claude Code CLI and Desktop sessions are tracked via hooks that fire automatically and capture granular session data. Sessions in claude.ai cowork or mobile have no equivalent — no hooks fire, no thread is created, and the work disappears.

The existing local audit trail is also too thin for **AI blame** (tracing a line of code back to the prompt, reasoning chain, and tool calls that produced it). The current audit JSONL records tool name + file + line ranges only. Full args, results, AI reasoning, and thinking blocks live only in Claude Code's local transcript, which is not shared with the team.

**This phase delivers:**
1. Full-fidelity event capture for claude.ai cowork sessions, matching the richness of local sessions.
2. Enriched local audit trail that supports AI blame.
3. Unified event schema across both session types.

**Out of scope (Phase 1):** Mobile sessions (auth mechanism unspecified — descoped to Phase 2). Codex app, GitHub Copilot Desktop — adapter interfaces come later.

---

## Architecture

```
Local sessions                        Remote sessions (cowork)
─────────────                         ──────────────────────
Hooks (PostToolUse etc.)              claude.ai remote MCP connector
        │                                       │
        ▼                                       ▼
Enriched audit JSONL              Worker /mcp endpoint (HTTP/SSE)
+ event stream push                      Durable Object (per thread)
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
         Cloudflare KV  ←  event stream (full fidelity, live)
         GitHub REST    ←  thread metadata only (sticky-note.json)
```

Both paths write to the same event schema. AI blame queries either path identically.

**Key constraint:** `sticky-note.json` in git stores thread metadata only (same schema as today — status, narrative, files_touched, etc.). Full event streams live in KV only. This keeps git commits small and avoids the GitHub Contents API 1 MB file limit.

---

## Capture Constraints

These constraints apply to all event writes, both local and remote:

- **tool_result data** is capped at 10 KB per event. Tool results for Read calls on large files are truncated; the full content is available in the local transcript for local sessions.
- **tool_call args** containing file content (Write, Edit) store a diff or content hash, not the full body. Verbatim args are stored for all other tool types.
- **ai_thinking** events are only emitted if the session runtime exposes thinking blocks. For claude.ai cowork, this depends on Anthropic enabling thinking-block visibility to MCP tools — if unavailable, the event type is silently omitted for remote sessions.
- **Secrets** are redacted from all event data before writing (best-effort pattern matching, same policy as transcript capture today).
- **User-authored lines** (not written by the AI) will show no thread in AI blame — this is correct behavior.

---

## Event Schema

Every captured action is stored as a structured event. Events are ordered by `ts` (ISO timestamp with millisecond precision). When two events share the same `ts`, insertion order is the tiebreaker — the Durable Object processes `append_event` calls serially per thread to guarantee this.

### Core fields (all events)

```json
{
  "thread_id": "uuid",
  "session_id": "uuid",
  "ts": "2026-08-21T14:32:00.123Z",
  "type": "<event_type>",
  "data": { ... }
}
```

### Event types

**`session_open`** — first event; captures model, branch, user, mcp_servers, claude_md_hash, sticky_version

**`user_prompt`** — verbatim user message

**`ai_thinking`** — extended thinking block before a response (see capture constraints)

**`ai_response`** — assistant message; data includes content, model, input_tokens, output_tokens, cache_read_tokens

**`tool_call`** — full tool invocation; data includes tool name and full args (see capture constraints for file-content args)

**`tool_result`** — tool output; data includes tool name, result (capped at 10 KB), duration_ms, lines_changed (for write tools)

**`tool_error`** — failed tool call; data includes tool name, args, error message

**`tool_denied`** — user rejected permission prompt; data includes tool name, args, reason

**`context_compressed`** — context window compaction; data includes tokens_before, tokens_after, summary. This marks a critical AI blame boundary — reasoning before and after compression operated on different context.

**`git_commit`** — commit made during the session; data includes sha, message, files, diff_stat

**`subagent_spawn`** — Agent tool invoked; data includes description, agent_type

**`subagent_result`** — Agent tool completed; data includes summary

**`checkpoint`** — topic switch mid-session; data includes topic string

**`session_close`** — final event; data includes narrative, work_type, handoff_summary, failed_approaches, files_touched

---

## KV Storage Schema

```
{project}:thread:{uuid}          → thread metadata (status, narrative, files_touched, etc.)
{project}:thread:{uuid}:events   → ordered event array (full event stream)
```

Events are stored as a JSON array in KV. When the array exceeds 2 MB, it is chunked into sequential keys (`:events:0`, `:events:1`, etc.) — chunked by bytes, not event count, since individual events vary widely in size. Chunk count is stored in thread metadata so readers can fetch all chunks in parallel.

The Durable Object for each thread holds the current events array in memory and flushes to KV in batches (every 10 events or every 5 seconds, whichever comes first), eliminating the read-modify-write hot-key problem.

---

## Local Session Changes

### 1. Enrich `track-work.js` (PostToolUse hook)

**Current:** writes `{ tool, file, lines_changed }`.

**New:** writes full `tool_call` + `tool_result` event pair. Full args are in `hookInput.tool_input`; full result is in `hookInput.tool_response`. Apply capture constraints (diff instead of full body for Write/Edit; 10 KB cap on result).

### 2. Capture `tool_denied` events

Extend `on-error.js` (PostToolUseFailure hook) to write `tool_denied` events when the user rejects a permission prompt. The hook already fires in this case.

### 3. Capture `user_prompt` events

The `inject-context.js` hook already fires on UserPromptSubmit. Add a `user_prompt` event write there with the verbatim prompt content.

### 4. Parse and push AI events from transcript at session end

`session-end.js` already reads the local transcript JSONL. At session end, parse out `ai_thinking`, `ai_response`, and `context_compressed` entries and push them to the Worker event stream via `append_event`. These are not available in hooks directly — only in the transcript.

### 5. Push enriched event stream to KV at session end

After parsing, call the Worker's batch event endpoint to write all events (tool calls already captured by hooks + AI events from transcript) to `{project}:thread:{uuid}:events` in KV. This makes AI blame accessible to teammates via KV, not just from the local audit file.

---

## Remote Session Changes (Cloudflare Worker)

### New `/mcp` endpoint

The Worker exposes an MCP-over-HTTP endpoint at `/mcp` using HTTP+SSE transport. claude.ai connects this as a remote connector in project settings.

Authentication: `X-Sticky-API-Key` header (same as existing Worker auth).

### Durable Object: `StickyThread`

Each thread is backed by a Durable Object instance keyed by thread ID. The Durable Object:
- Holds the in-flight event buffer in memory
- Processes `append_event` calls serially (no concurrent writes, no KV race)
- Flushes to KV in batches on a count or time threshold
- Serializes all GitHub REST writes for the thread, with exponential backoff on 409 conflicts

### New write tools

**`open_thread(prompt, branch, user, model, mcp_servers, claude_md_hash)`**
- Creates thread in KV with status `open` via `StickyThread` DO
- Writes `session_open` + `user_prompt` events
- Returns `thread_id` for subsequent calls
- Triggers async GitHub REST commit to add thread metadata to `sticky-note.json`

**`append_event(thread_id, type, data)`**
- Called for every event in the session — every event type in the schema above, for every action
- "Every action" means every item in the event type list: `user_prompt`, `ai_thinking`, `ai_response`, `tool_call`, `tool_result`, `tool_error`, `tool_denied`, `context_compressed`, `git_commit`, `subagent_spawn`, `subagent_result`, `checkpoint`. Does not include streaming tokens or internal transport retries.
- Routed to the `StickyThread` DO for serialized, batched write to KV
- No GitHub commit per call

**`set_checkpoint(thread_id, topic)`**
- Shorthand: appends a `checkpoint` event and updates the active checkpoint label in thread metadata

**`close_thread(thread_id, ...session_close fields)`**
- Appends a `session_close` event (fields: narrative, work_type, handoff_summary, failed_approaches, files_touched)
- Updates thread status to `closed` in KV
- Triggers async GitHub REST commit to update thread metadata in `sticky-note.json`

### GitHub REST API (metadata only)

```
GET /repos/{owner}/{repo}/contents/.sticky-note/sticky-note.json  → read SHA + content
PUT /repos/{owner}/{repo}/contents/.sticky-note/sticky-note.json  → write metadata + SHA
```

Only thread metadata is committed to git (same fields as `sticky-note.json` today). Full event streams stay in KV. The `StickyThread` DO serializes all GET+PUT calls for its thread, preventing 409 conflicts. Requires a GitHub PAT (fine-grained, contents read+write) stored as Worker secret `GITHUB_PAT`.

If the GitHub PUT fails after retries, the Worker returns an error to the caller. Events remain in KV and will be retried by the recovery cron. If retries are exhausted, thread status is set to `lost` in KV metadata.

### Crash recovery

If `close_thread` never fires (session crash or timeout), a Worker cron job runs every 5 minutes and flushes open threads older than 30 minutes to git with status `stale`. The cron writes a synthetic `session_close` event with `narrative='[recovered by cron]'` and `work_type='unknown'`. It reads all KV event chunks for the thread and commits the metadata to git. The cron uses exponential backoff on GitHub 409s and records `last_recovery_attempt` in thread metadata to avoid redundant retries.

---

## CLAUDE.md Updates — Project-Level System Prompt

The following instructions go into the **claude.ai project-level system prompt** for the cowork connector project, not into the repo CLAUDE.md template. They do not apply to local hook-driven sessions (hooks handle those automatically).

1. Call `open_thread` at session start with the verbatim first user prompt
2. Call `append_event` for every event in the event type list as it happens
3. Call `set_checkpoint` when the user switches topics mid-session
4. Call `close_thread` at session end with full narrative and classification

---

## Init Wizard Changes

`npx sticky-note init` gains two new steps when cloud backend is configured:

1. **GitHub PAT** — collected and stored as Worker secret `GITHUB_PAT` (check if already set before prompting). Repo and owner inferred from `git remote get-url origin`. KV project key derived from repo full name (e.g., `acme/frontend` → `acme-frontend`) to prevent namespace collisions on shared Worker instances.

2. **Remote MCP connector URL** — outputs the Worker `/mcp` URL + `X-Sticky-API-Key` header value for the user to paste into claude.ai project settings. The API key identifies the repository; user attribution in events is advisory and relies on the caller-supplied `user` field in `open_thread`.

---

## AI Blame Query Path

Given a file + line number:

1. `get-line-attribution --file src/auth.ts --lines 40:55` → returns `thread_id`
2. Fetch all `{project}:thread:{uuid}:events` chunks from KV in parallel
3. Find the `git_commit` event whose `files` includes `src/auth.ts`
4. Walk backwards from that `git_commit` timestamp to find the most recent `tool_call` that modified the same file
5. Return the surrounding chain: `user_prompt` → `ai_thinking` → `tool_call` → `tool_result`

This gives the full sequence: what was asked → how the AI reasoned → what it did → what the result was.
