#!/usr/bin/env node
"use strict";
/**
 * session-end.js — Session Thread Capture (V2)
 *
 * Fires on SessionEnd (Claude Code) / sessionEnd (Copilot CLI).
 * Parses session transcript, classifies work type, updates/creates
 * thread records, runs tombstone sweep, and cleans up.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

function _safeExit() {
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
  _safeExit();
}

const {
  getMemoryPath,
  getConfigPath,
  getUserPresencePath,
  getAllAuditPaths,
  loadJson,
  saveJson,
  saveMemoryMerged,
  appendAuditLine,
  getUser,
  getBranch,
  detectTool,
  getSessionId,
  getResumeThreadId,
  findThreadById,
  clearResumeSignal,
  parseJsonlFile,
  extractNarrativeFromEntries,
  extractFailedFromEntries,
  ERROR_PATTERNS,
  RETRY_PATTERNS,
  extractSessionFromAudit,
  clearSessionFile,
  readHeadSha,
  clearHeadFile,
  getActiveResumeThreadId,
  clearActiveResumeThreadId,
  clearInjectedSet,
  normalizeSep,
} = utils;

// ── Constants ─────────────────────────────────────────────

const WRITE_TOOLS = new Set([
  "Write", "Edit", "MultiEdit",
  "write", "edit", "multi_edit",
]);

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

// ── Transcript helpers ────────────────────────────────────

function _getContentBlocks(entry) {
  const message = entry.message;
  if (message && typeof message === "object" && !Array.isArray(message) && "content" in message) {
    return message.content || [];
  }
  return entry.content || [];
}

function _normalizePath(filePath, cwd) {
  if (cwd && path.isAbsolute(filePath)) {
    try {
      return path.relative(cwd, filePath);
    } catch (_) {
      // ignore
    }
  }
  return filePath;
}

function _extractFilesFromEntry(entry, files, cwd) {
  if (!entry || typeof entry !== "object") return;

  const contentBlocks = _getContentBlocks(entry);
  for (const content of contentBlocks) {
    if (!content || typeof content !== "object") continue;
    if (content.type === "tool_use") {
      const toolName = content.name || "";
      if (!WRITE_TOOLS.has(toolName)) continue;
      const toolInput = content.input;
      if (toolInput && typeof toolInput === "object") {
        for (const key of ["file_path", "filePath", "path", "file"]) {
          if (key in toolInput) {
            files.add(_normalizePath(toolInput[key], cwd));
            break;
          }
        }
        const edits = toolInput.edits;
        if (Array.isArray(edits)) {
          for (const edit of edits) {
            if (edit && typeof edit === "object") {
              for (const key of ["file_path", "path"]) {
                if (key in edit) {
                  files.add(_normalizePath(edit[key], cwd));
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  // Hook-style tool entries (Copilot CLI format)
  const hookTool = entry.tool_name || "";
  if (WRITE_TOOLS.has(hookTool)) {
    const toolInput = entry.tool_input;
    if (toolInput && typeof toolInput === "object") {
      for (const key of ["file_path", "filePath", "path", "file"]) {
        if (key in toolInput) {
          files.add(_normalizePath(toolInput[key], cwd));
          break;
        }
      }
    }
  }
}

function extractFilesTouched(hookInput) {
  const files = new Set();
  const cwd = hookInput.cwd || "";

  if (Array.isArray(hookInput.files_touched)) {
    for (const f of hookInput.files_touched) files.add(f);
  }

  // Parse transcript for tool_use writes
  const transcriptPath = hookInput.transcript_path || "";
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const raw = fs.readFileSync(transcriptPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch (_) { continue; }
        _extractFilesFromEntry(entry, files, cwd);
      }
    } catch (_) {
      // ignore
    }
  }

  // Check audit trail for this session (search all per-user audit files)
  const sessionId = hookInput.session_id;
  if (sessionId) {
    for (const auditPath of getAllAuditPaths()) {
      try {
        const raw = fs.readFileSync(auditPath, "utf-8");
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let entry;
          try { entry = JSON.parse(trimmed); } catch (_) { continue; }
          if (
            entry.session_id === sessionId &&
            entry.type === "tool_use" &&
            entry.file
          ) {
            files.add(entry.file);
          }
        }
      } catch (_) {
        // ignore
      }
    }
  }

  return Array.from(files);
}

// ── Git diff helpers ──────────────────────────────────────

/**
 * V2.5: Collect commit SHAs created between session start HEAD and current HEAD.
 * These are the commits made during this session — the join key for attribution engine.
 */
function getSessionCommitShas() {
  const savedSha = readHeadSha();
  if (!savedSha || !/^[0-9a-f]+$/i.test(savedSha)) return [];

  try {
    const result = execFileSync("git", ["log", "--format=%H", savedSha + "..HEAD"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.trim().split(/\r?\n/).filter((s) => s.trim()).map((s) => s.trim());
  } catch (_) {
    // Fallback: just return current HEAD
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return head !== savedSha ? [head] : [];
    } catch (_) {
      return [];
    }
  }
}

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
    // ignore
  }

  return Array.from(files).filter((f) => {
    const normalized = normalizeSep(f);
    return !STICKY_FILES_PREFIX.some((p) => normalized === p || normalized.startsWith(p));
  });
}

// ── User prompt extraction ────────────────────────────────

function _extractUserPrompt(hookInput) {
  const transcriptPath = hookInput.transcript_path || "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch (_) { continue; }

      const message = entry.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      const role = message.role || entry.role || "";
      if (role !== "user") continue;

      const contentBlocks = _getContentBlocks(entry);
      if (!contentBlocks || !contentBlocks.length) continue;

      // If all blocks are short strings, join them
      if (contentBlocks.every((c) => typeof c === "string" && c.length <= 1)) {
        const text = contentBlocks.join("").trim();
        if (text) return text.substring(0, 200);
        continue;
      }

      for (const content of contentBlocks) {
        if (content && typeof content === "object" && content.type === "text") {
          const text = (content.text || "").trim();
          if (text) return text.substring(0, 200);
        } else if (typeof content === "string" && content.length > 1) {
          return content.trim().substring(0, 200);
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return null;
}

// ── Narrative / failed approaches ─────────────────────────

function extractNarrative(hookInput) {
  const transcriptPath = hookInput.transcript_path || "";
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    const entries = parseJsonlFile(transcriptPath);
    const narrative = extractNarrativeFromEntries(entries);
    if (narrative) return narrative;
  }

  const sessionId = getSessionId(hookInput);
  const auditData = extractSessionFromAudit(sessionId);
  const prompts = auditData.prompts || [];
  if (prompts.length) {
    if (prompts.length === 1) return prompts[0].substring(0, 300).trim();
    let summary = prompts[0].substring(0, 150).trim();
    if (prompts.length > 2) {
      summary += ` ... (${prompts.length} prompts total) ... ${prompts[prompts.length - 1].substring(0, 100).trim()}`;
    } else {
      summary += ` -> ${prompts[prompts.length - 1].substring(0, 100).trim()}`;
    }
    return summary.substring(0, 300);
  }

  return "";
}

function extractFailedApproaches(hookInput) {
  const transcriptPath = hookInput.transcript_path || "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const entries = parseJsonlFile(transcriptPath);
  return extractFailedFromEntries(entries);
}

// ── Last note extraction ──────────────────────────────────

function extractLastNote(hookInput, narrative, sessionAnalysis, auditData) {
  for (const key of ["summary", "last_message", "description"]) {
    const note = hookInput[key];
    if (note && typeof note === "string") return note.substring(0, 200);
  }

  let workType = "";
  let activities = [];
  if (sessionAnalysis) {
    workType = sessionAnalysis.work_type || "";
    activities = sessionAnalysis.activities || [];
  }

  if (narrative && narrative !== "Session completed" && narrative !== "") {
    const prefix = workType && workType !== "general" ? `[${workType}] ` : "";
    return (prefix + narrative).substring(0, 200);
  }

  if (workType && workType !== "general" && activities.length) {
    return `[${workType}] ${activities.slice(0, 4).join(", ")}`.substring(0, 200);
  }

  if (activities.length) {
    return activities.slice(0, 4).join(", ").substring(0, 200);
  }

  const reason = hookInput.reason || "";
  const reasonLabels = {
    prompt_input_exit: "User exited session",
    stop: "Session stopped",
    error: "Session ended with error",
  };
  if (reason in reasonLabels) {
    const label = reasonLabels[reason];
    if (workType && workType !== "general") {
      return `[${workType}] ${label}`.substring(0, 200);
    }
    return label;
  }

  const files = extractFilesTouched(hookInput);
  if (files.length) {
    const prefix = workType && workType !== "general" ? `[${workType}] ` : "";
    const suffix = files.length > 3 ? "..." : "";
    return (prefix + "Worked on " + files.slice(0, 3).join(", ") + suffix).substring(0, 200);
  }

  let resolvedAudit = auditData;
  if (resolvedAudit == null) {
    const sessionId = getSessionId(hookInput);
    resolvedAudit = extractSessionFromAudit(sessionId);
  }
  const firstPrompt = resolvedAudit.first_prompt || "";
  if (firstPrompt) return firstPrompt.substring(0, 200);

  return "Session completed";
}

// ── Activity analysis ─────────────────────────────────────

function _looksLikeError(text) {
  if (!text || text.length < 10) return false;
  return ERROR_PATTERNS.test(text);
}

function _summarizeError(text) {
  if (!text) return "";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && ERROR_PATTERNS.test(trimmed)) {
      return trimmed.substring(0, 100);
    }
  }
  return text.trim().split(/\r?\n/)[0].substring(0, 100);
}

function _isTestCommand(cmd) {
  const patterns = [
    "test", "jest", "pytest", "mocha", "vitest", "rspec",
    "cargo test", "go test", "npm test", "yarn test", "pnpm test",
  ];
  const lower = cmd.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function _isDebugCommand(cmd) {
  const patterns = [
    "log", "cat ", "tail ", "head ", "grep ", "less ",
    "journalctl", "docker logs", "kubectl logs",
    "console", "debug", "strace", "ltrace", "dmesg",
  ];
  const lower = cmd.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function _isInstallCommand(cmd) {
  const patterns = [
    "npm install", "npm i ", "yarn add", "pip install",
    "cargo add", "go get", "brew install", "apt install", "pnpm add",
  ];
  const lower = cmd.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function _analyzeEntry(entry, toolCounts, errorsSeen, commandsRun) {
  if (!entry || typeof entry !== "object") return;

  for (const content of _getContentBlocks(entry)) {
    if (!content || typeof content !== "object") continue;

    if (content.type === "tool_use") {
      const name = content.name || "";
      toolCounts[name] = (toolCounts[name] || 0) + 1;
      const toolInput = content.input;
      if (toolInput && typeof toolInput === "object" && toolInput.command) {
        commandsRun.push(toolInput.command);
      }
    }

    if (content.type === "tool_result" && content.is_error) {
      let text = "";
      const resultContent = content.content || "";
      if (typeof resultContent === "string") {
        text = resultContent;
      } else if (Array.isArray(resultContent)) {
        text = resultContent
          .filter((c) => c && typeof c === "object")
          .map((c) => c.text || "")
          .join(" ");
      }
      const summary = _summarizeError(text);
      if (summary) errorsSeen.push(summary);
    }
  }

  // Hook-style entries (Copilot CLI format)
  if (entry.tool_name) {
    const name = entry.tool_name;
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    const toolInput = entry.tool_input;
    if (toolInput && typeof toolInput === "object" && toolInput.command) {
      commandsRun.push(toolInput.command);
    }
    const resp = entry.tool_response;
    if (resp && typeof resp === "object") {
      const stderr = resp.stderr || "";
      if (stderr && _looksLikeError(stderr)) {
        errorsSeen.push(_summarizeError(stderr));
      }
    }
  }
}

function _collectEditedFiles(hookInput) {
  const files = new Set();
  const transcriptPath = hookInput.transcript_path || "";
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return files;

  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch (_) { continue; }

      for (const content of _getContentBlocks(entry)) {
        if (!content || typeof content !== "object") continue;
        if (content.type === "tool_use" && WRITE_TOOLS.has(content.name)) {
          const inp = content.input;
          if (inp && typeof inp === "object") {
            for (const key of ["file_path", "path", "file"]) {
              if (key in inp) {
                files.add(path.basename(inp[key]));
                break;
              }
            }
          }
        }
      }
    }
  } catch (_) {
    // ignore
  }

  return files;
}

function analyzeSessionActivities(hookInput, auditData) {
  let activities = [];
  let workType = "general";
  const toolCounts = {};
  const errorsSeen = [];
  const commandsRun = [];

  const transcriptPath = hookInput.transcript_path || "";
  let hasTranscript = !!(transcriptPath && fs.existsSync(transcriptPath));

  if (hasTranscript) {
    try {
      const raw = fs.readFileSync(transcriptPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch (_) { continue; }
        _analyzeEntry(entry, toolCounts, errorsSeen, commandsRun);
      }
    } catch (_) {
      hasTranscript = false;
    }
  }

  // Fallback to audit data when transcript is unavailable
  if (!hasTranscript) {
    let resolvedAudit = auditData;
    if (resolvedAudit == null) {
      const sessionId = getSessionId(hookInput);
      resolvedAudit = extractSessionFromAudit(sessionId);
    }
    const auditTools = resolvedAudit.tools || {};
    const auditFiles = resolvedAudit.files || [];

    if (Object.keys(auditTools).length || auditFiles.length) {
      Object.assign(toolCounts, auditTools);

      if (auditFiles.length) {
        const editLike = new Set([
          "edit", "create", "write", "Edit", "Write", "MultiEdit",
          "multi_edit", "editedExistingFile", "createdNewFile",
        ]);
        let auditEditCount = 0;
        for (const [t, c] of Object.entries(auditTools)) {
          if (editLike.has(t)) auditEditCount += c;
        }
        if (auditEditCount > 0) activities.push(`edited ${auditEditCount} file(s)`);
        activities.push(`touched ${auditFiles.length} file(s)`);
      }

      const numPrompts = (resolvedAudit.prompts || []).length;
      if (numPrompts > 0) activities.push(`${numPrompts} prompt(s)`);

      if (!activities.length && Object.keys(auditTools).length) {
        const totalCalls = Object.values(auditTools).reduce((a, b) => a + b, 0);
        activities.push(`used ${totalCalls} tool(s)`);
      }

      return { work_type: workType, activities: activities.slice(0, 8), tool_calls: toolCounts };
    }
  }

  if (!Object.keys(toolCounts).length && !hasTranscript) {
    return { work_type: workType, activities, tool_calls: {} };
  }

  const hasEdits = ["Write", "Edit", "MultiEdit"].some((t) => t in toolCounts);
  const hasErrors = errorsSeen.length > 0;
  const hasTestRuns = commandsRun.some(_isTestCommand);
  const hasLogInspection = commandsRun.some(_isDebugCommand);
  const hasGit = commandsRun.some((cmd) => cmd.toLowerCase().includes("git"));
  const hasInstall = commandsRun.some(_isInstallCommand);

  const readCount = toolCounts["Read"] || 0;
  let editCount = 0;
  for (const t of ["Write", "Edit", "MultiEdit"]) {
    editCount += toolCounts[t] || 0;
  }

  const filesTouched = _collectEditedFiles(hookInput);
  const isDocs =
    filesTouched.size > 0 &&
    Array.from(filesTouched).every((f) => /\.(md|txt|rst|adoc)$/.test(f));

  // Work type classification (priority order)
  if (hasErrors && (hasLogInspection || hasTestRuns)) workType = "debugging";
  else if (hasErrors && hasEdits) workType = "bug-fix";
  else if (hasTestRuns && !hasEdits) workType = "testing";
  else if (hasTestRuns && hasEdits) workType = "test-writing";
  else if (isDocs && hasEdits) workType = "documentation";
  else if (hasEdits && !hasErrors) workType = "feature-development";
  else if (hasInstall) workType = "setup";
  else if (readCount > 0 && !hasEdits) workType = "code-review";
  else if (hasGit && !hasEdits) workType = "investigation";
  else if (!hasEdits && (hasLogInspection || hasTestRuns)) workType = "investigation";

  // Build activities list
  if (hasErrors) {
    const unique = [...new Set(errorsSeen)].slice(0, 3);
    for (const err of unique) activities.push(`error: ${err}`);
  }
  if (hasTestRuns) activities.push("ran tests");
  if (hasLogInspection) activities.push("inspected logs/output");
  if (hasGit) {
    const gitCmds = commandsRun.filter((cmd) => cmd.toLowerCase().includes("git"));
    if (gitCmds.some((c) => c.includes("log"))) activities.push("reviewed git history");
    if (gitCmds.some((c) => c.includes("diff"))) activities.push("reviewed diffs");
    if (gitCmds.some((c) => c.includes("checkout") || c.includes("branch"))) {
      activities.push("switched branches");
    }
  }
  if (hasInstall) activities.push("installed dependencies");
  if (editCount > 0) activities.push(`edited ${editCount} file(s)`);

  return { work_type: workType, activities: activities.slice(0, 8), tool_calls: toolCounts };
}

// ── Tombstone sweep ───────────────────────────────────────

function tombstoneSweep(threads, staleDays) {
  const now = Date.now();
  let count = 0;

  for (const thread of threads) {
    if (thread.status !== "closed") continue;
    const tsField =
      thread.last_activity_at || thread.closed_at || thread.updated_at || "";
    if (!tsField) continue;

    try {
      const ts = new Date(tsField).getTime();
      if (isNaN(ts)) continue;
      const daysDiff = (now - ts) / (1000 * 60 * 60 * 24);
      if (daysDiff >= staleDays) {
        const closedAt = thread.closed_at || tsField;
        const user = thread.user || thread.author || "unknown";
        const threadId = thread.id || "";

        // Replace thread data with minimal tombstone
        const tombstone = {
          id: threadId,
          status: "expired",
          user,
          closed_at: closedAt,
        };
        for (const key of Object.keys(thread)) delete thread[key];
        Object.assign(thread, tombstone);
        count++;
      }
    } catch (_) {
      continue;
    }
  }

  return count;
}

// ── Presence cleanup ──────────────────────────────────────

function clearPresence(user) {
  const presencePath = getUserPresencePath(user);
  try {
    if (fs.existsSync(presencePath)) {
      fs.unlinkSync(presencePath);
    }
  } catch (_) {
    // ignore
  }
}

// ── Main ──────────────────────────────────────────────────

function main() {
  let hookInput = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    hookInput = JSON.parse(raw);
  } catch (_) {
    hookInput = {};
  }

  const sessionId = getSessionId(hookInput);
  const aiTool = detectTool(hookInput);
  const isCopilotCli = aiTool === "copilot-cli" || process.argv.includes("--copilot-cli") || !!process.env.COPILOT_CLI;
  const user = getUser();
  const now = new Date().toISOString();
  const branch = getBranch();

  const memoryPath = getMemoryPath();
  const memory = loadJson(memoryPath, { version: "2", project: "", threads: [] });
  const config = loadJson(getConfigPath(), { stale_days: 14 });
  const staleDays = config.stale_days || 14;

  let filesTouched = extractFilesTouched(hookInput);
  const auditData = extractSessionFromAudit(sessionId);
  const sessionAnalysis = analyzeSessionActivities(hookInput, auditData);
  const narrative = extractNarrative(hookInput);
  const failed = extractFailedApproaches(hookInput);
  const lastNote = extractLastNote(hookInput, narrative, sessionAnalysis, auditData);

  // Merge audit-discovered files
  const auditFiles = auditData.files || [];
  if (auditFiles.length) {
    filesTouched = [...new Set([...filesTouched, ...auditFiles])];
  }

  // Merge git-discovered files
  const gitFiles = getGitFilesTouched();
  if (gitFiles.length) {
    filesTouched = [...new Set([...filesTouched, ...gitFiles])];
  }

  const threads = memory.threads || [];
  memory.threads = threads;
  let existing = null;

  // V2.5: Check for active resumed thread (set by resume-thread command)
  const activeResumeId = getActiveResumeThreadId();

  // Check for resumed thread (V2 resume signal or V2.5 active resume)
  const resumeThreadId = getResumeThreadId() || activeResumeId;
  if (resumeThreadId) {
    existing = findThreadById(threads, resumeThreadId);
    if (existing) {
      const related = existing.related_session_ids || [];
      existing.related_session_ids = related;
      if (!related.includes(sessionId)) related.push(sessionId);

      const chain = existing.resume_chain || [];
      existing.resume_chain = chain;
      const prevSession = chain.length
        ? chain[chain.length - 1].session_id
        : existing.session_id || "";

      const currentEntry = chain.find((e) => e.session_id === sessionId);
      if (currentEntry) {
        currentEntry.ended_at = now;
        currentEntry.tool = aiTool;
      } else {
        chain.push({
          session_id: sessionId,
          tool: aiTool,
          started_at: now,
          ended_at: now,
          resumed_from: prevSession,
        });
      }

      // V2.5: Update contributors and resume metadata
      const contributors = existing.contributors || [];
      if (!contributors.includes(user)) {
        contributors.push(user);
      }
      existing.contributors = contributors;
      existing.resumed_by = user;
      existing.resumed_at = now;

      const resumeHistory = existing.resume_history || [];
      resumeHistory.push({ user, at: now, session_id: sessionId });
      existing.resume_history = resumeHistory;
    }
    clearResumeSignal();
    clearActiveResumeThreadId();
  }

  // Fallback: find by session_id
  if (!existing) {
    for (const thread of threads) {
      if (thread.session_id === sessionId) {
        existing = thread;
        break;
      }
    }
  }

  // Prompts from audit
  const prompts = auditData.prompts || [];
  const storedPrompts = prompts.length
    ? prompts.slice(0, 20).map((p) => p.substring(0, 300))
    : [];

  if (existing) {
    // Update existing thread
    existing.files_touched = [
      ...new Set([...(existing.files_touched || []), ...filesTouched]),
    ];
    existing.last_note = lastNote;
    existing.tool = aiTool;
    existing.work_type = sessionAnalysis.work_type;
    existing.activities = sessionAnalysis.activities;
    existing.last_activity_at = now;
    // Copilot CLI fires SessionEnd per-turn, not per-session.
    // Keep thread open so it isn't prematurely closed between turns.
    if (!isCopilotCli) {
      existing.status = "closed";
      existing.closed_at = now;
    }
    existing.branch = branch || existing.branch || "";

    // Merge tool call counts
    const prevCalls = existing.tool_calls || {};
    for (const [tn, cnt] of Object.entries(sessionAnalysis.tool_calls || {})) {
      prevCalls[tn] = (prevCalls[tn] || 0) + cnt;
    }
    existing.tool_calls = prevCalls;

    if (narrative) existing.narrative = narrative;
    if (failed.length) existing.failed_approaches = failed;
    if (storedPrompts.length) {
      const prev = existing.prompts || [];
      existing.prompts = [...prev, ...storedPrompts].slice(-20);
    }
  } else {
    // Create new thread
    threads.push({
      id: crypto.randomUUID(),
      user,
      project: memory.project || "",
      status: isCopilotCli ? "open" : "closed",
      branch,
      created_at: now,
      closed_at: isCopilotCli ? null : now,
      last_activity_at: now,
      files_touched: filesTouched,
      last_note: lastNote,
      narrative,
      failed_approaches: failed,
      handoff_summary: "",
      related_session_ids: [],
      resume_chain: [],
      tool: aiTool,
      session_id: sessionId,
      work_type: sessionAnalysis.work_type,
      activities: sessionAnalysis.activities,
      tool_calls: sessionAnalysis.tool_calls || {},
      prompts: storedPrompts,
      // V2.5 fields
      contributors: [user],
      resume_history: [],
    });
  }

  // V2.5: Capture commit SHAs for attribution engine
  const commitShas = getSessionCommitShas();

  // Housekeeping
  const threadStatus = isCopilotCli ? "open" : "closed";
  tombstoneSweep(threads, staleDays);
  const auditEntry = {
    type: "session_end",
    user,
    ts: now,
    session_id: sessionId,
    status: threadStatus,
    files_touched: filesTouched,
    work_type: sessionAnalysis.work_type,
  };
  if (commitShas.length > 0) {
    auditEntry.commit_shas = commitShas;
  }
  appendAuditLine(auditEntry);

  // V2.5: Also write individual commit_sha audit entries for bridge lookup
  for (const sha of commitShas) {
    appendAuditLine({
      type: "commit",
      user,
      ts: now,
      session_id: sessionId,
      commit_sha: sha,
    });
  }
  // Only clear transient files for true session end (Claude Code).
  // Copilot CLI fires per-turn; clearing would break state across turns.
  if (!isCopilotCli) {
    clearPresence(user);
    clearSessionFile();
    clearHeadFile();
    clearInjectedSet();
  }
  saveMemoryMerged(memoryPath, memory);

  const fileCount = filesTouched.length;
  const commitCount = commitShas.length;
  const statusLabel = isCopilotCli ? "updated" : "closed";
  const statusMsg = `[STICKY-NOTE] Session ${statusLabel} - thread ${isCopilotCli ? "updated" : "created"} (${fileCount} file${fileCount !== 1 ? "s" : ""}${commitCount > 0 ? ", " + commitCount + " commit" + (commitCount !== 1 ? "s" : "") : ""})`;
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
