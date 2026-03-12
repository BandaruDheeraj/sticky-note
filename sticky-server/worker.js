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
 *   GET    /audit             — query audit (?file=, ?user=, ?since=, ?tool=)
 *   POST   /audit             — append audit record
 *   GET    /presence          — list active developers
 *   POST   /presence          — heartbeat upsert
 *   DELETE /presence/:user    — clear presence
 *   GET    /config            — get team config
 *   PUT    /config            — update team config
 */

import * as adapter from "./adapters/cf-kv.js";

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

// ── Worker entry point ───────────────────────────────────

export default {
  async fetch(request, env) {
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
      const response = await handler(request, kv, project, route);

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
};
