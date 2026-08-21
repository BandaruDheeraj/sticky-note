# Worker Remote MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Durable Object-backed `/mcp` endpoint to the Cloudflare Worker so claude.ai cowork sessions can open threads, append events, and close threads via remote MCP — writing to KV in real time and committing thread metadata to git via the GitHub REST API.

**Architecture:** A `StickyThread` Durable Object owns all state for one thread — it holds the in-flight event buffer in memory, batches KV writes, and serializes GitHub REST commits. The Worker's `/mcp` endpoint speaks MCP-over-HTTP and exposes four write tools (`open_thread`, `append_event`, `set_checkpoint`, `close_thread`) plus all existing read tools. A cron job flushes stale open threads every 5 minutes. The init wizard gains two new prompts: GitHub PAT collection and MCP connector URL output.

**Depends on:** Plan 1 (local-event-enrichment) for the event schema constants.

**Tech Stack:** Cloudflare Workers (ESM), Durable Objects, KV, Cron Triggers, GitHub REST API v3. Tests use Miniflare (already used for Worker tests if present) or a manual fetch-based test against a local wrangler dev server.

## Global Constraints

- Worker is ESM (`import`/`export`) — do not use `require()`
- All DO requests must complete within Workers CPU time limits (avoid blocking loops)
- KV writes are eventually consistent — DO is the authoritative in-memory state during a session
- GitHub REST commit uses SHA-based optimistic locking; retry on 409 up to 3 times with 200ms backoff
- `sticky-note.json` stores thread metadata only — no event arrays in git
- Event arrays in KV: chunked at 2 MB per key; chunk count stored in thread metadata
- Auth: `X-Sticky-API-Key` header for all Worker endpoints (existing pattern)
- Project namespace in KV: derived from repo full name (`owner/repo` → `owner-repo`), not from user-supplied project field

---

### Task 1: Add `/threads/{id}/events` endpoint to Worker (receive local event stream)

**Files:**
- Modify: `sticky-server/worker.js`
- Modify: `sticky-server/adapters/cf-kv.js`

**Interfaces:**
- Produces:
  - `POST /threads/{id}/events` — accepts `{ events: [...] }`, appends to `{project}:thread:{id}:events` in KV
  - `GET /threads/{id}/events` — returns full event array (all chunks merged)
  - `appendEvents(kv, project, threadId, events)` in cf-kv.js → void
  - `getEvents(kv, project, threadId)` → array of event objects

**Background:** This is the receiving end for Plan 1's session-end.js push. Events arrive as a batch at session end from local sessions. This task adds the REST endpoint; the DO-backed path for remote sessions comes in Task 3.

- [ ] **Step 1: Add `appendEvents` and `getEvents` to `cf-kv.js`**

```js
// In sticky-server/adapters/cf-kv.js

const MAX_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB per KV value

export async function getEvents(kv, project, threadId) {
  const metaKey = `${project}:thread:${threadId}`;
  const meta = await kv.get(metaKey, { type: "json" }).catch(() => null);
  const chunkCount = (meta && meta._event_chunks) || 0;

  if (chunkCount === 0) {
    // Try legacy single-key format
    const single = await kv.get(`${metaKey}:events`, { type: "json" }).catch(() => null);
    return Array.isArray(single) ? single : [];
  }

  const chunks = await Promise.all(
    Array.from({ length: chunkCount }, (_, i) =>
      kv.get(`${metaKey}:events:${i}`, { type: "json" }).catch(() => [])
    )
  );
  return chunks.flat().filter(Boolean);
}

export async function appendEvents(kv, project, threadId, newEvents) {
  if (!newEvents || newEvents.length === 0) return;

  const metaKey = `${project}:thread:${threadId}`;
  const meta = await kv.get(metaKey, { type: "json" }).catch(() => ({}));
  const chunkCount = (meta && meta._event_chunks) || 0;

  let currentChunkIdx = chunkCount === 0 ? 0 : chunkCount - 1;
  let currentChunk = [];
  if (chunkCount > 0) {
    currentChunk = await kv.get(`${metaKey}:events:${currentChunkIdx}`, { type: "json" })
      .catch(() => []) || [];
  }

  for (const event of newEvents) {
    const eventBytes = new TextEncoder().encode(JSON.stringify(event)).length;
    const chunkBytes = new TextEncoder().encode(JSON.stringify(currentChunk)).length;
    if (chunkBytes + eventBytes > MAX_CHUNK_BYTES && currentChunk.length > 0) {
      await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));
      currentChunkIdx++;
      currentChunk = [];
    }
    currentChunk.push(event);
  }
  await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));

  // Update chunk count in thread metadata
  const newMeta = { ...(meta || {}), _event_chunks: currentChunkIdx + 1 };
  await kv.put(metaKey, JSON.stringify(newMeta));
}
```

- [ ] **Step 2: Add route and handler to `worker.js`**

In `matchRoute()`, add:
```js
if (method === "POST" && pathname.match(/^\/threads\/[^/]+\/events$/)) {
  const id = pathname.split("/")[2];
  return { handler: "appendThreadEvents", id };
}
if (method === "GET" && pathname.match(/^\/threads\/[^/]+\/events$/)) {
  const id = pathname.split("/")[2];
  return { handler: "getThreadEvents", id };
}
```

Add handlers in the `switch(route.handler)` block:
```js
case "appendThreadEvents": {
  const body = await request.json().catch(() => ({}));
  const events = Array.isArray(body.events) ? body.events : [];
  await adapter.appendEvents(env.STICKY_KV, project, route.id, events);
  return json({ ok: true, appended: events.length });
}
case "getThreadEvents": {
  const events = await adapter.getEvents(env.STICKY_KV, project, route.id);
  return json({ events });
}
```

- [ ] **Step 3: Test with curl against wrangler dev**

```bash
cd sticky-server
npx wrangler dev --port 8787 &
sleep 3

# Create a thread first
curl -s -X POST http://localhost:8787/threads \
  -H "Content-Type: application/json" \
  -d '{"id":"test-thread-1","status":"open","user":"dheer"}' | jq .

# Push events
curl -s -X POST http://localhost:8787/threads/test-thread-1/events \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"tool_call","ts":"2026-08-21T10:00:00Z","data":{"tool":"Read"}}]}' | jq .

# Read them back
curl -s http://localhost:8787/threads/test-thread-1/events | jq .events[0].type
# Expected: "tool_call"

kill %1
```

- [ ] **Step 4: Commit**

```bash
git add sticky-server/worker.js sticky-server/adapters/cf-kv.js
git commit -m "feat: add /threads/{id}/events endpoint for local session event stream push"
```

---

### Task 2: Create `StickyThread` Durable Object

**Files:**
- Create: `sticky-server/sticky-thread-do.js`
- Modify: `sticky-server/wrangler.toml`
- Modify: `sticky-server/worker.js` (export the DO class)

**Interfaces:**
- Produces:
  - `StickyThread` class with `fetch(request)` handler
  - Internal routes (called by Worker, not external clients):
    - `POST /do/open` — initialize thread, buffer session_open + user_prompt events
    - `POST /do/append` — append one event to buffer; flush to KV on threshold
    - `POST /do/close` — flush all buffered events to KV, write session_close event
    - `POST /do/github-commit` — serialize GitHub REST GET+PUT
  - `getOrCreateDO(env, threadId)` helper in worker.js → DO stub

**Background:** The DO provides single-writer semantics per thread. All event appends for a given thread go through one DO instance, eliminating KV concurrent-write races. The DO holds events in memory and flushes to KV every 10 events or 5 seconds (using an alarm).

- [ ] **Step 1: Create `sticky-thread-do.js`**

```js
// sticky-server/sticky-thread-do.js
export class StickyThread {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buffer = [];
    this.flushThreshold = 10;
    this.threadId = null;
    this.project = "default";
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === "/do/open") {
      this.threadId = body.thread_id;
      this.project = body.project || "default";
      for (const ev of (body.events || [])) this.buffer.push(ev);
      await this._scheduleFlush();
      return new Response(JSON.stringify({ ok: true, thread_id: this.threadId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/append") {
      const event = body.event;
      if (event) this.buffer.push(event);
      if (this.buffer.length >= this.flushThreshold) {
        await this._flush();
      } else {
        await this._scheduleFlush();
      }
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/close") {
      const closeEvent = body.close_event;
      if (closeEvent) this.buffer.push(closeEvent);
      await this._flush();
      // Cancel pending alarm
      try { await this.state.storage.deleteAlarm(); } catch (_) {}
      return new Response(JSON.stringify({ ok: true, flushed: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/do/github-commit") {
      // Serialized GitHub REST write for this thread
      const result = await this._githubCommit(body);
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
        status: result.ok ? 200 : 500,
      });
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    // Alarm fires after 5s inactivity — flush buffered events
    if (this.buffer.length > 0) {
      await this._flush();
    }
  }

  async _scheduleFlush() {
    try {
      const existing = await this.state.storage.getAlarm();
      if (!existing) {
        await this.state.storage.setAlarm(Date.now() + 5000);
      }
    } catch (_) {}
  }

  async _flush() {
    if (this.buffer.length === 0 || !this.threadId) return;
    const toFlush = this.buffer.splice(0);
    try {
      const kv = this.env.STICKY_KV;
      const metaKey = `${this.project}:thread:${this.threadId}`;
      const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

      const meta = await kv.get(metaKey, { type: "json" }).catch(() => ({})) || {};
      let chunkCount = meta._event_chunks || 0;
      let currentChunkIdx = chunkCount === 0 ? 0 : chunkCount - 1;
      let currentChunk = chunkCount > 0
        ? (await kv.get(`${metaKey}:events:${currentChunkIdx}`, { type: "json" }).catch(() => []) || [])
        : [];

      for (const event of toFlush) {
        const eventBytes = new TextEncoder().encode(JSON.stringify(event)).length;
        const chunkBytes = new TextEncoder().encode(JSON.stringify(currentChunk)).length;
        if (chunkBytes + eventBytes > MAX_CHUNK_BYTES && currentChunk.length > 0) {
          await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));
          currentChunkIdx++;
          currentChunk = [];
        }
        currentChunk.push(event);
      }
      await kv.put(`${metaKey}:events:${currentChunkIdx}`, JSON.stringify(currentChunk));
      meta._event_chunks = currentChunkIdx + 1;
      await kv.put(metaKey, JSON.stringify(meta));
    } catch (err) {
      // Put unwritten events back at front of buffer for retry
      this.buffer.unshift(...toFlush);
    }
  }

  async _githubCommit(body) {
    const { owner, repo, path: filePath, content, message, pat } = body;
    if (!pat) return { ok: false, error: "no PAT" };
    const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "sticky-note-worker",
    };

    let sha = null;
    let retries = 3;
    while (retries-- > 0) {
      // GET current SHA
      const getResp = await fetch(apiBase, { headers }).catch(() => null);
      if (getResp && getResp.ok) {
        const data = await getResp.json().catch(() => ({}));
        sha = data.sha || null;
      }

      // PUT with SHA
      const putBody = {
        message,
        content: btoa(unescape(encodeURIComponent(content))), // base64 encode UTF-8
        ...(sha ? { sha } : {}),
      };
      const putResp = await fetch(apiBase, {
        method: "PUT",
        headers,
        body: JSON.stringify(putBody),
      }).catch(() => null);

      if (!putResp) return { ok: false, error: "network error" };
      if (putResp.ok) return { ok: true };
      if (putResp.status === 409) {
        // SHA mismatch — retry after backoff
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      const errBody = await putResp.json().catch(() => ({}));
      return { ok: false, error: errBody.message || `HTTP ${putResp.status}` };
    }
    return { ok: false, error: "max retries exceeded (409 conflict)" };
  }
}
```

- [ ] **Step 2: Register DO in `wrangler.toml`**

Add to `sticky-server/wrangler.toml`:
```toml
[durable_objects]
bindings = [
  { name = "STICKY_THREAD", class_name = "StickyThread" }
]

[[migrations]]
tag = "v1"
new_classes = ["StickyThread"]
```

- [ ] **Step 3: Export DO from `worker.js`**

At the bottom of `worker.js`, add:
```js
export { StickyThread } from "./sticky-thread-do.js";
```

- [ ] **Step 4: Add `getOrCreateDO` helper to `worker.js`**

```js
function getOrCreateDO(env, threadId) {
  const id = env.STICKY_THREAD.idFromName(threadId);
  return env.STICKY_THREAD.get(id);
}
```

- [ ] **Step 5: Test DO with wrangler dev**

```bash
cd sticky-server
npx wrangler dev --port 8787 &
sleep 3

# Open a thread via DO
curl -s -X POST http://localhost:8787/do-open \
  -H "Content-Type: application/json" \
  -d '{"thread_id":"do-test-1","project":"default","events":[{"type":"session_open","ts":"2026-08-21T10:00:00Z","data":{}}]}' | jq .
# (Route added in Task 3 — just verify DO instantiates without error here)

kill %1
```

Expected: No worker startup errors; DO class registered.

- [ ] **Step 6: Commit**

```bash
git add sticky-server/sticky-thread-do.js sticky-server/wrangler.toml sticky-server/worker.js
git commit -m "feat: add StickyThread Durable Object with batched KV flush and GitHub commit serialization"
```

---

### Task 3: Add MCP write tools — `open_thread` and `append_event`

**Files:**
- Create: `sticky-server/mcp-tools.js`
- Modify: `sticky-server/worker.js` (add `/mcp` route + wire tools)

**Interfaces:**
- Consumes: `StickyThread` DO (via `getOrCreateDO`), `env.GITHUB_PAT`, `env.GITHUB_REPO` (format: `owner/repo`)
- Produces:
  - MCP tool `open_thread(prompt, branch, user, model, mcp_servers, claude_md_hash)` → `{ thread_id }`
  - MCP tool `append_event(thread_id, type, data)` → `{ ok: true }`
  - `/mcp` HTTP endpoint returning MCP tool list on GET, dispatching tool calls on POST

**Background:** The MCP protocol over HTTP is simple: GET `/mcp` returns `{ tools: [...] }`; POST `/mcp` with `{ tool: "name", input: {...} }` returns `{ content: [...] }`. No SSE needed for this subset — cowork sessions can use the streamable HTTP transport. The full SSE transport is a follow-up.

- [ ] **Step 1: Create `sticky-server/mcp-tools.js`**

```js
// sticky-server/mcp-tools.js

import crypto from "node:crypto"; // available in Workers via compatibility flags

export const MCP_TOOL_DEFINITIONS = [
  {
    name: "open_thread",
    description: "Call at session start. Creates a new thread and returns its thread_id for use in subsequent append_event and close_thread calls.",
    inputSchema: {
      type: "object",
      properties: {
        prompt:         { type: "string", description: "Verbatim first user prompt" },
        branch:         { type: "string", description: "Current git branch" },
        user:           { type: "string", description: "Username" },
        model:          { type: "string", description: "Model ID (e.g. claude-sonnet-4-6)" },
        mcp_servers:    { type: "array", items: { type: "string" }, description: "Connected MCP server names" },
        claude_md_hash: { type: "string", description: "SHA256 of CLAUDE.md content (optional)" },
      },
      required: ["prompt", "user"],
    },
  },
  {
    name: "append_event",
    description: "Call for every action in the session. Records one event (user_prompt, ai_thinking, ai_response, tool_call, tool_result, tool_error, tool_denied, context_compressed, git_commit, subagent_spawn, subagent_result, checkpoint). Do not call for streaming tokens or internal transport retries.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "thread_id returned by open_thread" },
        type:      { type: "string", description: "Event type (see description)" },
        data:      { type: "object", description: "Event-specific payload" },
      },
      required: ["thread_id", "type", "data"],
    },
  },
  {
    name: "set_checkpoint",
    description: "Call when the user switches to a different topic mid-session. Marks subsequent events with the new topic for attribution.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        topic:     { type: "string", description: "Short description of new work topic" },
      },
      required: ["thread_id", "topic"],
    },
  },
  {
    name: "close_thread",
    description: "Call at session end. Writes the session_close event, updates thread status to closed, and triggers a git commit of thread metadata.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id:        { type: "string" },
        narrative:        { type: "string", description: "Summary of what was accomplished" },
        work_type:        { type: "string", description: "e.g. bug-fix, feature-development, debugging, refactor, documentation" },
        handoff_summary:  { type: "string", description: "Notes for teammates picking this up" },
        failed_approaches:{ type: "array", items: { type: "string" }, description: "What was tried and didn't work" },
        files_touched:    { type: "array", items: { type: "string" }, description: "Files modified during session" },
      },
      required: ["thread_id", "narrative"],
    },
  },
];

export async function handleMcpTool(toolName, input, env, project) {
  switch (toolName) {
    case "open_thread": return handleOpenThread(input, env, project);
    case "append_event": return handleAppendEvent(input, env, project);
    case "set_checkpoint": return handleSetCheckpoint(input, env, project);
    case "close_thread": return handleCloseThread(input, env, project);
    default: throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleOpenThread(input, env, project) {
  const threadId = crypto.randomUUID();
  const now = new Date().toISOString();

  const threadMeta = {
    id: threadId,
    status: "open",
    user: input.user,
    branch: input.branch || "",
    created_at: now,
    last_activity_at: now,
    files_touched: [],
    narrative: "",
    tool: "claude-code",
    session_id: null, // remote sessions don't have a local session_id
    _event_chunks: 0,
  };

  const metaKey = `${project}:thread:${threadId}`;
  await env.STICKY_KV.put(metaKey, JSON.stringify(threadMeta));

  const openEvent = {
    ts: now, type: "session_open", session_id: null,
    data: {
      model: input.model || null,
      branch: input.branch || null,
      user: input.user,
      mcp_servers: input.mcp_servers || [],
      claude_md_hash: input.claude_md_hash || null,
    },
  };
  const promptEvent = {
    ts: now, type: "user_prompt", session_id: null,
    data: { content: input.prompt },
  };

  const do_stub = getOrCreateDO_internal(env, threadId);
  await do_stub.fetch(new Request("http://do/do/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, project, events: [openEvent, promptEvent] }),
  }));

  // Async GitHub commit — fire and forget
  _commitThreadToGit(env, project, threadId, threadMeta).catch(() => {});

  return { thread_id: threadId };
}

async function handleAppendEvent(input, env, project) {
  const { thread_id, type, data } = input;
  const event = { ts: new Date().toISOString(), type, session_id: null, data: data || {} };

  // Update last_activity_at in thread meta
  const metaKey = `${project}:thread:${thread_id}`;
  const meta = await env.STICKY_KV.get(metaKey, { type: "json" }).catch(() => null);
  if (meta) {
    meta.last_activity_at = event.ts;
    // Track files_touched from tool_result events
    if (type === "tool_result" && Array.isArray(data.lines_changed)) {
      const file = data.file || (data.args && data.args.file_path);
      if (file && !meta.files_touched.includes(file)) meta.files_touched.push(file);
    }
    await env.STICKY_KV.put(metaKey, JSON.stringify(meta));
  }

  const do_stub = getOrCreateDO_internal(env, thread_id);
  await do_stub.fetch(new Request("http://do/do/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  }));

  return { ok: true };
}

async function handleSetCheckpoint(input, env, project) {
  return handleAppendEvent(
    { thread_id: input.thread_id, type: "checkpoint", data: { topic: input.topic } },
    env, project
  );
}

async function handleCloseThread(input, env, project) {
  const { thread_id, narrative, work_type, handoff_summary, failed_approaches, files_touched } = input;
  const now = new Date().toISOString();

  const closeEvent = {
    ts: now, type: "session_close", session_id: null,
    data: { narrative, work_type: work_type || "general", handoff_summary: handoff_summary || "", failed_approaches: failed_approaches || [], files_touched: files_touched || [] },
  };

  const do_stub = getOrCreateDO_internal(env, thread_id);
  await do_stub.fetch(new Request("http://do/do/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ close_event: closeEvent }),
  }));

  // Update thread metadata
  const metaKey = `${project}:thread:${thread_id}`;
  const meta = await env.STICKY_KV.get(metaKey, { type: "json" }).catch(() => ({})) || {};
  meta.status = "closed";
  meta.closed_at = now;
  meta.narrative = narrative;
  meta.work_type = work_type || "general";
  meta.handoff_summary = handoff_summary || "";
  meta.failed_approaches = failed_approaches || [];
  if (files_touched) {
    meta.files_touched = [...new Set([...(meta.files_touched || []), ...files_touched])];
  }
  await env.STICKY_KV.put(metaKey, JSON.stringify(meta));

  // GitHub commit — if PAT configured, sync metadata to sticky-note.json
  await _commitThreadToGit(env, project, thread_id, meta);

  return { ok: true };
}

// Internal helper — not exported; used by both open and close
async function _commitThreadToGit(env, project, threadId, threadMeta) {
  const pat = env.GITHUB_PAT;
  const repoFull = env.GITHUB_REPO; // format: "owner/repo"
  if (!pat || !repoFull) return;
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) return;

  const kv = env.STICKY_KV;

  // Read current sticky-note.json
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/.sticky-note/sticky-note.json`;
  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "sticky-note-worker",
    "Content-Type": "application/json",
  };

  const do_stub = getOrCreateDO_internal(env, threadId);
  // Build the updated sticky-note.json content (metadata only, no events)
  const threadsListKey = `${project}:threads_index`;
  let threadIds = await kv.get(threadsListKey, { type: "json" }).catch(() => []) || [];
  if (!threadIds.includes(threadId)) {
    threadIds = [threadId, ...threadIds].slice(0, 500); // cap at 500
    await kv.put(threadsListKey, JSON.stringify(threadIds));
  }

  const allMeta = await Promise.all(
    threadIds.map(id => kv.get(`${project}:thread:${id}`, { type: "json" }).catch(() => null))
  );
  const threads = allMeta.filter(Boolean).map(m => {
    // Strip internal KV fields before writing to git
    const { _event_chunks, ...rest } = m;
    return rest;
  });

  const newContent = JSON.stringify({ version: "2", project, threads }, null, 2) + "\n";

  await do_stub.fetch(new Request("http://do/do/github-commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      owner, repo,
      path: ".sticky-note/sticky-note.json",
      content: newContent,
      message: `chore(sticky-note): sync thread ${threadId.slice(0, 8)}`,
      pat,
    }),
  }));
}

// Module-level DO accessor (set by worker.js after binding is available)
let _getOrCreateDO = null;
export function setDOAccessor(fn) { _getOrCreateDO = fn; }
function getOrCreateDO_internal(env, threadId) {
  if (_getOrCreateDO) return _getOrCreateDO(env, threadId);
  throw new Error("DO accessor not initialized");
}
```

- [ ] **Step 2: Add `/mcp` route to `worker.js`**

In `matchRoute()`:
```js
if (method === "GET" && pathname === "/mcp") return { handler: "mcpListTools" };
if (method === "POST" && pathname === "/mcp") return { handler: "mcpCallTool" };
```

In `fetch()` handler, add the DO accessor initialization before the switch:
```js
import { MCP_TOOL_DEFINITIONS, handleMcpTool, setDOAccessor } from "./mcp-tools.js";
// At top of fetch():
setDOAccessor(getOrCreateDO);
```

Add cases to switch:
```js
case "mcpListTools":
  return json({ tools: MCP_TOOL_DEFINITIONS });

case "mcpCallTool": {
  const body = await request.json().catch(() => ({}));
  const toolName = body.tool || body.name;
  const toolInput = body.input || body.arguments || {};
  if (!toolName) return error("tool name required");
  try {
    const result = await handleMcpTool(toolName, toolInput, env, project);
    return json({ content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (err) {
    return error(err.message, 400);
  }
}
```

- [ ] **Step 3: Test with curl**

```bash
cd sticky-server
npx wrangler dev --port 8787 &
sleep 3

# List tools
curl -s http://localhost:8787/mcp | jq '.tools[].name'
# Expected: "open_thread", "append_event", "set_checkpoint", "close_thread"

# Open a thread
THREAD=$(curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"tool":"open_thread","input":{"prompt":"fix the auth bug","user":"dheer","branch":"main"}}' | jq -r '.content[0].text | fromjson.thread_id')
echo "Thread: $THREAD"

# Append an event
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d "{\"tool\":\"append_event\",\"input\":{\"thread_id\":\"$THREAD\",\"type\":\"tool_call\",\"data\":{\"tool\":\"Read\",\"args\":{\"file_path\":\"src/auth.ts\"}}}}" | jq .

# Verify events stored
curl -s "http://localhost:8787/threads/$THREAD/events" | jq '.events | length'
# Expected: 3 (session_open, user_prompt, tool_call)

kill %1
```

- [ ] **Step 4: Commit**

```bash
git add sticky-server/mcp-tools.js sticky-server/worker.js
git commit -m "feat: add /mcp endpoint with open_thread and append_event write tools"
```

---

### Task 4: Complete MCP write tools — `set_checkpoint` and `close_thread` + GitHub commit

**Files:**
- Already in `mcp-tools.js` from Task 3
- Modify: `sticky-server/worker.js` — add `GITHUB_PAT` and `GITHUB_REPO` to wrangler secrets docs
- Modify: `sticky-server/wrangler.toml` — document secret vars

**Interfaces:**
- Consumes: `env.GITHUB_PAT`, `env.GITHUB_REPO` (Worker secrets set via `wrangler secret put`)
- Produces: `close_thread` commits thread metadata to `sticky-note.json` in git via GitHub REST API (through `StickyThread` DO for serialization)

- [ ] **Step 1: End-to-end test with close_thread**

```bash
cd sticky-server
npx wrangler dev --port 8787 &
sleep 3

THREAD=$(curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"tool":"open_thread","input":{"prompt":"close test","user":"dheer","branch":"main"}}' | jq -r '.content[0].text | fromjson.thread_id')

curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -d "{\"tool\":\"close_thread\",\"input\":{\"thread_id\":\"$THREAD\",\"narrative\":\"Fixed the bug\",\"work_type\":\"bug-fix\",\"files_touched\":[\"src/auth.ts\"]}}" | jq .
# Expected: {"content":[{"type":"text","text":"{\"ok\":true}"}]}

# Verify thread metadata updated in KV
curl -s "http://localhost:8787/threads/$THREAD" | jq '{status:.status, narrative:.narrative}'
# Expected: {"status":"closed","narrative":"Fixed the bug"}

kill %1
```

- [ ] **Step 2: Document secrets in `wrangler.toml`**

Add comment block:
```toml
# Required secrets (set via `wrangler secret put`):
#   STICKY_API_KEY  — API key for X-Sticky-API-Key auth
#   GITHUB_PAT      — Fine-grained PAT with Contents read+write on the target repo
#   GITHUB_REPO     — Target repo in "owner/repo" format (e.g. "acme/frontend")
```

- [ ] **Step 3: Commit**

```bash
git add sticky-server/wrangler.toml
git commit -m "feat: close_thread + GitHub REST commit path documented and wired"
```

---

### Task 5: Crash recovery cron

**Files:**
- Modify: `sticky-server/worker.js` (add `scheduled` handler)
- Modify: `sticky-server/wrangler.toml` (add cron trigger)

**Interfaces:**
- Produces: `scheduled` export that runs every 5 minutes; flushes open threads older than 30 minutes to closed/stale status in KV and triggers GitHub commit

- [ ] **Step 1: Add cron to `wrangler.toml`**

```toml
[triggers]
crons = ["*/5 * * * *"]
```

- [ ] **Step 2: Add `scheduled` handler to `worker.js`**

```js
export default {
  async fetch(request, env, ctx) {
    // ... existing fetch handler ...
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCrashRecovery(env));
  },
};

async function runCrashRecovery(env) {
  const projects = ["default"]; // TODO: discover from KV index if multi-project
  const staleThresholdMs = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  for (const project of projects) {
    const threadsListKey = `${project}:threads_index`;
    const threadIds = await env.STICKY_KV.get(threadsListKey, { type: "json" })
      .catch(() => []) || [];

    for (const threadId of threadIds) {
      const metaKey = `${project}:thread:${threadId}`;
      const meta = await env.STICKY_KV.get(metaKey, { type: "json" }).catch(() => null);
      if (!meta || meta.status !== "open") continue;

      const lastActivity = new Date(meta.last_activity_at || meta.created_at).getTime();
      if (now - lastActivity < staleThresholdMs) continue;

      // Thread is stale — flush DO buffer and mark as stale
      try {
        const do_stub = getOrCreateDO(env, threadId);
        const recovery_event = {
          ts: new Date().toISOString(), type: "session_close", session_id: null,
          data: { narrative: "[recovered by cron]", work_type: "unknown", handoff_summary: "", failed_approaches: [], files_touched: [] },
        };
        // Track last_recovery_attempt to avoid hammering
        const lastAttempt = meta._last_recovery_attempt || 0;
        if (now - lastAttempt < 5 * 60 * 1000) continue; // skip if tried < 5min ago

        meta._last_recovery_attempt = now;
        await env.STICKY_KV.put(metaKey, JSON.stringify(meta));

        await do_stub.fetch(new Request("http://do/do/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ close_event: recovery_event }),
        }));

        meta.status = "stale";
        meta.last_activity_at = new Date().toISOString();
        await env.STICKY_KV.put(metaKey, JSON.stringify(meta));

        // GitHub commit for stale thread
        await import("./mcp-tools.js").then(({ handleMcpTool, setDOAccessor }) => {
          setDOAccessor(getOrCreateDO);
          return handleMcpTool("close_thread", {
            thread_id: threadId,
            narrative: "[recovered by cron]",
            work_type: "unknown",
          }, env, project);
        }).catch(() => {});
      } catch (_) {
        // best-effort — log to console for observability
        console.error(`[sticky-note] crash recovery failed for thread ${threadId}`);
      }
    }
  }
}
```

- [ ] **Step 3: Verify cron registers**

```bash
cd sticky-server
npx wrangler deploy --dry-run 2>&1 | grep -i cron
# Expected: mentions cron schedule */5 * * * *
```

- [ ] **Step 4: Commit**

```bash
git add sticky-server/worker.js sticky-server/wrangler.toml
git commit -m "feat: add 5-minute cron for stale thread crash recovery"
```

---

### Task 6: Init wizard — GitHub PAT + MCP connector URL

**Files:**
- Modify: `bin/cli.js` (or wherever `init` command is implemented — find with `grep -r "init" bin/ --include="*.js" -l`)

**Interfaces:**
- Produces:
  - New init prompt: "GitHub PAT for Worker git commits" (stored via `wrangler secret put GITHUB_PAT`)
  - New init prompt: "GitHub repo (owner/repo)" (stored via `wrangler secret put GITHUB_REPO`)
  - New init output: prints MCP connector setup instructions with Worker URL + header

- [ ] **Step 1: Find the init command file**

```bash
grep -r "GitHub\|wrangler secret\|init" bin/ --include="*.js" -l
```

- [ ] **Step 2: Add GitHub PAT prompt and connector URL output**

After the existing cloud backend prompts in the init flow, add:

```js
// After STICKY_API_KEY collection, if cloud backend was configured:
if (workerUrl) {
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(res => rl.question(q, res));

  const pat = await ask(
    "\nOptional: GitHub PAT for Worker → git commits (enables remote cowork session tracking).\n" +
    "Create at https://github.com/settings/tokens/new (fine-grained, Contents read+write).\n" +
    "PAT (leave blank to skip): "
  );

  if (pat && pat.trim()) {
    const repo = await ask("GitHub repo in owner/repo format (e.g. acme/frontend): ");
    if (repo && repo.trim().includes("/")) {
      // Store via wrangler secret
      const { execSync } = require("child_process");
      try {
        execSync(`wrangler secret put GITHUB_PAT`, { input: pat.trim(), stdio: ["pipe", "inherit", "inherit"] });
        execSync(`wrangler secret put GITHUB_REPO`, { input: repo.trim(), stdio: ["pipe", "inherit", "inherit"] });
        console.log("  ✓ GitHub PAT and repo stored as Worker secrets");
      } catch (_) {
        console.log("  ⚠ Could not store secrets via wrangler — set manually:");
        console.log(`    wrangler secret put GITHUB_PAT`);
        console.log(`    wrangler secret put GITHUB_REPO  # value: ${repo.trim()}`);
      }
    }
  }
  rl.close();

  // Always print connector instructions if Worker URL is configured
  const apiKey = existingConfig.sticky_url_api_key || "";
  console.log("\n── claude.ai Cowork MCP Connector ──────────────────────────");
  console.log("To track cowork sessions, add this connector in claude.ai project settings:");
  console.log(`  URL:    ${workerUrl}/mcp`);
  if (apiKey) {
    console.log(`  Header: X-Sticky-API-Key: ${apiKey}`);
  }
  console.log("\nThe CLAUDE.md project system prompt (paste into claude.ai project instructions):");
  console.log("  1. Call open_thread at session start with the verbatim first user prompt");
  console.log("  2. Call append_event for every action: ai_thinking, ai_response, tool_call,");
  console.log("     tool_result, tool_error, tool_denied, context_compressed, git_commit,");
  console.log("     subagent_spawn, subagent_result, checkpoint");
  console.log("  3. Call set_checkpoint when the user switches topics");
  console.log("  4. Call close_thread at session end with narrative and work_type");
  console.log("────────────────────────────────────────────────────────────\n");
}
```

- [ ] **Step 3: Run init and verify output**

```bash
# In a test repo with Worker URL configured:
npx sticky-note init 2>&1 | grep -A5 "claude.ai Cowork"
# Expected: connector URL and instructions printed
```

- [ ] **Step 4: Commit**

```bash
git add bin/cli.js  # or whichever file was modified
git commit -m "feat: init wizard adds GitHub PAT collection and MCP connector URL output"
```

---

### Task 7: Deploy and end-to-end test

**Files:** No code changes — verification only.

- [ ] **Step 1: Deploy Worker**

```bash
cd sticky-server
npx wrangler deploy
```

Expected: deploy succeeds, prints Worker URL.

- [ ] **Step 2: Verify `/mcp` endpoint is live**

```bash
WORKER_URL="https://sticky-<project>.sticky-server.workers.dev"
curl -s "${WORKER_URL}/mcp" -H "X-Sticky-API-Key: ${API_KEY}" | jq '.tools[].name'
# Expected: open_thread, append_event, set_checkpoint, close_thread (+ existing read tools)
```

- [ ] **Step 3: Simulate a cowork session end-to-end**

```bash
# Open thread
THREAD=$(curl -s -X POST "${WORKER_URL}/mcp" \
  -H "X-Sticky-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"tool":"open_thread","input":{"prompt":"test cowork session","user":"dheer","branch":"main","model":"claude-sonnet-4-6"}}' \
  | jq -r '.content[0].text | fromjson.thread_id')

# Append events
curl -s -X POST "${WORKER_URL}/mcp" \
  -H "X-Sticky-API-Key: ${API_KEY}" -H "Content-Type: application/json" \
  -d "{\"tool\":\"append_event\",\"input\":{\"thread_id\":\"$THREAD\",\"type\":\"ai_response\",\"data\":{\"content\":\"Let me look at the auth module.\"}}}" | jq .

# Close thread
curl -s -X POST "${WORKER_URL}/mcp" \
  -H "X-Sticky-API-Key: ${API_KEY}" -H "Content-Type: application/json" \
  -d "{\"tool\":\"close_thread\",\"input\":{\"thread_id\":\"$THREAD\",\"narrative\":\"Investigated auth module\",\"work_type\":\"code-review\"}}" | jq .

# Verify thread appears in sticky-note.json on GitHub
curl -s "https://api.github.com/repos/OWNER/REPO/contents/.sticky-note/sticky-note.json" \
  -H "Authorization: Bearer ${GITHUB_PAT}" | jq '.content | @base64d | fromjson | .threads[-1].status'
# Expected: "closed"

# Verify events in KV
curl -s "${WORKER_URL}/threads/${THREAD}/events" \
  -H "X-Sticky-API-Key: ${API_KEY}" | jq '.events | length'
# Expected: >= 3 (session_open, user_prompt, ai_response, session_close)
```

- [ ] **Step 5: Commit deploy marker**

```bash
git add sticky-server/wrangler.toml
git commit -m "chore: verify Worker deployment with cowork end-to-end test"
```
