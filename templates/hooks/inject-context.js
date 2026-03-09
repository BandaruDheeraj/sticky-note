#!/usr/bin/env node
"use strict";
/**
 * inject-context.js — Relevance-Scored Thread Injection (V2)
 *
 * Hook: UserPromptSubmit (Claude Code) / userPromptSubmitted (Copilot CLI)
 * Scores threads by file overlap, branch, recency, stuck status, same dev.
 * Injects top 3-5 most relevant threads under a configurable token budget.
 */

const { execSync } = require("child_process");

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

// ── Import sticky-utils ──────────────────────────────────

let utils;
try {
  utils = require("./sticky-utils.js");
} catch (_) {
  _safeExit();
}
const {
  getMemoryPath, loadJson, saveJson, getUser, getBranch,
  getResumeThreadId, findThreadById, getSessionId,
  appendAuditLine, detectTool, getConfigPath,
  isThreadInjected, markThreadInjected, normalizeSep,
} = utils;

// ── Git helpers ───────────────────────────────────────────

function getRecentlyModifiedFiles() {
  const files = new Set();
  // Try HEAD~5 first; fall back to HEAD~1 for shallow repos
  const diffTargets = ["HEAD~5", "HEAD~1"];
  for (const target of diffTargets) {
    try {
      const result = execSync(`git diff --name-only ${target}`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      for (const f of result.trim().split(/\r?\n/)) {
        const trimmed = f.trim();
        if (trimmed) files.add(trimmed);
      }
      break;
    } catch (_) {
      // target doesn't exist, try next
    }
  }
  try {
    const result = execSync("git diff --name-only", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const f of result.trim().split(/\r?\n/)) {
      const trimmed = f.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch (_) {
    // ignore
  }
  return files;
}

// ── Keyword extraction ────────────────────────────────────

function extractKeywords(prompt) {
  const keywords = new Set();
  const words = prompt.toLowerCase().replace(/[/\\.]/g, " ").split(/\s+/);
  for (const word of words) {
    const cleaned = word.replace(/[()[\]{}"'`,;:]/g, "");
    if (cleaned.length >= 2) {
      keywords.add(cleaned);
    }
  }
  for (let token of prompt.split(/\s+/)) {
    token = token.replace(/^[()[\]{}"'`,;:]+/, "").replace(/[()[\]{}"'`,;:]+$/, "");
    if (token.includes("/") || token.includes("\\") || token.includes(".")) {
      keywords.add(token.toLowerCase());
      const parts = normalizeSep(token).split("/");
      for (const part of parts) {
        if (part.length >= 2) {
          keywords.add(part.toLowerCase());
        }
      }
    }
  }
  return keywords;
}

// ── Scoring ───────────────────────────────────────────────

function scoreThread(thread, recentlyModified, currentBranch, currentUser, promptKeywords) {
  if (thread.status === "expired" || thread.status === "stale") {
    return -1;
  }

  let score = 0.0;
  const now = new Date();

  // File overlap (weight 3)
  const threadFiles = new Set(thread.files_touched || []);
  let overlapCount = 0;
  for (const f of threadFiles) {
    if (recentlyModified.has(f)) overlapCount++;
  }
  if (overlapCount > 0) {
    score += 3 * Math.min(overlapCount, 5);
  }

  // Prompt keyword match against thread files
  for (const filePath of threadFiles) {
    const pathLower = filePath.toLowerCase();
    const pathParts = new Set(normalizeSep(pathLower).replace(/\./g, "/").split("/"));
    for (const kw of promptKeywords) {
      if (pathLower.includes(kw) || pathParts.has(kw)) {
        score += 1;
        break;
      }
    }
  }

  // Branch match (weight 2)
  if (currentBranch && thread.branch === currentBranch) {
    score += 2;
  }

  // Recency (weight 2) — decay over days
  const tsField = thread.last_activity_at || thread.updated_at || thread.created_at || "";
  if (tsField) {
    try {
      const ts = new Date(tsField.replace("Z", "+00:00"));
      if (!isNaN(ts.getTime())) {
        const daysAgo = Math.max((now - ts) / 86400000, 0);
        const recency = Math.max(2 - daysAgo * 0.2, 0);
        score += recency;
      }
    } catch (_) {
      // ignore
    }
  }

  // Stuck boost (+2)
  if (thread.status === "stuck") {
    score += 2;
  }

  // Same developer (weight 1)
  const threadUser = thread.user || thread.author || "";
  if (threadUser === currentUser) {
    score += 1;
  }

  return score;
}

// ── Formatting ────────────────────────────────────────────

function _relativeTime(tsStr) {
  try {
    const ts = new Date(tsStr);
    if (isNaN(ts.getTime())) return "";
    const now = new Date();
    const deltaMs = now - ts;
    const hours = deltaMs / 3600000;
    if (hours < 1) {
      return Math.floor(deltaMs / 60000) + "min ago";
    } else if (hours < 24) {
      return Math.floor(hours) + "hrs ago";
    } else {
      return Math.floor(hours / 24) + "d ago";
    }
  } catch (_) {
    return "";
  }
}

function formatThread(thread, detailed) {
  const user = thread.user || thread.author || "unknown";
  const status = thread.status || "open";
  const statusTag = status === "stuck" ? "[STUCK]" : status === "open" ? "[OPEN]" : "[CLOSED]";
  const fileLimit = detailed ? 3 : 2;
  const files = (thread.files_touched || []).slice(0, fileLimit).join(", ");

  let line = statusTag + " " + files + " . " + user;

  if (!detailed) {
    const note = (thread.last_note || "").substring(0, 60);
    if (note) line += " -- " + note;
    return line;
  }

  const branch = thread.branch || "";
  if (branch) line += " . " + branch;
  const tsField = thread.last_activity_at || thread.updated_at || "";
  if (tsField) line += " . " + _relativeTime(tsField);
  line += "\n";

  if (thread.narrative) {
    line += thread.narrative.substring(0, 200) + "\n";
  } else if (thread.last_note) {
    line += thread.last_note.substring(0, 150) + "\n";
  }

  const prompts = thread.prompts || [];
  if (prompts.length > 0) {
    line += "Conversation (" + prompts.length + " prompt(s)):\n";
    for (let i = 0; i < Math.min(prompts.length, 5); i++) {
      line += "  " + (i + 1) + ". " + prompts[i].substring(0, 120) + "\n";
    }
    if (prompts.length > 5) line += "  ... and " + (prompts.length - 5) + " more\n";
  }

  const failed = thread.failed_approaches || [];
  if (failed.length > 0) {
    line += failed.length + " failed approach(es).";
    line += ' Full context: ask get_session_context("' + (thread.id || "") + '")\n';
  }

  return line.trim();
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

  const prompt = hookInput.prompt || hookInput.user_prompt || "";
  if (!prompt) {
    _emit("");
    return;
  }

  const sessionId = getSessionId(hookInput);

  function _auditInject(result, threadsScored, threadsInjected, topScores, error) {
    threadsScored = threadsScored || 0;
    threadsInjected = threadsInjected || 0;
    try {
      const entry = {
        type: "inject_result",
        user: getUser(),
        ts: new Date().toISOString(),
        session_id: sessionId,
        prompt: prompt.substring(0, 120),
        result: result,
        threads_scored: threadsScored,
        threads_injected: threadsInjected,
      };
      if (topScores) entry.top_scores = topScores;
      if (error) entry.error = String(error).substring(0, 200);
      appendAuditLine(entry);
    } catch (_) {
      // ignore
    }
  }

  // Audit the user prompt
  try {
    appendAuditLine({
      type: "user_prompt",
      user: getUser(),
      ts: new Date().toISOString(),
      session_id: sessionId,
      prompt: prompt.substring(0, 500),
    });
  } catch (_) {
    // ignore
  }

  const memory = loadJson(getMemoryPath(), { version: "2", threads: [] });
  const threads = memory.threads || [];

  const live = threads.filter(
    (t) => t.status === "open" || t.status === "stuck" || t.status === "closed"
  );
  if (live.length === 0) {
    _auditInject("no_live_threads");
    _emit("");
    return;
  }

  const keywords = extractKeywords(prompt);
  const currentBranch = getBranch();
  const currentUser = getUser();
  const recentlyModified = getRecentlyModifiedFiles();

  const resumeThreadId = getResumeThreadId();
  let memoryDirty = false;

  if (resumeThreadId) {
    const resumed = findThreadById(threads, resumeThreadId);
    if (resumed && resumed.status !== "open") {
      resumed.status = "open";
      resumed.last_activity_at = new Date().toISOString();
      const related = resumed.related_session_ids || [];
      if (!related.includes(sessionId)) {
        related.push(sessionId);
      }
      resumed.related_session_ids = related;
      const chain = resumed.resume_chain || [];
      const alreadyInChain = chain.some((e) => e.session_id === sessionId);
      if (!alreadyInChain) {
        const aiTool = detectTool(hookInput);
        const prevSession =
          chain.length > 0
            ? chain[chain.length - 1].session_id
            : resumed.session_id || "";
        chain.push({
          session_id: sessionId,
          tool: aiTool,
          started_at: new Date().toISOString(),
          ended_at: null,
          resumed_from: prevSession,
        });
      }
      resumed.resume_chain = chain;
      memoryDirty = true;
    }
  }

  // Score threads
  const scored = [];
  for (const t of live) {
    // V2.5: Skip threads already injected this session by PreToolUse or session-start
    if (isThreadInjected(t.id)) continue;

    let s = scoreThread(t, recentlyModified, currentBranch, currentUser, keywords);
    if (resumeThreadId && t.id === resumeThreadId) {
      s = Math.max(s, 0) + 10;
    }
    if (s > 0) {
      scored.push([s, t]);
    }
  }

  if (memoryDirty) {
    try {
      saveJson(getMemoryPath(), memory);
    } catch (_) {
      // ignore
    }
  }

  scored.sort((a, b) => b[0] - a[0]);

  // Debug / scoring block
  const debugLines = [
    "\n---\n[STICKY-NOTE] [scoring] prompt: " + prompt.substring(0, 80),
  ];
  debugLines.push(
    "  keywords: " +
      Array.from(keywords)
        .sort()
        .slice(0, 15)
        .join(", ")
  );
  debugLines.push("  branch: " + currentBranch + "  user: " + currentUser);
  debugLines.push(
    "  recently_modified: " +
      Array.from(recentlyModified)
        .sort()
        .slice(0, 10)
        .join(", ")
  );
  debugLines.push(
    "  live threads: " + live.length + "  scored>0: " + scored.length
  );
  for (const [s, t] of scored.slice(0, 10)) {
    const tid = (t.id || "").substring(0, 8);
    const st = t.status || "?";
    const files = (t.files_touched || []).slice(0, 3);
    const tool = t.tool || "?";
    debugLines.push(
      "  " +
        s.toFixed(1).padStart(5) +
        "  " +
        tid +
        "  [" +
        st +
        "] " +
        tool +
        "  files=" +
        JSON.stringify(files)
    );
  }
  const scoringBlock = debugLines.join("\n");

  if (scored.length === 0) {
    _auditInject("no_scored_threads", 0);
    _emit("");
    return;
  }

  const config = loadJson(getConfigPath(), {});
  const MAX_TOKENS = config.inject_token_budget || 1000;
  const _estimateTokens = (str) => Math.floor(str.length / 4);

  // Reserve budget for the scoring debug block and header overhead
  const scoringTokens = _estimateTokens(scoringBlock);
  const HEADER_RESERVE = 15; // "[STICKY NOTE -- N relevant thread(s)]"
  let tokenCount = HEADER_RESERVE + scoringTokens;

  const outputLines = [];
  let threadsShown = 0;

  for (let i = 0; i < Math.min(scored.length, 5); i++) {
    const [score, thread] = scored[i];
    const block =
      i === 0 ? formatThread(thread, true) : formatThread(thread, false);
    const blockTokens = _estimateTokens(block);
    if (tokenCount + blockTokens > MAX_TOKENS) {
      const remaining = scored.length - i;
      if (remaining > 0) {
        const overflowMsg = "... and " + remaining + " more relevant threads";
        tokenCount += _estimateTokens(overflowMsg);
        outputLines.push(overflowMsg);
      }
      break;
    }
    tokenCount += blockTokens;
    outputLines.push(block);
    threadsShown++;

    // V2.5: Mark as injected so PreToolUse won't re-inject
    try { markThreadInjected(thread.id, sessionId); } catch (_) {}
  }

  const header =
    "[STICKY-NOTE] " +
    threadsShown +
    " relevant thread" +
    (threadsShown !== 1 ? "s" : "") +
    " injected\n";
  outputLines.unshift(header);

  let output = outputLines.join("\n").trim();
  output += scoringBlock;

  _auditInject(
    "injected",
    scored.length,
    threadsShown,
    scored.slice(0, 5).map(([s, t]) => ({
      id: (t.id || "").substring(0, 8),
      score: Math.round(s * 10) / 10,
    }))
  );
  _emit(output);
}

// ── Entry point ───────────────────────────────────────────

if (require.main === module) {
  try {
    main();
  } catch (exc) {
    try {
      appendAuditLine({
        type: "inject_result",
        ts: new Date().toISOString(),
        result: "error",
        error: String(exc).substring(0, 200),
      });
    } catch (_) {
      // ignore
    }
    _safeExit();
  }
}
