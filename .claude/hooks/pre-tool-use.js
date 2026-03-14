#!/usr/bin/env node
"use strict";
/**
 * pre-tool-use.js — Lazy Injection via PreToolUse Hook (V2.5)
 *
 * Hook: PreToolUse (Claude Code) / preToolUse (Copilot CLI)
 * Fires BEFORE each tool call. If the tool targets a file, runs
 * git blame → attribution engine to find threads that authored
 * lines in that file, and injects them as system context with
 * line-range detail.
 *
 * Dedup: each thread is only injected once per session via the
 * .sticky-injected tracking file.
 *
 * No external dependencies — uses built-in git blame.
 */

// ── Output helpers ────────────────────────────────────────

function _isCopilotCli() {
  return process.argv.includes("--copilot-cli") || !!process.env.COPILOT_CLI;
}

function _emit(text) {
  if (text === undefined) text = "";
  if (_isCopilotCli()) {
    process.stdout.write(JSON.stringify({ additionalContext: text }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ output: text }) + "\n");
  }
}

function _safeExit() {
  try {
    _emit("");
  } catch (_) {
    process.stdout.write('{"output": ""}\n');
  }
  process.exit(0);
}

// ── Import dependencies ───────────────────────────────────

let utils, attribution;
try {
  utils = require("./sticky-utils.js");
} catch (_) {
  _safeExit();
}

try {
  attribution = require("./sticky-attribution.js");
} catch (_) {
  // Attribution engine not available — skip lazy injection
  _safeExit();
}

const {
  getSessionId,
  getUser,
  appendAuditLine,
  isThreadInjected,
  markThreadInjected,
  isOverlapWarned,
  markOverlapWarned,
  getMemoryPath,
  loadJson,
  normalizeSep,
} = utils;

// ── File path extraction from tool input ──────────────────

function extractFilePath(hookInput) {
  const toolInput = hookInput.tool_input || hookInput.input || hookInput.toolArgs || {};

  if (typeof toolInput === "object" && toolInput !== null) {
    for (const key of ["file_path", "filePath", "path", "file", "filename"]) {
      if (toolInput[key] && typeof toolInput[key] === "string") {
        return toolInput[key];
      }
    }
    if (toolInput.command && typeof toolInput.command === "string") {
      return extractFileFromCommand(toolInput.command);
    }
  }

  return null;
}

function extractFileFromCommand(command) {
  const tokens = command.split(/\s+/);
  for (const token of tokens) {
    if (token.includes("/") || token.includes("\\")) {
      if (/\.\w{1,10}$/.test(token)) {
        return token;
      }
    }
  }
  return null;
}

// ── Thread formatting for injection ───────────────────────

function formatThreadForInjection(threadData, file) {
  const thread = threadData.thread || threadData;
  const lineRanges = threadData.line_ranges || threadData._line_ranges || [];
  const tier = threadData.tier || threadData._tier || "";

  const user = thread.user || thread.author || "unknown";
  const status = thread.status || "open";
  const statusTag = status === "stuck" ? "[STUCK]" : status === "open" ? "[OPEN]" : "[CLOSED]";
  const branch = thread.branch || "";
  const branchStr = branch ? ` (${branch})` : "";

  const lineStr = lineRanges.length > 0 ? ` [lines ${lineRanges.join(", ")}]` : "";

  const lines = [
    `[STICKY-NOTE] ${statusTag} ${user}'s thread on ${file}${lineStr}${branchStr}:`,
  ];

  if (thread.narrative) {
    lines.push(thread.narrative.substring(0, 200));
  } else if (thread.last_note) {
    lines.push(thread.last_note.substring(0, 150));
  }

  const failed = thread.failed_approaches || [];
  if (failed.length > 0) {
    lines.push(`[!] ${failed.length} failed approach(es) - check thread ${(thread.id || "").substring(0, 8)} for details`);
  }

  if (thread.handoff_summary) {
    lines.push(`Handoff: ${thread.handoff_summary.substring(0, 150)}`);
  }

  return lines.join("\n");
}

// ── Overlap detection via preToolUse deny (Copilot CLI only) ──
// Copilot CLI ignores output from all hooks except preToolUse "deny".
// On the FIRST tool call of a session, if we detect file overlaps with
// other users' threads, we deny the tool call with the overlap warning
// as the reason. The AI reports the denial to the user, then retries.
// Subsequent tool calls proceed normally.

const { execSync } = require("child_process");

function _getRecentlyModifiedFiles() {
  const files = new Set();
  for (const target of ["HEAD~5", "HEAD~1"]) {
    try {
      const result = execSync(`git diff --name-only ${target}`, {
        encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      });
      for (const f of result.trim().split(/\r?\n/)) {
        if (f.trim()) files.add(f.trim());
      }
      break;
    } catch (_) { /* target doesn't exist */ }
  }
  try {
    const result = execSync("git diff --name-only", {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
    for (const f of result.trim().split(/\r?\n/)) {
      if (f.trim()) files.add(f.trim());
    }
  } catch (_) { /* ignore */ }
  return files;
}

function _checkOverlapsAndDeny(hookInput) {
  if (!_isCopilotCli()) return null;

  const sessionId = getSessionId(hookInput);
  if (isOverlapWarned(sessionId)) return null;

  // Load threads
  let threads;
  try {
    const memPath = getMemoryPath();
    const data = loadJson(memPath);
    threads = data.threads || [];
  } catch (_) {
    return null;
  }

  const currentUser = getUser();
  const modifiedFiles = _getRecentlyModifiedFiles();
  if (modifiedFiles.size === 0) return null;

  const activeThreads = threads.filter(
    (t) => t.status === "open" || t.status === "stuck"
  );

  const warnings = [];
  for (const thread of activeThreads) {
    const threadUser = thread.user || thread.author || "";
    if (threadUser === currentUser) continue;
    const threadFiles = (thread.files_touched || []).map(normalizeSep);
    const overlap = threadFiles.filter((f) => modifiedFiles.has(f));
    if (overlap.length === 0) continue;
    warnings.push({ thread, overlap });
  }

  if (warnings.length === 0) return null;

  // Build a concise deny reason
  const lines = ["⚠️ OVERLAP DETECTED — someone else is working on files you're touching:"];
  for (const { thread, overlap } of warnings) {
    const user = thread.user || thread.author || "unknown";
    const status = thread.status === "stuck" ? "STUCK" : "OPEN";
    const narrative = thread.narrative || thread.last_note || "";
    const snip = narrative.length > 80 ? narrative.substring(0, 80) + "…" : narrative;
    lines.push(`  [${status}] ${user}: ${overlap.join(", ")}${snip ? " — " + snip : ""}`);
  }
  lines.push("Consider coordinating before proceeding. This tool call will be auto-retried.");

  // Mark as warned so subsequent tool calls aren't blocked
  markOverlapWarned(sessionId);

  // Audit the overlap deny
  try {
    appendAuditLine({
      type: "overlap_deny",
      user: currentUser,
      ts: new Date().toISOString(),
      session_id: sessionId,
      warnings_count: warnings.length,
      threads: warnings.map((w) => ({
        user: w.thread.user || w.thread.author,
        files: w.overlap,
      })),
    });
  } catch (_) { /* ignore */ }

  return {
    permissionDecision: "deny",
    permissionDecisionReason: lines.join("\n"),
  };
}

// ── Main ──────────────────────────────────────────────────

function main() {
  let hookInput = {};
  try {
    const raw = require("fs").readFileSync(0, "utf-8");
    if (raw.trim()) {
      hookInput = JSON.parse(raw);
    }
  } catch (_) {
    hookInput = {};
  }

  const sessionId = getSessionId(hookInput);

  // ── Overlap deny gate (Copilot CLI only) ──
  // On first tool call, deny with overlap warning if applicable.
  const denyResult = _checkOverlapsAndDeny(hookInput);
  if (denyResult) {
    process.stdout.write(JSON.stringify(denyResult) + "\n");
    return;
  }

  // Extract file path from tool input
  const filePath = extractFilePath(hookInput);
  if (!filePath) {
    _emit("");
    return;
  }

  // Run attribution engine: get threads for this file with line ranges
  let fileAttr;
  try {
    fileAttr = attribution.getFileAttribution(filePath);
  } catch (_) {
    _emit("");
    return;
  }

  if (!fileAttr || !fileAttr.threads || fileAttr.threads.length === 0) {
    _emit("");
    return;
  }

  // Filter out already-injected threads
  const newThreads = fileAttr.threads.filter(
    (t) => !isThreadInjected(t.thread ? t.thread.id : t.id, sessionId)
  );

  if (newThreads.length === 0) {
    _emit("");
    return;
  }

  // Build injection output with line-range detail
  const outputParts = [];
  for (const threadData of newThreads) {
    const threadId = threadData.thread ? threadData.thread.id : threadData.id;
    outputParts.push(formatThreadForInjection(threadData, filePath));
    markThreadInjected(threadId, sessionId);
  }

  const output = outputParts.join("\n\n");

  // Audit the injection
  try {
    appendAuditLine({
      type: "lazy_inject",
      user: getUser(),
      ts: new Date().toISOString(),
      session_id: sessionId,
      file: filePath,
      threads_injected: newThreads.length,
      thread_ids: newThreads.map((t) => {
        const id = t.thread ? t.thread.id : t.id;
        return (id || "").substring(0, 8);
      }),
    });
  } catch (_) {
    // ignore
  }

  _emit(output);
}

// ── Entry point ───────────────────────────────────────────

if (require.main === module) {
  try {
    main();
  } catch (_) {
    _safeExit();
  }
}
