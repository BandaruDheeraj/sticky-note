#!/usr/bin/env node
"use strict";
/**
 * on-stop.js — Handoff Summary Generation (V2)
 *
 * Hook: Stop (Claude Code)
 * Generates a structured handoff_summary on the current thread.
 */

const crypto = require("crypto");
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

const {
  getMemoryPath,
  loadJson,
  saveJson,
  saveMemoryMerged,
  appendAuditLine,
  getUser,
  getBranch,
  getSessionId,
  detectTool,
  extractSessionFromAudit,
  readHeadSha,
  normalizeSep,
  useCloud,
  cloudReadThreads,
  cloudWriteThread,
  cloudAppendAudit,
} = utils;

// Files that belong to sticky-note internals — exclude from files_touched.
const STICKY_FILES_PREFIX = [
  ".sticky-note/sticky-note.json",
  ".sticky-note/sticky-note-audit.jsonl",
  ".sticky-note/audit/",
  ".sticky-note/presence/",
  ".sticky-note/.sticky-session",
  ".sticky-note/.sticky-head",
  ".sticky-note/.sticky-resume",
  ".sticky-note/.sticky-debug.jsonl",
  ".sticky-note/sticky-note-config.json",
  ".sticky-note/.sticky-presence.json",
  ".sticky-note/.sticky-injected",
  ".sticky-note/.sticky-active-resume",
];

/**
 * Collect files changed since session start using git diff.
 * Mirrors getGitFilesTouched() from session-end.js.
 */
function getGitFilesTouched() {
  const files = new Set();
  const savedSha = readHeadSha();

  try {
    if (savedSha && /^[0-9a-f]+$/i.test(savedSha)) {
      const result = execFileSync("git", ["diff", "--name-only", savedSha, "HEAD"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      for (const f of result.trim().split(/\r?\n/)) {
        const trimmed = f.trim();
        if (trimmed) files.add(trimmed);
      }
    }

    const unstaged = execFileSync("git", ["diff", "--name-only"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const f of unstaged.trim().split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) files.add(trimmed);
    }

    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const f of staged.trim().split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch (_) {
    // ignore — git may not be available
  }

  return Array.from(files).filter((f) => {
    const normalized = normalizeSep(f);
    return !STICKY_FILES_PREFIX.some((p) => normalized === p || normalized.startsWith(p));
  });
}

/**
 * Build a narrative string from audit trail prompts.
 * Mirrors the audit-fallback path from session-end.js extractNarrative().
 */
function buildNarrativeFromAudit(auditData) {
  const prompts = auditData.prompts || [];
  if (!prompts.length) return "";
  if (prompts.length === 1) return prompts[0].substring(0, 300).trim();
  let summary = prompts[0].substring(0, 150).trim();
  if (prompts.length > 2) {
    summary += ` ... (${prompts.length} prompts total) ... ${prompts[prompts.length - 1].substring(0, 100).trim()}`;
  } else {
    summary += ` -> ${prompts[prompts.length - 1].substring(0, 100).trim()}`;
  }
  return summary.substring(0, 300);
}

/**
 * Classify work type from audit tool counts (lightweight version of
 * analyzeSessionActivities from session-end.js).
 */
function classifyWorkType(auditData) {
  const tools = auditData.tools || {};
  const files = auditData.files || [];
  const editLike = new Set(["edit", "create", "write", "Edit", "Write", "Create", "MultiEdit", "multi_edit"]);
  let editCount = 0;
  for (const [t, c] of Object.entries(tools)) {
    if (editLike.has(t)) editCount += c;
  }
  const readCount = tools["Read"] || tools["read"] || 0;
  if (editCount > 0) return "feature-development";
  if (readCount > 0 && editCount === 0) return "code-review";
  if (files.length > 0) return "general";
  return "general";
}

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

async function main() {
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

  const cloud = useCloud();
  const memoryPath = getMemoryPath();
  const memory = loadJson(memoryPath, { version: "2", project: "", threads: [] });

  if (cloud) {
    const cloudThreads = await cloudReadThreads();
    if (cloudThreads) memory.threads = cloudThreads;
  }

  // Extract session data from audit trail and git (the key fix —
  // previously this hook created bare threads with no context).
  const auditData = extractSessionFromAudit(sessionId);
  const auditFiles = auditData.files || [];
  const gitFiles = getGitFilesTouched();
  const allFiles = [...new Set([...auditFiles, ...gitFiles])];
  const narrative = buildNarrativeFromAudit(auditData);
  const workType = classifyWorkType(auditData);

  const threads = (memory.threads || []).filter(Boolean);
  let found = false;

  for (const thread of threads) {
    if (thread.session_id === sessionId) {
      thread.last_activity_at = now;
      // Enrich with extracted data
      if (allFiles.length) {
        thread.files_touched = [...new Set([...(thread.files_touched || []), ...allFiles])];
      }
      if (narrative && !thread.narrative) {
        thread.narrative = narrative;
      }
      if (workType !== "general" || !thread.work_type) {
        thread.work_type = workType;
      }
      // Merge audit tool counts
      const auditTools = auditData.tools || {};
      const prevCalls = thread.tool_calls || {};
      for (const [tn, cnt] of Object.entries(auditTools)) {
        prevCalls[tn] = (prevCalls[tn] || 0) + cnt;
      }
      thread.tool_calls = prevCalls;
      // Store prompts if not already present
      const storedPrompts = (auditData.prompts || []).slice(0, 20).map((p) => p.substring(0, 300));
      if (storedPrompts.length && !(thread.prompts || []).length) {
        thread.prompts = storedPrompts;
      }

      thread.handoff_summary = buildHandoffSummary(thread, reason);
      if (reason) {
        thread.last_note = reason.substring(0, 200);
      }
      found = true;
      break;
    }
  }
  // If no thread exists for this session, skip — session-start.js creates the
  // thread now. Creating standalone threads from Stop events produced duplicates
  // when session-end.js had already closed the thread (status filter mismatch).

  const auditEntry = {
    type: "stop",
    user,
    ts: now,
    session_id: sessionId,
    reason: reason ? reason.substring(0, 200) : "stop_checkpoint",
  };
  appendAuditLine(auditEntry);
  if (cloud) {
    cloudAppendAudit(auditEntry).catch(() => {});
  }

  saveMemoryMerged(memoryPath, memory);
  if (cloud) {
    const threadToSync = threads.find(t => t.session_id === sessionId);
    if (threadToSync) {
      cloudWriteThread(threadToSync).catch(() => {});
    }
  }
  const reasonStr = reason ? reason.substring(0, 60) : "checkpoint";
  const fileCount = allFiles.length;
  const statusMsg = `[STICKY-NOTE] Session stopped - handoff saved (${reasonStr}, ${fileCount} file${fileCount !== 1 ? "s" : ""})`;
  try {
    process.stdout.write(JSON.stringify({ output: statusMsg }) + "\n");
  } catch (_) {
    process.stdout.write('{"output":""}\n');
  }
  process.exit(0);
}

main().catch((err) => {
  try { utils.logHookError("on-stop", err); } catch (_) {}
  safeExit();
});
