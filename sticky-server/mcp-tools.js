// sticky-server/mcp-tools.js

// crypto.randomUUID() is a Workers global — no import needed unless nodejs_compat is set.
// We use the global directly to avoid a hard dep on node:crypto when that flag isn't active.

export const EVENT_TYPES = Object.freeze({
  SESSION_OPEN:  "session_open",
  SESSION_CLOSE: "session_close",
  USER_PROMPT:   "user_prompt",
  CHECKPOINT:    "checkpoint",
});

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
        thread_id:         { type: "string" },
        narrative:         { type: "string", description: "Summary of what was accomplished" },
        work_type:         { type: "string", description: "e.g. bug-fix, feature-development, debugging, refactor, documentation" },
        handoff_summary:   { type: "string", description: "Notes for teammates picking this up" },
        failed_approaches: { type: "array", items: { type: "string" }, description: "What was tried and didn't work" },
        files_touched:     { type: "array", items: { type: "string" }, description: "Files modified during session" },
      },
      required: ["thread_id", "narrative"],
    },
  },
];

export async function handleMcpTool(toolName, input, env, project, getOrCreateDO) {
  switch (toolName) {
    case "open_thread":    return handleOpenThread(input, env, project, getOrCreateDO);
    case "append_event":   return handleAppendEvent(input, env, project, getOrCreateDO);
    case "set_checkpoint": return handleSetCheckpoint(input, env, project, getOrCreateDO);
    case "close_thread":   return handleCloseThread(input, env, project, getOrCreateDO);
    default: throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleOpenThread(input, env, project, getOrCreateDO) {
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
    ts: now, type: EVENT_TYPES.SESSION_OPEN, session_id: null,
    data: {
      model: input.model || null,
      branch: input.branch || null,
      user: input.user,
      mcp_servers: input.mcp_servers || [],
      claude_md_hash: input.claude_md_hash || null,
    },
  };
  const promptEvent = {
    ts: now, type: EVENT_TYPES.USER_PROMPT, session_id: null,
    data: { content: input.prompt },
  };

  const do_stub = getOrCreateDO(env, threadId);
  await do_stub.fetch(new Request("http://do/do/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ thread_id: threadId, project, events: [openEvent, promptEvent] }),
  }));

  // Async GitHub commit — fire and forget
  _commitThreadToGit(env, project, threadId, getOrCreateDO).catch(() => {});

  return { thread_id: threadId };
}

async function handleAppendEvent(input, env, project, getOrCreateDO) {
  const { thread_id, type, data } = input;

  const metaKey = `${project}:thread:${thread_id}`;
  const exists = await env.STICKY_KV.get(metaKey, { type: "text" });
  if (!exists) return { ok: false, error: "unknown thread_id" };

  const event = { ts: new Date().toISOString(), type, session_id: null, data: data || {} };

  const do_stub = getOrCreateDO(env, thread_id);
  await do_stub.fetch(new Request("http://do/do/append", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  }));

  return { ok: true };
}

async function handleSetCheckpoint(input, env, project, getOrCreateDO) {
  return handleAppendEvent(
    { thread_id: input.thread_id, type: EVENT_TYPES.CHECKPOINT, data: { topic: input.topic } },
    env, project, getOrCreateDO
  );
}

async function handleCloseThread(input, env, project, getOrCreateDO) {
  const { thread_id, narrative, work_type, handoff_summary, failed_approaches, files_touched } = input;
  const now = new Date().toISOString();

  const closeEvent = {
    ts: now, type: EVENT_TYPES.SESSION_CLOSE, session_id: null,
    data: {
      narrative,
      work_type: work_type || "general",
      handoff_summary: handoff_summary || "",
      failed_approaches: failed_approaches || [],
      files_touched: files_touched || [],
    },
  };

  const do_stub = getOrCreateDO(env, thread_id);
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

  // GitHub commit — synchronous (awaited) for close_thread
  await _commitThreadToGit(env, project, thread_id, getOrCreateDO);

  return { ok: true };
}

// Internal helper — used by open_thread (fire-and-forget), close_thread (awaited), and crash recovery
export async function _commitThreadToGit(env, project, threadId, getOrCreateDO) {
  const kv = env.STICKY_KV;

  // Always maintain the threads index (even without GitHub creds).
  // NOTE: There is a known read-modify-write race when two open_thread calls run
  // concurrently — both may read the same list before either writes back. This is
  // self-healing: the next close_thread call will re-add any dropped ID, and the
  // list is always capped at 500, so no corruption accumulates. A separate "index DO"
  // would be required to eliminate the race entirely, which is out of scope here.
  const threadsListKey = `${project}:threads_index`;
  let threadIds = await kv.get(threadsListKey, { type: "json" }).catch(() => []) || [];
  if (!threadIds.includes(threadId)) {
    threadIds = [threadId, ...threadIds].slice(0, 500); // cap at 500
    await kv.put(threadsListKey, JSON.stringify(threadIds));
  }

  // GitHub commit requires credentials — skip if not configured
  const pat = env.GITHUB_PAT;
  const repoFull = env.GITHUB_REPO; // format: "owner/repo"
  if (!pat || !repoFull) return;
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) return;

  // threadIds is already populated above — no second KV read needed
  const allMeta = await Promise.all(
    threadIds.map(id => kv.get(`${project}:thread:${id}`, { type: "json" }).catch(() => null))
  );
  const threads = allMeta.filter(Boolean).map(m => {
    // Strip internal KV fields before writing to git
    const { _event_chunks, _last_recovery_attempt, ...rest } = m;
    return rest;
  });

  const newContent = JSON.stringify({ version: "2", project, threads }, null, 2) + "\n";

  // Use StickyThread DO for serialized GitHub commit (avoids race conditions)
  const do_stub = getOrCreateDO(env, threadId);
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
