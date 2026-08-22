/**
 * Sticky Note V3 — Cloudflare Worker
 *
 * REST API backed by Cloudflare KV.
 * Auth: X-Sticky-API-Key header matched against STICKY_API_KEY env var.
 * Project routing: X-Sticky-Project header (auto-set by client hooks).
 *
 * Endpoints:
 *   POST   /threads          — create thread
 *   GET    /threads           — list threads (?status=, ?q=)
 *   GET    /threads/:id       — get thread
 *   PUT    /threads/:id       — update thread
 *   DELETE /threads/:id       — tombstone thread
 *   POST   /threads/:id/events — append event batch (local session push)
 *   GET    /threads/:id/events — retrieve all stored events
 *   GET    /audit             — query audit (?file=, ?user=, ?since=, ?tool=)
 *   POST   /audit             — append audit record
 *   GET    /presence          — list active developers
 *   POST   /presence          — heartbeat upsert
 *   DELETE /presence/:user    — clear presence
 *   GET    /config            — get team config
 *   PUT    /config            — update team config
 */

import * as adapter from "./adapters/cf-kv.js";
import { MCP_TOOL_DEFINITIONS, handleMcpTool, setDOAccessor, _commitThreadToGit } from "./mcp-tools.js";

// ── Helpers ──────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function authenticate(request, env) {
  const key = request.headers.get("X-Sticky-API-Key");
  if (!env.STICKY_API_KEY) return true; // no key configured = open
  return key === env.STICKY_API_KEY;
}

function getProject(request) {
  return request.headers.get("X-Sticky-Project") || "default";
}

// ── Router ───────────────────────────────────────────────

function matchRoute(method, pathname) {
  // Thread routes
  if (method === "POST" && pathname === "/threads") return { handler: "createThread" };
  if (method === "GET" && pathname === "/threads") return { handler: "listThreads" };
  if (method === "POST" && pathname.match(/^\/threads\/[^/]+\/events$/)) {
    const id = pathname.split("/")[2];
    return { handler: "appendThreadEvents", id };
  }
  if (method === "GET" && pathname.match(/^\/threads\/[^/]+\/events$/)) {
    const id = pathname.split("/")[2];
    return { handler: "getThreadEvents", id };
  }
  if (method === "GET" && pathname.startsWith("/threads/")) {
    return { handler: "getThread", id: pathname.slice("/threads/".length) };
  }
  if (method === "PUT" && pathname.startsWith("/threads/")) {
    return { handler: "updateThread", id: pathname.slice("/threads/".length) };
  }
  if (method === "DELETE" && pathname.startsWith("/threads/")) {
    return { handler: "deleteThread", id: pathname.slice("/threads/".length) };
  }

  // Audit routes
  if (method === "GET" && pathname === "/audit") return { handler: "queryAudit" };
  if (method === "POST" && pathname === "/audit") return { handler: "appendAudit" };

  // Presence routes
  if (method === "GET" && pathname === "/presence") return { handler: "getPresence" };
  if (method === "POST" && pathname === "/presence") return { handler: "upsertPresence" };
  if (method === "DELETE" && pathname.startsWith("/presence/")) {
    return { handler: "deletePresence", user: decodeURIComponent(pathname.slice("/presence/".length)) };
  }

  // Config routes
  if (method === "GET" && pathname === "/config") return { handler: "getConfig" };
  if (method === "PUT" && pathname === "/config") return { handler: "putConfig" };

  // MCP routes
  if (method === "GET" && pathname === "/mcp") return { handler: "mcpListTools" };
  if (method === "POST" && pathname === "/mcp") return { handler: "mcpCallTool" };

  // Health
  if (method === "GET" && pathname === "/health") return { handler: "health" };

  return null;
}

// ── Handlers ─────────────────────────────────────────────

const handlers = {
  async health() {
    return json({ status: "ok", version: "3.0.0" });
  },

  // ── Threads ──

  async createThread(request, kv, project) {
    const thread = await request.json();
    if (!thread.id) return error("thread.id is required");
    await adapter.putThread(kv, project, thread);
    return json(thread, 201);
  },

  async listThreads(request, kv, project) {
    const url = new URL(request.url);
    const filters = {
      status: url.searchParams.get("status") || undefined,
      q: url.searchParams.get("q") || undefined,
    };
    const threads = await adapter.getThreads(kv, project, filters);
    return json({ threads });
  },

  async getThread(_request, kv, project, { id }) {
    const thread = await adapter.getThread(kv, project, id);
    if (!thread) return error("Thread not found", 404);
    return json(thread);
  },

  async updateThread(request, kv, project, { id }) {
    const thread = await request.json();
    thread.id = id;
    await adapter.putThread(kv, project, thread);
    return json(thread);
  },

  async deleteThread(_request, kv, project, { id }) {
    await adapter.deleteThread(kv, project, id);
    return json({ deleted: id });
  },

  // ── Thread Events ──

  async appendThreadEvents(request, kv, project, { id }) {
    const body = await request.json().catch(() => ({}));
    const events = Array.isArray(body.events) ? body.events : [];
    await adapter.appendEvents(kv, project, id, events);
    return json({ ok: true, appended: events.length });
  },

  async getThreadEvents(_request, kv, project, { id }) {
    const events = await adapter.getEvents(kv, project, id);
    return json({ events });
  },

  // ── Audit ──

  async queryAudit(request, kv, project) {
    const url = new URL(request.url);
    const filters = {
      user: url.searchParams.get("user") || undefined,
      file: url.searchParams.get("file") || undefined,
      tool: url.searchParams.get("tool") || undefined,
      since: url.searchParams.get("since") || undefined,
    };
    const records = await adapter.queryAudit(kv, project, filters);
    return json({ audit: records });
  },

  async appendAudit(request, kv, project) {
    const record = await request.json();
    await adapter.appendAudit(kv, project, record);
    return json({ ok: true }, 201);
  },

  // ── Presence ──

  async getPresence(_request, kv, project) {
    const records = await adapter.getPresence(kv, project);
    return json({ presence: records });
  },

  async upsertPresence(request, kv, project) {
    const record = await request.json();
    if (!record.user) return error("record.user is required");
    await adapter.upsertPresence(kv, project, record);
    return json({ ok: true });
  },

  async deletePresence(_request, kv, project, { user }) {
    await adapter.deletePresence(kv, project, user);
    return json({ deleted: user });
  },

  // ── MCP ──

  async mcpListTools() {
    return json({ tools: MCP_TOOL_DEFINITIONS });
  },

  async mcpCallTool(request, _kv, project, _route, env) {
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
  },

  // ── Config ──

  async getConfig(_request, kv, project) {
    const config = await adapter.getConfig(kv, project);
    if (!config) return json({});
    return json(config);
  },

  async putConfig(request, kv, project) {
    const config = await request.json();
    await adapter.putConfig(kv, project, config);
    return json(config);
  },
};

// ── Durable Object helper ────────────────────────────────

function getOrCreateDO(env, threadId) {
  const id = env.STICKY_THREAD.idFromName(threadId);
  return env.STICKY_THREAD.get(id);
}

// ── Worker entry point ───────────────────────────────────

export default {
  async fetch(request, env) {
    // Wire DO accessor so mcp-tools.js can call getOrCreateDO with the current env
    setDOAccessor(getOrCreateDO);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-Sticky-API-Key, X-Sticky-Project",
        },
      });
    }

    // Auth
    if (!authenticate(request, env)) {
      return error("Unauthorized", 401);
    }

    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);

    if (!route) {
      return error("Not found", 404);
    }

    const project = getProject(request);
    const kv = env.STICKY_KV;

    try {
      const handler = handlers[route.handler];
      const response = await handler(request, kv, project, route, env);

      // Add CORS headers to all responses
      const headers = new Headers(response.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, {
        status: response.status,
        headers,
      });
    } catch (err) {
      return error(`Internal error: ${err.message}`, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCrashRecovery(env));
  },
};

// ── Crash recovery (cron) ────────────────────────────────

async function runCrashRecovery(env) {
  const projects = ["default"]; // TODO: discover from KV index if multi-project
  const staleThresholdMs = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();

  // Wire DO accessor for mcp-tools.js calls inside the cron handler
  setDOAccessor(getOrCreateDO);

  for (const project of projects) {
    const threadsListKey = `${project}:threads_index`;
    const threadIds = await env.STICKY_KV.get(threadsListKey, { type: "json" })
      .catch(() => []) || [];

    const metas = await Promise.all(
      threadIds.map(id =>
        env.STICKY_KV.get(`${project}:thread:${id}`, { type: "json" }).catch(() => null)
      )
    );
    for (let i = 0; i < threadIds.length; i++) {
      const meta = metas[i];
      const threadId = threadIds[i];
      if (!meta || meta.status !== "open") continue;

      const lastActivity = new Date(meta.last_activity_at || meta.created_at).getTime();
      if (now - lastActivity < staleThresholdMs) continue;

      // Track last_recovery_attempt to avoid hammering
      const lastAttempt = meta._last_recovery_attempt || 0;
      if (now - lastAttempt < 5 * 60 * 1000) continue; // skip if tried < 5min ago

      // Thread is stale — flush DO buffer and mark as stale
      try {
        const do_stub = getOrCreateDO(env, threadId);
        const recovery_event = {
          ts: new Date().toISOString(), type: "session_close", session_id: null,
          data: { narrative: "[recovered by cron]", work_type: "unknown", handoff_summary: "", failed_approaches: [], files_touched: [] },
        };

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

        // GitHub commit for stale thread — commit the already-written stale metadata directly
        await _commitThreadToGit(env, project, threadId).catch(() => {});
      } catch (_) {
        // best-effort — log to console for observability
        console.error(`[sticky-note] crash recovery failed for thread ${threadId}`);
      }
    }
  }
}

export { StickyThread } from "./sticky-thread-do.js";
