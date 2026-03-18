#!/usr/bin/env node
/**
 * sticky-note MCP server — stdio-based
 *
 * Implements Model Context Protocol (JSON-RPC 2.0 over stdin/stdout)
 * with 8 tools for AI assistants:
 *
 *   get_session_context(id)              — full thread payload by ID
 *   get_stuck_threads()                  — all stuck threads
 *   search_threads(query)               — keyword search across threads
 *   get_audit_trail(...)                — query per-user JSONL audit logs
 *   get_presence()                      — current presence data
 *   check_overlaps(files)               — overlap detection for edit gating
 *   get_environment_status()            — environment sync status
 *   get_thread_context_for_files(files) — thread attribution for files
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

function getConfig() {
  return readJsonSafe(path.join(stickyDir(), "sticky-note-config.json"), {
    stale_days: 14,
    mcp_servers: [],
    skills: [],
    conventions: [],
  });
}

function getThreads() {
  return getMemory().threads || [];
}

/**
 * Read all per-user presence files from .sticky-note/presence/
 * Returns { username: { active_files, last_seen } }
 */
function getAllPresence() {
  const presenceDir = path.join(stickyDir(), "presence");
  const result = {};
  if (!fs.existsSync(presenceDir)) return result;

  for (const file of fs.readdirSync(presenceDir)) {
    if (!file.endsWith(".json")) continue;
    const user = file.replace(".json", "");
    result[user] = readJsonSafe(path.join(presenceDir, file), {});
  }
  return result;
}

/**
 * Read all per-user audit files from .sticky-note/audit/
 * Returns array of parsed entries across all users.
 */
function getAllAuditEntries(filters) {
  const auditDir = path.join(stickyDir(), "audit");
  if (!fs.existsSync(auditDir)) return [];

  const { file, user, since, tool, session, type } = filters || {};
  const entries = [];

  const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));

  // If filtering by user, only read that user's file
  const filesToRead = user
    ? auditFiles.filter((f) => f === `${user}.jsonl`)
    : auditFiles;

  for (const auditFile of filesToRead) {
    const content = fs.readFileSync(path.join(auditDir, auditFile), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

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
      if (type && entry.type !== type) continue;
      if (since) {
        const ts = entry.ts || entry.timestamp || "";
        if (ts < since) continue;
      }

      entries.push(entry);
    }
  }

  return entries;
}

// ──────────────────────────────────────────────
// Tool implementations — Core (5 original)
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

function toolGetStuckThreads() {
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
      ...(t.failed_approaches || []).map((f) =>
        typeof f === "string" ? f : `${f.description} ${f.error}`
      ),
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

  const entries = getAllAuditEntries({ file, user, since, tool, session });

  if (entries.length === 0) {
    return {
      total_matches: 0,
      returned: 0,
      entries: [],
    };
  }

  const cap = limit || 100;
  const display = entries.slice(-cap).reverse();

  return {
    total_matches: entries.length,
    returned: display.length,
    entries: display,
  };
}

function toolGetPresence() {
  const presence = getAllPresence();
  const entries = Object.entries(presence);
  const now = new Date();

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
// Tool implementations — New (3 notification/env)
// ──────────────────────────────────────────────

function toolCheckOverlaps(params) {
  const { files } = params;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return { error: "Missing required parameter: files (array of file paths)" };
  }

  const threads = getThreads();
  const presence = getAllPresence();
  const currentUser = process.env.USER || process.env.USERNAME || "unknown";
  const normalizedFiles = files.map((f) => f.replace(/\\/g, "/"));

  const overlaps = [];

  // Check threads (open/stuck) that touch the same files
  for (const thread of threads) {
    if (thread.status !== "open" && thread.status !== "stuck") continue;
    if (thread.user === currentUser) continue;

    const threadFiles = (thread.files_touched || []).map((f) =>
      f.replace(/\\/g, "/")
    );
    const shared = normalizedFiles.filter((f) =>
      threadFiles.some((tf) => tf === f || tf.includes(f) || f.includes(tf))
    );

    if (shared.length > 0) {
      overlaps.push({
        user: thread.user,
        thread_id: thread.id,
        status: thread.status,
        files: shared,
        narrative: thread.narrative || thread.last_note || "",
        failed_approaches: (thread.failed_approaches || []).map((f) =>
          typeof f === "string" ? f : f.description
        ),
        severity: thread.status === "stuck" ? "high" : "medium",
      });
    }
  }

  // Check presence — other users actively working on the same files
  const now = new Date();
  for (const [user, data] of Object.entries(presence)) {
    if (user === currentUser) continue;
    const lastSeen = new Date(data.last_seen || 0);
    if (now - lastSeen > 15 * 60 * 1000) continue;

    const presenceFiles = (data.active_files || []).map((f) =>
      f.replace(/\\/g, "/")
    );
    const shared = normalizedFiles.filter((f) =>
      presenceFiles.some((pf) => pf === f || pf.includes(f) || f.includes(pf))
    );

    if (shared.length > 0) {
      // Don't duplicate if already captured via thread
      const alreadyCovered = overlaps.some((o) => o.user === user);
      if (!alreadyCovered) {
        overlaps.push({
          user,
          thread_id: null,
          status: "active",
          files: shared,
          narrative: `${user} is currently working on these files`,
          failed_approaches: [],
          severity: "low",
        });
      }
    }
  }

  if (overlaps.length === 0) {
    return {
      overlaps: [],
      warning: null,
      action: "proceed",
    };
  }

  const highSeverity = overlaps.filter((o) => o.severity === "high");
  const warning =
    highSeverity.length > 0
      ? `WARNING: ${highSeverity.map((o) => o.user).join(", ")} ${highSeverity.length === 1 ? "has" : "have"} STUCK ${highSeverity.length === 1 ? "thread" : "threads"} on files you are about to edit. Consider coordinating before proceeding.`
      : `NOTE: ${overlaps.map((o) => o.user).join(", ")} ${overlaps.length === 1 ? "is" : "are"} working on overlapping files. Proceed with awareness.`;

  return {
    overlaps,
    warning,
    action: "display_to_user",
  };
}

function toolGetEnvironmentStatus() {
  const envDir = path.join(stickyDir(), "environment");
  const mcpPath = path.join(PROJECT_ROOT, ".mcp.json");

  // No environment directory — feature not set up
  if (!fs.existsSync(envDir)) {
    return {
      status: "not_configured",
      message: "No .sticky-note/environment/ directory found. Environment sync is not set up for this repo.",
      action: "none",
    };
  }

  const manifest = readJsonSafe(path.join(envDir, "manifest.json"), {});
  const mcpConfig = readJsonSafe(mcpPath, { mcpServers: {} });
  const registeredServers = Object.keys(mcpConfig.mcpServers || {});

  const provisioned = { mcp_servers: [], skills: [], agents: [], commands: [] };
  const missing = { mcp_servers: [] };

  // Check MCP servers
  if (manifest.mcp_servers) {
    for (const [name, config] of Object.entries(manifest.mcp_servers)) {
      if (registeredServers.includes(name)) {
        provisioned.mcp_servers.push(name);
      } else {
        // Figure out why it's missing
        const envEntries = config.env || {};
        const missingSecrets = Object.entries(envEntries)
          .filter(([_, val]) => typeof val === "string" && val.startsWith("${") && val.endsWith("}"))
          .map(([key, val]) => {
            const envName = val.slice(2, -1);
            const envVarMeta = (manifest.env_vars || {})[envName] || {};
            return {
              env_var: envName,
              description: envVarMeta.description || key,
              docs_url: envVarMeta.docs_url || null,
              required: envVarMeta.required !== false,
            };
          });

        missing.mcp_servers.push({
          name,
          reason: missingSecrets.length > 0 ? "missing_secret" : "not_provisioned",
          secrets: missingSecrets,
          description: config.description || name,
          required: config.required !== false,
        });
      }
    }
  }

  // Scan skills directory
  const skillsDir = path.join(envDir, "skills");
  if (fs.existsSync(skillsDir)) {
    provisioned.skills = fs
      .readdirSync(skillsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
  }

  // Scan agents directory
  const agentsDir = path.join(envDir, "agents");
  if (fs.existsSync(agentsDir)) {
    provisioned.agents = fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
  }

  // Scan commands directory
  const commandsDir = path.join(envDir, "commands");
  if (fs.existsSync(commandsDir)) {
    provisioned.commands = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
  }

  const hasMissing = missing.mcp_servers.length > 0;
  const status = hasMissing ? "incomplete" : "complete";

  const result = {
    status,
    provisioned,
    action: hasMissing ? "inform_user_of_missing" : "none",
  };

  if (hasMissing) {
    result.missing = missing;
    const requiredMissing = missing.mcp_servers.filter((s) => s.required);
    if (requiredMissing.length > 0) {
      result.message = `${requiredMissing.length} required MCP server(s) need secrets. Run: npx sticky-note bootstrap`;
    }
  }

  return result;
}

function toolGetThreadContextForFiles(params) {
  const { files } = params;
  if (!files || !Array.isArray(files) || files.length === 0) {
    return { error: "Missing required parameter: files (array of file paths)" };
  }

  const threads = getThreads();
  const normalizedFiles = files.map((f) => f.replace(/\\/g, "/"));

  const fileContexts = {};

  for (const file of normalizedFiles) {
    const relatedThreads = threads
      .filter((t) => {
        if (t.status === "expired") return false;
        const threadFiles = (t.files_touched || []).map((f) =>
          f.replace(/\\/g, "/")
        );
        return threadFiles.some(
          (tf) => tf === file || tf.includes(file) || file.includes(tf)
        );
      })
      .map((t) => ({
        id: t.id,
        user: t.user,
        status: t.status,
        work_type: t.work_type || "unknown",
        narrative: t.narrative || t.last_note || "",
        failed_approaches: (t.failed_approaches || []).map((f) =>
          typeof f === "string" ? f : { description: f.description, error: f.error }
        ),
        handoff_summary: t.handoff_summary || "",
        branch: t.branch || "",
        updated_at: t.updated_at || t.created_at || "",
      }));

    if (relatedThreads.length > 0) {
      fileContexts[file] = {
        thread_count: relatedThreads.length,
        threads: relatedThreads,
      };
    }
  }

  return {
    files_queried: files.length,
    files_with_context: Object.keys(fileContexts).length,
    contexts: fileContexts,
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
      "Get all threads with status 'stuck'. Returns full payloads including failed approaches and last notes. Call at session start to check for team blockers.",
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
      "Query the per-user JSONL audit logs. Filter by file, user, session, tool, or date. Returns most recent entries first.",
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
  check_overlaps: {
    description:
      "Check if given files overlap with other users' open/stuck threads or active presence. Call BEFORE editing files to detect conflicts. Returns severity levels and warnings.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of file paths you plan to edit. Checks against all open/stuck threads and active presence.",
        },
      },
      required: ["files"],
    },
    handler: toolCheckOverlaps,
  },
  get_environment_status: {
    description:
      "Get environment sync status — which MCP servers, skills, agents, and commands are provisioned vs missing. Flags missing secrets with docs URLs. Call at session start to check for environment issues.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: toolGetEnvironmentStatus,
  },
  get_thread_context_for_files: {
    description:
      "Get thread attribution for specific files — who worked on them, what happened, what failed. Call before editing files to understand prior work context.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of file paths to check for related thread context.",
        },
      },
      required: ["files"],
    },
    handler: toolGetThreadContextForFiles,
  },
};

// ──────────────────────────────────────────────
// MCP Protocol (JSON-RPC 2.0 over stdio)
// ──────────────────────────────────────────────

const SERVER_INFO = {
  name: "sticky-note",
  version: "3.0.0",
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

  let newlineIdx;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIdx).trim();
    buffer = buffer.slice(newlineIdx + 1);

    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
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

process.on("uncaughtException", (err) => {
  process.stderr.write(`sticky-note MCP server error: ${err.message}\n`);
});
