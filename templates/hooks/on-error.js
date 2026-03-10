#!/usr/bin/env node
"use strict";
/**
 * on-error.js — Stuck Thread (V2)
 *
 * Hook: errorOccurred (Copilot CLI) / PostToolUseFailure (Claude Code)
 * Writes a thread with status="stuck" and captures the error message.
 * Appends JSONL audit line.
 */

const crypto = require("crypto");

function _safeExit() {
  try {
    process.stdout.write(JSON.stringify({ output: "" }) + "\n");
  } catch (_) {
    process.stdout.write('{"output":""}\n');
  }
  process.exit(0);
}

let getMemoryPath, loadJson, saveJson, appendAuditLine, getUser, detectTool, getSessionId;
try {
  ({
    getMemoryPath,
    loadJson,
    saveJson,
    appendAuditLine,
    getUser,
    detectTool,
    getSessionId,
  } = require("./sticky-utils.js"));
} catch (_) {
  _safeExit();
}

function main() {
  let hookInput = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = require("fs").readFileSync(0, "utf-8").trim();
      if (raw) {
        hookInput = JSON.parse(raw);
      }
    }
  } catch (_) {
    hookInput = {};
  }

  const sessionId = getSessionId(hookInput);
  let toolName = hookInput.tool_name || process.env.TOOL_NAME || "unknown";
  if (toolName === "unknown") {
    toolName = detectTool(hookInput);
  }
  const errorMsg = (hookInput.error || hookInput.message || "Unknown error").substring(0, 200);
  const user = getUser();
  const now = new Date().toISOString();

  const memoryPath = getMemoryPath();
  const memory = loadJson(memoryPath, { version: "2", project: "", threads: [] });

  if (!Array.isArray(memory.threads)) {
    memory.threads = [];
  }
  const threads = memory.threads;

  let existing = null;
  for (const thread of threads) {
    if (thread.session_id === sessionId) {
      existing = thread;
      break;
    }
  }

  if (existing) {
    existing.status = "stuck";
    existing.last_note = errorMsg;
    existing.last_activity_at = now;
    if (!Array.isArray(existing.failed_approaches)) {
      existing.failed_approaches = [];
    }
    existing.failed_approaches.push({
      description: errorMsg.substring(0, 150),
      error: errorMsg.substring(0, 100),
    });
    // Cap at 5 entries
    if (existing.failed_approaches.length > 5) {
      existing.failed_approaches = existing.failed_approaches.slice(-5);
    }
  } else {
    const thread = {
      id: crypto.randomUUID(),
      user: user,
      project: memory.project || "",
      status: "stuck",
      branch: "",
      created_at: now,
      closed_at: null,
      last_activity_at: now,
      files_touched: [],
      last_note: errorMsg,
      narrative: "",
      failed_approaches: [{ description: errorMsg.substring(0, 150), error: errorMsg.substring(0, 100) }],
      handoff_summary: "",
      related_session_ids: [],
      tool: toolName,
      session_id: sessionId,
    };
    threads.push(thread);
  }

  appendAuditLine({
    type: "error",
    user: user,
    ts: now,
    session_id: sessionId,
    error: errorMsg,
    tool: toolName,
  });

  saveJson(memoryPath, memory);
  const statusMsg = `[STICKY-NOTE] Marked thread as STUCK - ${errorMsg.substring(0, 80)}`;
  try {
    process.stdout.write(JSON.stringify({ output: statusMsg }) + "\n");
  } catch (_) {
    process.stdout.write('{"output":""}\n');
  }
  process.exit(0);
}

try {
  main();
} catch (_) {
  _safeExit();
}
