#!/usr/bin/env node
"use strict";
/**
 * on-stop.js — Handoff Summary Generation (V2)
 *
 * Hook: Stop (Claude Code)
 * Generates a structured handoff_summary on the current thread.
 */

const crypto = require("crypto");

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
  getMemoryPath,
  loadJson,
  saveJson,
  appendAuditLine,
  getUser,
  getBranch,
  getSessionId,
  detectTool,
} = utils;

function buildHandoffSummary(thread, reason) {
  const parts = [];
  const files = thread.files_touched || [];
  const workType = thread.work_type || "general";
  const note = thread.last_note || "";

  if (files.length) {
    parts.push(`What done: ${workType} on ${files.slice(0, 5).join(", ")}`);
  } else if (note) {
    parts.push(`What done: ${note}`);
  }

  const failed = thread.failed_approaches || [];
  if (failed.length) {
    const descs = failed.slice(0, 3).map((a) => (a.description || "").substring(0, 60));
    parts.push(`What failed: ${descs.join("; ")}`);
  }

  const narrative = thread.narrative || "";
  if (narrative) {
    parts.push(`Status: ${narrative.substring(0, 150)}`);
  }

  if (reason) {
    parts.push(`Next: ${reason.substring(0, 100)}`);
  }

  return parts.length ? parts.join(" | ") : "Session stopped -- no summary available";
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
  const user = getUser();
  const now = new Date().toISOString();
  const reason = hookInput.reason || "";

  const memoryPath = getMemoryPath();
  const memory = loadJson(memoryPath, { version: "2", project: "", threads: [] });

  const threads = memory.threads || [];
  let found = false;

  for (const thread of threads) {
    if (thread.session_id === sessionId && (thread.status === "open" || thread.status === "stuck")) {
      thread.last_activity_at = now;
      thread.handoff_summary = buildHandoffSummary(thread, reason);
      if (reason) {
        thread.last_note = reason.substring(0, 200);
      }
      found = true;
      break;
    }
  }

  if (!found && sessionId !== "unknown") {
    const thread = {
      id: crypto.randomUUID(),
      user,
      project: memory.project || "",
      status: "closed",
      branch: getBranch(),
      created_at: now,
      closed_at: now,
      last_activity_at: now,
      files_touched: [],
      last_note: reason ? reason.substring(0, 200) : "Session stopped",
      narrative: "",
      failed_approaches: [],
      handoff_summary: buildHandoffSummary({}, reason),
      related_session_ids: [],
      tool: detectTool(hookInput),
      session_id: sessionId,
    };
    threads.push(thread);
  }

  appendAuditLine({
    type: "stop",
    user,
    ts: now,
    session_id: sessionId,
    reason: reason ? reason.substring(0, 200) : "stop_checkpoint",
  });

  saveJson(memoryPath, memory);
  const reasonStr = reason ? reason.substring(0, 60) : "checkpoint";
  const statusMsg = `[STICKY-NOTE] Session stopped — handoff saved (${reasonStr})`;
  process.stdout.write(JSON.stringify({ output: statusMsg }) + "\n");
}

try {
  main();
} catch (_) {
  safeExit();
}
