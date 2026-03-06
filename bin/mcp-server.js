#!/usr/bin/env node

/**
 * sticky-note MCP server — stdio-based
 *
 * Implements Model Context Protocol (JSON-RPC 2.0 over stdin/stdout)
 * with 5 tools for AI assistants (Cursor, Windsurf, etc.):
 *
 *   get_session_context(id)   — full thread payload by ID
 *   get_stuck_threads()       — all stuck threads
 *   search_threads(query)     — keyword search across threads
 *   get_audit_trail(...)      — query JSONL audit log
 *   get_presence()            — current presence data
 *
 * Zero external dependencies. Node >= 16.
 *
 * Usage:
 *   node bin/mcp-server.js                    (uses cwd)
 *   node bin/mcp-server.js --project /path    (explicit project root)
 */

const fs = require("fs");
const path = require("path");

// ──────────────────────────────────────────────
// Project root resolution
// ──────────────────────────────────────────────

let PROJECT_ROOT = process.cwd();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project" && args[i + 1]) {
    PROJECT_ROOT = path.resolve(args[i + 1]);
  }
}

function stickyDir() {
  return path.join(PROJECT_ROOT, ".sticky-note");
}

// ──────────────────────────────────────────────
// File helpers
// ──────────────────────────────────────────────

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function getMemory() {
  return readJsonSafe(path.join(stickyDir(), "sticky-note.json"), {
    version: "2",
    threads: [],
  });
}

function getPresence() {
  return readJsonSafe(path.join(stickyDir(), ".sticky-presence.json"), {});
}

function getThreads() {
  return getMemory().threads || [];
}

// ──────────────────────────────────────────────
// Tool implementations
// ──────────────────────────────────────────────

function toolGetSessionContext(params) {
  const { id } = params;
  if (!id) {
    return { error: "Missing required parameter: id" };
  }

  const threads = getThreads();
  const thread = threads.find((t) => t.id === id || t.session_id === id);

  if (!thread) {
    return { error: `No thread found with id: ${id}` };
  }

  return { thread };
}

function toolGetStuckThreads(_params) {
  const threads = getThreads();
  const stuck = threads.filter((t) => t.status === "stuck");

  return {
    count: stuck.length,
    threads: stuck,
  };
}

function toolSearchThreads(params) {
  const { query } = params;
  if (!query) {
    return { error: "Missing required parameter: query" };
  }

  const threads = getThreads();
  const q = query.toLowerCase();
  const matches = threads.filter((t) => {
    if (t.status === "expired") return false;

    const searchable = [
      t.id,
      t.user,
      t.last_note,
      t.narrative,
      t.handoff_summary,
      t.branch,
      ...(t.files_touched || []),
      ...(t.failed_approaches || []).map((f) => `${f.description} ${f.error}`),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return q.split(/\s+/).every((word) => searchable.includes(word));
  });

  return {
    query,
    count: matches.length,
    threads: matches,
  };
}

function toolGetAuditTrail(params) {
  const { file, user, since, tool, session, limit } = params || {};
  const auditPath = path.join(stickyDir(), "sticky-note-audit.jsonl");

  if (!fs.existsSync(auditPath)) {
    return { error: "No audit log found (sticky-note-audit.jsonl)" };
  }

  const content = fs.readFileSync(auditPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const matches = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (file && !(entry.file || "").includes(file)) continue;
    if (user && entry.user !== user) continue;
    if (session && entry.session_id !== session) continue;
    if (tool && entry.tool !== tool) continue;
    if (since) {
      const ts = entry.ts || entry.timestamp || "";
      if (ts < since) continue;
    }

    matches.push(entry);
  }

  const cap = limit || 100;
  const display = matches.slice(-cap).reverse();

  return {
    total_matches: matches.length,
    returned: display.length,
    entries: display,
  };
}

function toolGetPresence(_params) {
  const presence = getPresence();
  const entries = Object.entries(presence);
  const now = new Date();

  // Filter to entries seen in last 15 minutes
  const active = entries
    .filter(([_user, data]) => {
      const lastSeen = new Date(data.last_seen || 0);
      return now - lastSeen < 15 * 60 * 1000;
    })
    .map(([user, data]) => ({
      user,
      active_files: data.active_files || [],
      last_seen: data.last_seen,
    }));

  return {
    active_count: active.length,
    users: active,
    stale_count: entries.length - active.length,
  };
}

// ──────────────────────────────────────────────
// Tool registry
// ──────────────────────────────────────────────

const TOOLS = {
  get_session_context: {
    description:
      "Get full thread payload for a session by ID. Returns all fields including narrative, failed_approaches, and handoff_summary.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Thread ID or session ID to look up",
        },
      },
      required: ["id"],
    },
    handler: toolGetSessionContext,
  },
  get_stuck_threads: {
    description:
      "Get all threads with status 'stuck'. Returns full payloads including failed approaches and last notes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: toolGetStuckThreads,
  },
  search_threads: {
    description:
      "Search across all non-expired threads by keyword. Searches ID, user, notes, narrative, files, failed approaches, and branch.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query — all words must match (AND logic). Searches across thread fields.",
        },
      },
      required: ["query"],
    },
    handler: toolSearchThreads,
  },
  get_audit_trail: {
    description:
      "Query the append-only JSONL audit log. Filter by file, user, session, tool, or date. Returns most recent entries first.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Filter entries by file path (substring match)",
        },
        user: {
          type: "string",
          description: "Filter by exact username",
        },
        since: {
          type: "string",
          description: "ISO date — only entries after this timestamp",
        },
        tool: {
          type: "string",
          description: "Filter by tool name (Edit, Read, Write, etc.)",
        },
        session: {
          type: "string",
          description: "Filter by session ID",
        },
        limit: {
          type: "number",
          description: "Max entries to return (default: 100)",
        },
      },
    },
    handler: toolGetAuditTrail,
  },
  get_presence: {
    description:
      "Get current developer presence — who is actively working and on which files. Only shows users seen in the last 15 minutes.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: toolGetPresence,
  },
};

// ──────────────────────────────────────────────
// MCP Protocol (JSON-RPC 2.0 over stdio)
// ──────────────────────────────────────────────

const SERVER_INFO = {
  name: "sticky-note",
  version: "2.0.0",
};

const CAPABILITIES = {
  tools: {},
};

function handleRequest(msg) {
  const { method, params, id } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        },
      };

    case "notifications/initialized":
      // Client acknowledgment — no response needed
      return null;

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };

    case "tools/call": {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const tool = TOOLS[toolName];

      if (!tool) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown tool: ${toolName}`,
              },
            ],
          },
        };
      }

      try {
        const result = tool.handler(toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool error: ${err.message}`,
              },
            ],
          },
        };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      // Unknown method
      if (id !== undefined) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
      }
      // Notifications we don't handle — ignore silently
      return null;
  }
}

// ──────────────────────────────────────────────
// stdio transport
// ──────────────────────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;

  // Process complete lines (newline-delimited JSON)
  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Malformed JSON — send parse error
      const errResp = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
      process.stdout.write(JSON.stringify(errResp) + "\n");
      continue;
    }

    const response = handleRequest(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// Handle errors gracefully
process.on("uncaughtException", (err) => {
  process.stderr.write(`sticky-note MCP server error: ${err.message}\n`);
});
