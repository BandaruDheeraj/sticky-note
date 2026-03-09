#!/usr/bin/env node
"use strict";
/**
 * track-work.js — Audit Trail (V2.5)
 *
 * Hook: PostToolUse (Claude Code) / postToolUse (Copilot CLI)
 * Appends one JSONL line per tool call. Updates presence heartbeat.
 * V2.5: Captures line-level changes for write tools and writes Git Notes.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function safeExit() {
  try {
    process.stdout.write(JSON.stringify({ output: "" }) + "\n");
  } catch (_) {
    process.stdout.write('{"output":""}\n');
  }
  process.exit(0);
}

let utils;
try {
  utils = require("./sticky-utils.js");
} catch (_) {
  safeExit();
}

let gitNotes;
try {
  gitNotes = require("./sticky-git-notes.js");
} catch (_) {
  gitNotes = null;
}

const {
  getConfigPath,
  getUserPresencePath,
  loadJson,
  saveJson,
  appendAuditLine,
  getUser,
  getSessionId,
} = utils;

const WRITE_TOOLS = new Set([
  "edit", "Edit", "create", "Create", "Write", "write", "MultiEdit", "multi_edit",
]);

function _debugPath() {
  const scriptDir = path.dirname(path.resolve(__filename));
  return path.join(scriptDir, "..", "..", ".sticky-note", ".sticky-debug.jsonl");
}

function logDebug(toolName, hookInput) {
  if (!WRITE_TOOLS.has(toolName)) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      tool: toolName,
      hook_input_keys: Object.keys(hookInput).sort(),
      hook_input: {},
    };
    const exclude = new Set(["output", "result", "stdout", "stderr"]);
    for (const [k, v] of Object.entries(hookInput)) {
      if (!exclude.has(k)) entry.hook_input[k] = v;
    }
    const debugFile = _debugPath();
    fs.mkdirSync(path.dirname(debugFile), { recursive: true });
    fs.appendFileSync(debugFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch (_) {
    // ignore
  }
}

function extractFilePath(hookInput) {
  const cwd = hookInput.cwd || "";
  let rawPath = null;

  for (const containerKey of ["tool_input", "input", "toolInput", "toolArgs", "params"]) {
    const container = hookInput[containerKey];
    if (container && typeof container === "object" && !Array.isArray(container)) {
      for (const key of ["file_path", "filePath", "path", "filename", "file"]) {
        if (key in container) {
          rawPath = container[key];
          break;
        }
      }
    }
    if (rawPath) break;
  }

  if (!rawPath) {
    for (const key of ["file_path", "filePath", "path", "file"]) {
      if (key in hookInput) {
        rawPath = hookInput[key];
        break;
      }
    }
  }

  if (!rawPath) return null;

  if (cwd && path.isAbsolute(rawPath)) {
    try {
      return path.relative(cwd, rawPath);
    } catch (_) {
      // fall through
    }
  }
  return rawPath;
}

function updatePresence(user, filePath) {
  const presencePath = getUserPresencePath(user);
  try {
    const entry = loadJson(presencePath, { active_files: [], last_seen: "" });

    if (filePath) {
      const active = entry.active_files || [];
      if (!active.includes(filePath)) {
        active.push(filePath);
      }
      entry.active_files = [...new Set(active)].slice(-10);
    }

    entry.last_seen = new Date().toISOString();
    saveJson(presencePath, entry);
  } catch (_) {
    // ignore
  }
}

function autoDetectMcp(toolName) {
  if (!toolName || !toolName.startsWith("mcp__")) return null;
  const parts = toolName.split("__");
  if (parts.length >= 2) return parts[1];
  return null;
}

// ── V2.5: Line-level change tracking ─────────────────────

/**
 * After a write tool completes, capture exact line ranges changed.
 * Uses git diff --unified=0 to get precise line numbers.
 * Returns array of { start, count } or null on failure.
 */
function captureLineChanges(filePath) {
  if (!filePath) return null;
  try {
    const raw = execFileSync("git", ["diff", "--unified=0", "--", filePath], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!raw.trim()) return null;

    const ranges = [];
    for (const line of raw.split("\n")) {
      // @@ -old_start,old_count +new_start,new_count @@
      const match = line.match(/^@@\s.*\+(\d+)(?:,(\d+))?\s@@/);
      if (match) {
        const start = parseInt(match[1], 10);
        const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
        if (count > 0) {
          ranges.push({ start, count, end: start + count - 1 });
        }
      }
    }
    return ranges.length > 0 ? ranges : null;
  } catch (_) {
    return null;
  }
}

/**
 * Write a Git Note on HEAD linking this edit to the session.
 */
function writeEditNote(sessionId, user, filePath, lineRanges, checkpoint) {
  if (!gitNotes) return;
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!headSha || !/^[0-9a-f]{40}$/.test(headSha)) return;

    const noteData = {
      session_id: sessionId,
      user,
      file: filePath,
      ts: new Date().toISOString(),
      type: "ai_edit",
    };
    if (lineRanges) {
      noteData.lines_changed = lineRanges.map((r) => `${r.start}-${r.end}`);
    }
    if (checkpoint) {
      noteData.checkpoint = checkpoint.topic;
    }
    gitNotes.writeNote(headSha, noteData);
  } catch (_) {
    // ignore — notes are best-effort
  }
}

// ── Main ──────────────────────────────────────────────────

function main() {
  let hookInput = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, "utf-8").trim();
      if (raw) {
        hookInput = JSON.parse(raw);
      }
    }
  } catch (_) {
    hookInput = {};
  }

  const sessionId = getSessionId(hookInput);

  let toolName = hookInput.tool_name || "unknown";
  if (toolName === "unknown") {
    const toolObj = hookInput.tool || "unknown";
    if (toolObj && typeof toolObj === "object") {
      toolName = toolObj.name || "unknown";
    } else if (typeof toolObj === "string") {
      toolName = toolObj;
    }
  }
  if (toolName === "unknown") {
    for (const key of ["toolName", "name"]) {
      const val = hookInput[key];
      if (val && typeof val === "string") {
        toolName = val;
        break;
      }
    }
  }

  const filePath = extractFilePath(hookInput);
  if (!filePath) {
    logDebug(toolName, hookInput);
  }

  const user = getUser();
  const now = new Date().toISOString();
  const isWriteTool = WRITE_TOOLS.has(toolName);

  // V2.5: Capture line-level changes for write tools
  let lineRanges = null;
  let checkpoint = null;
  if (isWriteTool && filePath) {
    lineRanges = captureLineChanges(filePath);
    if (gitNotes) {
      checkpoint = gitNotes.getCurrentCheckpoint();
    }
  }

  const entry = {
    type: "tool_use",
    user,
    ts: now,
    tool: toolName,
    session_id: sessionId,
  };
  if (filePath) {
    entry.file = filePath;
  }
  if (lineRanges) {
    entry.lines_changed = lineRanges.map((r) => `${r.start}-${r.end}`);
  }
  if (checkpoint) {
    entry.checkpoint_topic = checkpoint.topic;
  }
  appendAuditLine(entry);

  updatePresence(user, filePath);

  // V2.5: Write Git Note for write tools
  if (isWriteTool && filePath) {
    writeEditNote(sessionId, user, filePath, lineRanges, checkpoint);
  }

  const serverName = autoDetectMcp(toolName);
  if (serverName) {
    const configPath = getConfigPath();
    const config = loadJson(configPath, { stale_days: 14, mcp_servers: [] });
    const mcpServers = config.mcp_servers || [];
    const knownNames = new Set(
      mcpServers.map((s) => (typeof s === "object" ? s.name : s))
    );
    if (!knownNames.has(serverName)) {
      mcpServers.push({ name: serverName, source: "auto-detected" });
      config.mcp_servers = mcpServers;
      saveJson(configPath, config);
    }
  }

  // Build status message for transparency
  // Write to stderr + exit 2 so Claude sees the message (stdout exit 0 is user-only)
  const linePart = lineRanges && lineRanges.length > 0 ? ` (lines ${lineRanges.map(r => `${r.start}-${r.end}`).join(", ")})` : "";
  const statusMsg = `[STICKY-NOTE] Tracked ${toolName}${filePath ? " on " + filePath : ""}${linePart}`;

  process.stderr.write(statusMsg + "\n");
  process.exit(2);
}

try {
  main();
} catch (_) {
  safeExit();
}
