#!/usr/bin/env node
"use strict";
/**
 * track-work.js — Audit Trail (V2)
 *
 * Hook: PostToolUse (Claude Code) / postToolUse (Copilot CLI)
 * Appends one JSONL line per tool call. Updates presence heartbeat.
 */

const fs = require("fs");
const path = require("path");

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

const {
  getConfigPath,
  getPresencePath,
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

  for (const containerKey of ["tool_input", "input", "toolInput", "params"]) {
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
  const presencePath = getPresencePath();
  try {
    const data = loadJson(presencePath, {});
    const entry = data[user] || { active_files: [], last_seen: "" };

    if (filePath) {
      const active = entry.active_files || [];
      if (!active.includes(filePath)) {
        active.push(filePath);
      }
      // Deduplicate and keep last 10
      entry.active_files = [...new Set(active)].slice(-10);
    }

    entry.last_seen = new Date().toISOString();
    data[user] = entry;
    saveJson(presencePath, data);
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
  appendAuditLine(entry);

  updatePresence(user, filePath);

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

  process.stdout.write(JSON.stringify({ output: "" }) + "\n");
}

try {
  main();
} catch (_) {
  safeExit();
}
