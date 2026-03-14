#!/usr/bin/env node
"use strict";
/**
 * session-start.js -- Session Start Hook (V2)
 *
 * Hook: SessionStart (Claude Code) / sessionStart (Copilot CLI)
 * Loads open+stuck threads, ages stale threads, injects context.
 * Reads presence file if recent. Writes audit line to JSONL.
 */

const crypto = require("crypto");
const path = require("path");

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
    process.stdout.write('{"output":""}\n');
  }
  process.exit(0);
}

let utils;
try {
  utils = require("./sticky-utils.js");
} catch (_) {
  _safeExit();
}

const {
  getMemoryPath,
  getConfigPath,
  getAllPresencePaths,
  migrateAuditAndPresence,
  loadJson,
  saveJson,
  saveMemoryMerged,
  appendAuditLine,
  getUser,
  getSessionId,
  getResumeThreadId,
  findThreadById,
  saveSessionId,
  saveHeadSha,
  detectTool,
  clearInjectedSet,
  markThreadInjected,
  clearActiveResumeThreadId,
  getActiveResumeThreadId,
  normalizeSep,
} = utils;

// ── Stale-thread ageing ───────────────────────────────────

function ageStaleThreads(memory, staleDays) {
  const now = Date.now();
  let changed = false;
  for (const thread of memory.threads || []) {
    if (thread.status !== "open" && thread.status !== "stuck") continue;
    const tsField =
      thread.last_activity_at || thread.updated_at || thread.created_at || "";
    if (!tsField) continue;
    try {
      const ts = new Date(tsField).getTime();
      if (isNaN(ts)) continue;
      const diffDays = (now - ts) / (1000 * 60 * 60 * 24);
      if (diffDays >= staleDays && thread.status === "open") {
        thread.status = "stale";
        thread.last_activity_at = new Date().toISOString();
        changed = true;
      }
    } catch (_) {
      continue;
    }
  }
  return changed;
}

// Auto-close Copilot CLI threads that have been inactive beyond a threshold.
// Copilot CLI has no session-end signal, so threads stay open indefinitely.
// This closes them after configurable inactivity (default 24h).
function autoCloseCopilotCliThreads(memory, autoCloseHours) {
  const now = Date.now();
  let changed = false;
  for (const thread of memory.threads || []) {
    if (thread.status !== "open") continue;
    if (thread.tool !== "copilot-cli") continue;
    const tsField =
      thread.last_activity_at || thread.updated_at || thread.created_at || "";
    if (!tsField) continue;
    try {
      const ts = new Date(tsField).getTime();
      if (isNaN(ts)) continue;
      const diffHours = (now - ts) / (1000 * 60 * 60);
      if (diffHours >= autoCloseHours) {
        thread.status = "closed";
        thread.closed_at = new Date().toISOString();
        changed = true;
      }
    } catch (_) {
      continue;
    }
  }
  return changed;
}

// ── Formatting helpers ────────────────────────────────────

function formatThreadsForInjection(threads, maxThreads, maxTokens) {
  maxThreads = maxThreads || 10;
  maxTokens = maxTokens || 500;

  // V2.5: Eager injection only for stuck threads.
  // Non-stuck threads are handled by lazy injection (PreToolUse hook).
  const active = (threads || []).filter(
    (t) => t.status === "stuck"
  );
  active.sort((a, b) => {
    const aTime = a.last_activity_at || a.updated_at || "";
    const bTime = b.last_activity_at || b.updated_at || "";
    return bTime.localeCompare(aTime);
  });
  const capped = active.slice(0, maxThreads);
  if (capped.length === 0) return { text: "", threadIds: [] };

  const lines = ["## [STICKY-NOTE] [!] Stuck Threads (eager injection)\n"];
  let tokenEstimate = 10;
  const injectedIds = [];

  for (let i = 0; i < capped.length; i++) {
    const t = capped[i];
    const workType = t.work_type || "";
    const typeLabel =
      workType && workType !== "general" ? `[${workType}] ` : "";
    const author = t.user || t.author || "unknown";
    const files = (t.files_touched || []).slice(0, 5).join(", ");
    const note = (t.last_note || "").substring(0, 100);
    const narrative = t.narrative || "";
    const branch = t.branch || "";

    let line = `- [STUCK] ${typeLabel}**${author}**`;
    if (branch) line += ` (${branch})`;
    line += `: ${files}`;
    if (narrative) {
      line += ` -- _${narrative.substring(0, 100)}_`;
    } else if (note) {
      line += ` -- _${note}_`;
    }

    const failed = t.failed_approaches || [];
    if (failed.length > 0) {
      line += `\n  [!] ${failed.length} failed approach(es)`;
      for (const fa of failed.slice(0, 2)) {
        const desc = (fa.description || "").substring(0, 80);
        line += `\n    - ${desc}`;
      }
    }

    tokenEstimate += Math.floor(line.length / 4);
    if (tokenEstimate > maxTokens) {
      lines.push(
        `- ... and ${capped.length - lines.length + 1} more stuck threads`
      );
      break;
    }
    lines.push(line);
    injectedIds.push(t.id);
  }

  lines.push("\n_Other threads are injected lazily when you touch their files._");
  return { text: lines.join("\n"), threadIds: injectedIds };
}

function formatConfigForInjection(config) {
  const lines = [];
  const conventions = config.conventions || [];
  if (conventions.length > 0) {
    lines.push("\n## Team Conventions");
    for (const c of conventions.slice(0, 10)) {
      lines.push(`- ${c}`);
    }
  }
  const mcpServers = config.mcp_servers || [];
  if (mcpServers.length > 0) {
    lines.push("\n## MCP Servers");
    for (const s of mcpServers.slice(0, 5)) {
      if (s && typeof s === "object") {
        lines.push(`- ${s.name || "unnamed"}: ${s.url || ""}`);
      } else {
        lines.push(`- ${s}`);
      }
    }
  }
  return lines.length ? lines.join("\n") : "";
}

function loadAllPresence() {
  const data = {};
  for (const filePath of getAllPresencePaths()) {
    try {
      const basename = path.basename(filePath, ".json");
      const info = loadJson(filePath, null);
      if (info && info.last_seen) {
        data[basename] = info;
      }
    } catch (_) {
      continue;
    }
  }
  return data;
}

function formatPresence(presenceData, threads) {
  const now = Date.now();
  const active = [];

  // Build a map of user → most recent open/stuck thread
  const userThreads = {};
  for (const t of (threads || [])) {
    if (t.status !== "open" && t.status !== "stuck") continue;
    const user = t.user || t.author || "";
    if (!user) continue;
    const existing = userThreads[user];
    if (!existing) {
      userThreads[user] = t;
    } else {
      const existingTs = existing.last_activity_at || existing.created_at || "";
      const thisTs = t.last_activity_at || t.created_at || "";
      if (thisTs > existingTs) userThreads[user] = t;
    }
  }

  for (const [user, info] of Object.entries(presenceData || {})) {
    const lastSeen = info.last_seen || "";
    if (!lastSeen) continue;
    try {
      const ts = new Date(lastSeen).getTime();
      if (isNaN(ts)) continue;
      if (now - ts < 15 * 60 * 1000) {
        const files = (info.active_files || []).slice(0, 3).join(", ");
        const thread = userThreads[user];
        let line = `- **${user}**`;
        if (thread) {
          const narrative = thread.narrative || thread.last_note || "";
          const snip = narrative.length > 60
            ? narrative.substring(0, 60) + "…"
            : narrative;
          const status = thread.status === "stuck" ? " [STUCK]" : "";
          line += `${status}: ${snip || files}`;
          if (snip && files) line += ` (${files})`;
        } else {
          line += ` active on: ${files}`;
        }
        active.push(line);
      }
    } catch (_) {
      continue;
    }
  }
  if (active.length === 0) return "";
  return "\n## Active Now\n" + active.join("\n");
}

// ── Overlap detection ─────────────────────────────────────

function getRecentlyModifiedFiles() {
  const files = new Set();
  const diffTargets = ["HEAD~5", "HEAD~1"];
  for (const target of diffTargets) {
    try {
      const result = require("child_process").execSync(
        `git diff --name-only ${target}`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      for (const f of result.trim().split(/\r?\n/)) {
        const trimmed = f.trim();
        if (trimmed) files.add(normalizeSep(trimmed));
      }
      break;
    } catch (_) {}
  }
  try {
    const result = require("child_process").execSync("git diff --name-only", {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
    for (const f of result.trim().split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) files.add(normalizeSep(trimmed));
    }
  } catch (_) {}
  try {
    const result = require("child_process").execSync(
      "git diff --name-only --cached",
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    );
    for (const f of result.trim().split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) files.add(normalizeSep(trimmed));
    }
  } catch (_) {}
  return files;
}

function detectOverlaps(threads, currentUser) {
  const modifiedFiles = getRecentlyModifiedFiles();
  if (modifiedFiles.size === 0) return { warnings: [], claims: [] };

  const activeThreads = (threads || []).filter(
    (t) => t.status === "open" || t.status === "stuck"
  );

  const warnings = [];
  for (const thread of activeThreads) {
    const threadUser = thread.user || thread.author || "";
    if (threadUser === currentUser) continue; // skip own threads
    const threadFiles = (thread.files_touched || []).map(normalizeSep);
    const overlap = threadFiles.filter((f) => modifiedFiles.has(f));
    if (overlap.length === 0) continue;
    warnings.push({ thread, overlap });
  }

  // Sort: stuck first, then by overlap count
  warnings.sort((a, b) => {
    if (a.thread.status !== b.thread.status) {
      return a.thread.status === "stuck" ? -1 : 1;
    }
    return b.overlap.length - a.overlap.length;
  });

  return { warnings, modifiedFiles };
}

function formatOverlapWarnings(threads, currentUser, memory) {
  const { warnings, modifiedFiles } = detectOverlaps(threads, currentUser);
  const claims = (memory.claims || []).filter((c) => {
    if (c.user === currentUser) return false;
    if (!modifiedFiles || modifiedFiles.size === 0) return false;
    return (c.files || []).some((f) => modifiedFiles.has(normalizeSep(f)));
  });

  if (warnings.length === 0 && claims.length === 0) return "";

  const lines = [
    "## [STICKY-NOTE] ⚠️ OVERLAP DETECTED — TELL THE USER IMMEDIATELY\n",
    "**IMPORTANT: You MUST surface this warning to the user before doing anything else.**\n",
    "Someone else is working on files you're touching:\n",
  ];

  for (const { thread, overlap } of warnings) {
    const user = thread.user || thread.author || "unknown";
    const status = thread.status === "stuck" ? "[STUCK]" : "[OPEN]";
    const narrative = thread.narrative || thread.last_note || "";
    const narrativeSnip = narrative.length > 100
      ? narrative.substring(0, 100) + "…"
      : narrative;
    const branch = thread.branch ? ` on \`${thread.branch}\`` : "";
    const threadId = (thread.id || "").substring(0, 8);

    lines.push(`- ${status} **${user}**${branch}: ${overlap.join(", ")}`);
    if (narrativeSnip) lines.push(`  _${narrativeSnip}_`);
    const failed = thread.failed_approaches || [];
    if (failed.length > 0) {
      lines.push(`  ⚠️ ${failed.length} failed approach(es):`);
      for (const fa of failed.slice(0, 2)) {
        lines.push(`    - ${(fa.description || "").substring(0, 80)}`);
      }
    }
    if (threadId) {
      lines.push(`  → Resume: \`npx sticky-note resume ${threadId}\``);
    }
  }

  for (const claim of claims) {
    const ago = claim.claimed_at || "";
    lines.push(
      `- 📌 **${claim.user}** claimed: ${(claim.files || []).join(", ")}` +
        (claim.description ? ` — "${claim.description}"` : "")
    );
  }

  lines.push(
    "\n**Consider coordinating with these teammates before starting work.**"
  );

  // Write a visible banner directly to stderr so the user sees it
  const stderrLines = ["\n⚠️  OVERLAP DETECTED — someone else is touching your files:"];
  for (const { thread, overlap } of warnings) {
    const user = thread.user || thread.author || "unknown";
    const status = thread.status === "stuck" ? "STUCK" : "OPEN";
    const narrative = thread.narrative || thread.last_note || "";
    const narrativeSnip = narrative.length > 80
      ? narrative.substring(0, 80) + "…"
      : narrative;
    stderrLines.push(
      `   [${status}] ${user}: ${overlap.join(", ")}` +
      (narrativeSnip ? ` — ${narrativeSnip}` : "")
    );
  }
  stderrLines.push("");
  process.stderr.write(stderrLines.join("\n") + "\n");

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────

function main() {
  let hookInput = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = require("fs").readFileSync(0, "utf-8").trim();
      if (raw) hookInput = JSON.parse(raw);
    }
  } catch (_) {
    hookInput = {};
  }

  let sessionId = getSessionId(hookInput);
  const aiTool = detectTool(hookInput);
  const isCopilotCli = aiTool === "copilot-cli" || process.argv.includes("--copilot-cli") || !!process.env.COPILOT_CLI;

  if (sessionId === "unknown") {
    sessionId = crypto.randomUUID();
  }
  saveSessionId(sessionId);
  saveHeadSha();

  // V2.5: Only clear injected-this-session tracking for truly new sessions.
  // Copilot CLI fires SessionStart per-turn; clearing would lose dedup state.
  if (!isCopilotCli) {
    clearInjectedSet();
    clearActiveResumeThreadId();
  }

  // Migrate legacy single-file audit/presence to per-user dirs
  migrateAuditAndPresence();

  const memoryPath = getMemoryPath();
  const memory = loadJson(memoryPath, {
    version: "2",
    project: "",
    threads: [],
  });
  const config = loadJson(getConfigPath(), { stale_days: 14 });
  const staleDays = config.stale_days != null ? config.stale_days : 14;
  const autoCloseHours =
    config.copilot_cli_auto_close_hours != null
      ? config.copilot_cli_auto_close_hours
      : 24;

  ageStaleThreads(memory, staleDays);
  autoCloseCopilotCliThreads(memory, autoCloseHours);

  // ── Resume handling ───────────────────────────────────
  const resumeThreadId = getResumeThreadId();
  let resumedThread = null;
  if (resumeThreadId) {
    const threads = memory.threads || [];
    resumedThread = findThreadById(threads, resumeThreadId);
    if (resumedThread) {
      resumedThread.status = "open";
      resumedThread.related_session_ids = resumedThread.related_session_ids || [];
      resumedThread.related_session_ids.push(sessionId);
      resumedThread.last_activity_at = new Date().toISOString();

      const aiTool = detectTool(hookInput);
      const chain = resumedThread.resume_chain || [];
      const prevSession = chain.length
        ? chain[chain.length - 1].session_id
        : resumedThread.session_id || "";
      chain.push({
        session_id: sessionId,
        tool: aiTool,
        started_at: new Date().toISOString(),
        ended_at: null,
        resumed_from: prevSession,
      });
      resumedThread.resume_chain = chain;
      saveMemoryMerged(memoryPath, memory);
    }
  }

  // ── Build context pieces ──────────────────────────────
  const threadResult = formatThreadsForInjection(memory.threads || []);
  const threadContext = threadResult.text;
  const configContext = formatConfigForInjection(config);
  const presenceData = loadAllPresence();
  const presenceContext = formatPresence(presenceData, memory.threads || []);
  const overlapContext = formatOverlapWarnings(
    memory.threads || [], getUser(), memory
  );

  // V2.5: Mark eagerly-injected stuck threads so PreToolUse won't re-inject.
  // Skip for Copilot CLI — its sessionStart output is not surfaced to the AI,
  // so marking threads as injected would prevent inject-context from delivering them.
  if (!_isCopilotCli()) {
    for (const threadId of threadResult.threadIds) {
      markThreadInjected(threadId, sessionId);
    }
  }

  appendAuditLine({
    type: "session_start",
    user: getUser(),
    ts: new Date().toISOString(),
    session_id: sessionId,
  });

  saveMemoryMerged(memoryPath, memory);

  // ── Assemble output ───────────────────────────────────
  const parts = [];

  if (resumedThread) {
    const resumeLines = [
      `## [STICKY-NOTE] Resumed Thread -- ${(resumedThread.id || "").substring(0, 8)}\n`,
    ];
    const files = (resumedThread.files_touched || []).slice(0, 10).join(", ");
    if (files) resumeLines.push(`**Files:** ${files}`);
    if (resumedThread.branch)
      resumeLines.push(`**Branch:** ${resumedThread.branch}`);
    const workType = resumedThread.work_type || "";
    if (workType && workType !== "general")
      resumeLines.push(`**Work type:** ${workType}`);
    const activities = resumedThread.activities || [];
    if (activities.length)
      resumeLines.push(`**Activities:** ${activities.slice(0, 6).join(", ")}`);
    const toolCalls = resumedThread.tool_calls || {};
    const toolEntries = Object.entries(toolCalls);
    if (toolEntries.length) {
      toolEntries.sort((a, b) => b[1] - a[1]);
      const callsStr = toolEntries
        .slice(0, 10)
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ");
      resumeLines.push(`**Tool calls:** ${callsStr}`);
    }
    if (resumedThread.narrative) {
      resumeLines.push(`**Context:** ${resumedThread.narrative}`);
    } else if (resumedThread.last_note) {
      resumeLines.push(`**Context:** ${resumedThread.last_note}`);
    }
    const failed = resumedThread.failed_approaches || [];
    if (failed.length) {
      resumeLines.push(`**WARNING: ${failed.length} failed approach(es):**`);
      for (const fa of failed.slice(0, 3)) {
        const desc = (fa.description || "").substring(0, 100);
        resumeLines.push(`  - ${desc}`);
      }
    }
    if (resumedThread.handoff_summary)
      resumeLines.push(`**Handoff:** ${resumedThread.handoff_summary}`);
    const prompts = resumedThread.prompts || [];
    if (prompts.length) {
      resumeLines.push(`\n**Conversation log (${prompts.length} prompt(s)):**`);
      for (let i = 0; i < prompts.length; i++) {
        resumeLines.push(`  ${i + 1}. User: ${prompts[i].substring(0, 200)}`);
      }
    }
    const chain = resumedThread.resume_chain || [];
    const related = resumedThread.related_session_ids || [];
    if (chain.length) {
      resumeLines.push(`\n**Resume chain (${chain.length} session(s)):**`);
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        const tool = entry.tool || "unknown";
        const sid = (entry.session_id || "?").substring(0, 8);
        const started = entry.started_at || "?";
        const ended = entry.ended_at || "in-progress";
        const fromSid = entry.resumed_from || "";
        const fromLabel = fromSid
          ? ` <- ${fromSid.substring(0, 8)}`
          : " (original)";
        resumeLines.push(
          `  ${i + 1}. [${tool}] session ${sid}..  ${started}${fromLabel}`
        );
      }
    } else if (related.length > 1) {
      resumeLines.push(
        `**Sessions:** this is session #${related.length} on this thread`
      );
    }
    resumeLines.push("");
    resumeLines.push(
      "**-> Start by giving the user a brief recap of what happened in " +
        "the previous session(s) on this thread -- what was worked on, " +
        "what was accomplished, what problems were hit, and what's left to do. " +
        "Then ask how they'd like to proceed.**"
    );
    parts.push(resumeLines.join("\n"));
  }

  // Overlap warning comes first — most urgent signal
  if (overlapContext) parts.push(overlapContext);

  if (threadContext) parts.push(threadContext);
  if (configContext) parts.push(configContext);
  if (presenceContext) parts.push(presenceContext);

  const output = parts.join("\n").trim();
  _emit(output);
}

// ── Entry point ───────────────────────────────────────────

try {
  main();
} catch (_) {
  _safeExit();
}
