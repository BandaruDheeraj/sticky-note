#!/usr/bin/env node
"use strict";
/**
 * sticky-attribution.js — Sticky Note Attribution Engine
 *
 * Copyright 2026 Dheeraj Bandaru
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * ---
 * Built-in attribution engine using standard git blame + Git Notes +
 * audit JSONL. No external dependencies — works out of the box for
 * any git-native team.
 *
 * Three-tier SHA → thread resolution:
 *   1. Git Notes (refs/notes/sticky-note) — survives rebase/amend
 *   2. Audit JSONL — commit_sha / commit_shas fields
 *   3. File + date heuristic — fallback for squash merges
 *
 * Call sites:
 *   A. PreToolUse hook → lazy injection (file → threads with line ranges)
 *   B. resume_thread() → thread discovery + ranking
 *   C. get_line_attribution() → enriched audit with line-level detail
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let utils;
try {
  utils = require("./sticky-utils.js");
} catch (_) {
  utils = null;
}

let gitNotes;
try {
  gitNotes = require("./sticky-git-notes.js");
} catch (_) {
  gitNotes = null;
}

const ATTRIBUTION_TIMEOUT_MS = 500;

// ── Three-tier SHA → session resolution ───────────────────

/**
 * Tier 1: Check Git Notes on a commit for session attribution.
 * Returns array of { session_id, user, type, ts } objects.
 */
function resolveViaNotes(sha) {
  if (!gitNotes) return [];
  const note = gitNotes.readNote(sha);
  if (!note) return [];

  const entries = Array.isArray(note) ? note : [note];
  return entries
    .filter((e) => e && e.session_id)
    .map((e) => ({
      session_id: e.session_id,
      user: e.user || "",
      type: e.type || "note",
      ts: e.ts || "",
      tier: "git-notes",
    }));
}

/**
 * Tier 2: Search audit JSONL files for entries matching a commit SHA.
 */
function resolveViaAudit(sha) {
  if (!utils) return [];
  const auditPaths = utils.getAllAuditPaths();
  const results = [];

  for (const auditPath of auditPaths) {
    try {
      const raw = fs.readFileSync(auditPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (!trimmed.includes(sha)) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (
            entry.commit_sha === sha ||
            entry.sha === sha ||
            (Array.isArray(entry.commit_shas) && entry.commit_shas.includes(sha))
          ) {
            results.push({
              session_id: entry.session_id || "",
              user: entry.user || "",
              type: entry.type || "",
              ts: entry.ts || "",
              tier: "audit-jsonl",
            });
          }
        } catch (_) {
          continue;
        }
      }
    } catch (_) {
      continue;
    }
  }

  return results;
}

/**
 * Tier 3: File + date heuristic fallback.
 * When a SHA has no notes and no audit match (e.g. squash merge),
 * check if the file is in any thread's files_touched[] and the
 * commit date falls within a reasonable session window.
 */
function resolveViaHeuristic(sha, file) {
  if (!utils) return [];

  // Get commit date for the SHA
  let commitDate;
  try {
    const dateStr = execFileSync("git", ["log", "-1", "--format=%aI", sha], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    commitDate = new Date(dateStr);
    if (isNaN(commitDate.getTime())) return [];
  } catch (_) {
    return [];
  }

  // Also check if the squash commit message references original SHAs
  let commitMsg = "";
  try {
    commitMsg = execFileSync("git", ["log", "-1", "--format=%B", sha], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (_) { /* ignore */ }

  // Check referenced SHAs in commit message (squash merges often include them)
  const referencedShas = commitMsg.match(/\b[0-9a-f]{7,40}\b/g) || [];
  for (const refSha of referencedShas) {
    const noteResults = resolveViaNotes(refSha);
    if (noteResults.length > 0) return noteResults;
    const auditResults = resolveViaAudit(refSha);
    if (auditResults.length > 0) return auditResults;
  }

  // Last resort: match by file + date window
  const memory = utils.loadJson(utils.getMemoryPath(), { version: "2", threads: [] });
  const results = [];
  const normalizedFile = file ? file.replace(/\\/g, "/") : null;

  for (const thread of memory.threads || []) {
    if (thread.status === "expired") continue;
    if (!normalizedFile) continue;

    const touchedFiles = (thread.files_touched || []).map((f) => f.replace(/\\/g, "/"));
    const fileMatch = touchedFiles.some(
      (f) => f === normalizedFile || normalizedFile.endsWith(f) || f.endsWith(normalizedFile)
    );
    if (!fileMatch) continue;

    // Check if commit date is near thread activity
    const threadStart = thread.created_at ? new Date(thread.created_at) : null;
    const threadEnd = thread.last_activity_at ? new Date(thread.last_activity_at) : threadStart;
    if (!threadStart) continue;

    // Allow 24h window beyond thread activity
    const windowStart = new Date(threadStart.getTime() - 3600000);
    const windowEnd = new Date((threadEnd || threadStart).getTime() + 86400000);

    if (commitDate >= windowStart && commitDate <= windowEnd) {
      results.push({
        session_id: thread.session_id || thread.id,
        user: thread.user || "",
        type: "heuristic",
        ts: commitDate.toISOString(),
        tier: "heuristic",
      });
    }
  }

  return results;
}

/**
 * Resolve a commit SHA to session attribution using all three tiers.
 * Returns first non-empty result.
 */
function resolveSessionForSha(sha, file) {
  // Tier 1: Git Notes
  const noteResults = resolveViaNotes(sha);
  if (noteResults.length > 0) return noteResults;

  // Tier 2: Audit JSONL
  const auditResults = resolveViaAudit(sha);
  if (auditResults.length > 0) return auditResults;

  // Tier 3: Heuristic
  return resolveViaHeuristic(sha, file);
}

// ── SHA → Thread resolution ───────────────────────────────

/**
 * Given session attribution entries, load corresponding threads.
 */
function resolveThreads(attributionEntries) {
  if (!utils) return [];
  const sessionIds = new Set(
    attributionEntries.map((e) => e.session_id).filter(Boolean)
  );
  if (sessionIds.size === 0) return [];

  const memory = utils.loadJson(utils.getMemoryPath(), { version: "2", threads: [] });
  const threads = [];

  for (const thread of memory.threads || []) {
    if (thread.status === "expired") continue;
    if (sessionIds.has(thread.session_id) || sessionIds.has(thread.id)) {
      threads.push(thread);
      continue;
    }
    for (const sid of thread.related_session_ids || []) {
      if (sessionIds.has(sid)) {
        threads.push(thread);
        break;
      }
    }
  }

  return threads;
}

/**
 * Given a commit SHA, resolve to threads via three-tier lookup.
 */
function resolveThreadsBySha(sha, file) {
  const entries = resolveSessionForSha(sha, file);
  return resolveThreads(entries);
}

// ── Core: file → attributed threads ───────────────────────

/**
 * Get threads that have authored lines in a file, with line-range detail.
 *
 * Returns {
 *   threads: [{ thread, lines: [lineNums], tier: "git-notes"|"audit-jsonl"|"heuristic" }],
 *   blame_data: { lines: {lineNum: sha}, shas: string[] },
 *   line_map: { lineNum: { sha, session_id, thread_id } }
 * }
 */
function getFileAttribution(file, options) {
  options = options || {};
  const result = {
    threads: [],
    blame_data: null,
    line_map: {},
  };

  if (!gitNotes) return result;

  const blameData = gitNotes.gitBlame(file);
  if (!blameData) return result;
  result.blame_data = blameData;

  // Filter SHAs by line range if specified
  let shasToCheck;
  if (options.lineRange && options.lineRange.length === 2) {
    shasToCheck = gitNotes.getShasForLineRange(blameData, options.lineRange[0], options.lineRange[1]);
  } else {
    shasToCheck = blameData.shas;
  }

  if (!shasToCheck || shasToCheck.length === 0) return result;

  // Resolve each SHA → sessions → threads
  const threadMap = new Map(); // thread.id → { thread, lines: Set, tier }

  for (const sha of shasToCheck) {
    const entries = resolveSessionForSha(sha, file);
    if (entries.length === 0) continue;

    const tier = entries[0].tier;
    const threads = resolveThreads(entries);

    // Find which lines this SHA covers
    const linesForSha = [];
    for (const [lineStr, lineSha] of Object.entries(blameData.lines)) {
      if (lineSha === sha) {
        const lineNum = parseInt(lineStr, 10);
        if (!isNaN(lineNum)) {
          // Apply line range filter
          if (options.lineRange && options.lineRange.length === 2) {
            if (lineNum < options.lineRange[0] || lineNum > options.lineRange[1]) continue;
          }
          linesForSha.push(lineNum);
        }
      }
    }

    for (const thread of threads) {
      if (!threadMap.has(thread.id)) {
        threadMap.set(thread.id, { thread, lines: new Set(), tier });
      }
      const entry = threadMap.get(thread.id);
      for (const line of linesForSha) {
        entry.lines.add(line);
        result.line_map[line] = {
          sha,
          session_id: entries[0].session_id,
          thread_id: thread.id,
        };
      }
    }
  }

  // Apply since filter and build result
  for (const [, value] of threadMap) {
    if (options.since) {
      const threadDate = value.thread.last_activity_at || value.thread.created_at || "";
      if (threadDate && threadDate < options.since) continue;
    }

    const sortedLines = Array.from(value.lines).sort((a, b) => a - b);
    result.threads.push({
      thread: value.thread,
      lines: sortedLines,
      line_ranges: compactLineRanges(sortedLines),
      tier: value.tier,
    });
  }

  return result;
}

/**
 * Lightweight: get threads for a file (no line-level detail).
 */
function getThreadsForFile(file) {
  const attr = getFileAttribution(file);
  return attr.threads.map((t) => ({
    ...t.thread,
    _attributed_lines: t.lines,
    _line_ranges: t.line_ranges,
    _tier: t.tier,
  }));
}

// ── Line range compaction ─────────────────────────────────

/**
 * Compact sorted line numbers into ranges.
 * [1,2,3,5,6,10] → ["1-3", "5-6", "10"]
 */
function compactLineRanges(sortedLines) {
  if (sortedLines.length === 0) return [];
  const ranges = [];
  let start = sortedLines[0];
  let end = start;

  for (let i = 1; i < sortedLines.length; i++) {
    if (sortedLines[i] === end + 1) {
      end = sortedLines[i];
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = sortedLines[i];
      end = start;
    }
  }
  ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges;
}

// ── Text similarity for resume_thread ─────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "was", "are", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "can", "shall",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above",
  "below", "between", "and", "but", "or", "not", "no", "so",
  "if", "then", "than", "too", "very", "just", "about", "up",
  "out", "off", "over", "under", "again", "further", "once",
  "it", "its", "this", "that", "these", "those", "i", "me",
  "my", "we", "our", "you", "your", "he", "she", "they", "them",
]);

function tokenize(str) {
  const words = new Set();
  for (const w of str.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (w.length >= 2 && !STOP_WORDS.has(w)) words.add(w);
  }
  return words;
}

function textSimilarity(query, text) {
  if (!query || !text) return 0;
  const queryWords = tokenize(query);
  const textWords = tokenize(text);
  let matches = 0;
  for (const w of queryWords) {
    if (textWords.has(w)) matches++;
  }
  return queryWords.size > 0 ? matches / queryWords.size : 0;
}

/**
 * Search threads by text similarity to a query.
 */
function searchThreadsByText(threads, query) {
  const scored = [];

  for (const thread of threads) {
    if (thread.status === "expired") continue;

    let score = 0;
    score += textSimilarity(query, thread.narrative || "") * 3;
    score += textSimilarity(query, thread.handoff_summary || "") * 2;
    score += textSimilarity(query, thread.last_note || "") * 1.5;

    const failedText = (thread.failed_approaches || [])
      .map((fa) => (fa.description || "") + " " + (fa.error || ""))
      .join(" ");
    score += textSimilarity(query, failedText) * 1;

    const filesText = (thread.files_touched || []).join(" ");
    score += textSimilarity(query, filesText) * 2;

    if (query.toLowerCase().includes(thread.work_type || "___")) {
      score += 1;
    }

    if (score > 0) {
      scored.push({ thread, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Find the best thread to resume, combining text search with
 * file attribution ranking.
 *
 * Options:
 *   query: search text
 *   user: filter by thread author
 *   file: boost threads whose attributed lines overlap with this file
 */
function findThreadToResume(threads, options) {
  options = options || {};
  const { query, user, file } = options;

  let candidates;
  if (query) {
    candidates = searchThreadsByText(threads, query);
  } else {
    candidates = threads
      .filter((t) => t.status !== "expired")
      .map((t) => ({ thread: t, score: 0 }));
  }

  if (user) {
    candidates = candidates.filter(
      (c) => (c.thread.user || "").toLowerCase() === user.toLowerCase()
    );
  }

  // Boost by file attribution (uses git blame — always available)
  if (file) {
    const fileThreads = getThreadsForFile(file);
    const fileThreadIds = new Set(fileThreads.map((t) => t.id));
    for (const c of candidates) {
      if (fileThreadIds.has(c.thread.id)) {
        c.score += 3;
        c.match_reasons = c.match_reasons || [];
        c.match_reasons.push("file-attribution");
      }
    }
  }

  for (const c of candidates) {
    c.match_reasons = c.match_reasons || [];
    if (query && c.score > 0) c.match_reasons.push("text-match");
    if (user) c.match_reasons.push("user-filter");
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  // Three-tier resolution
  resolveViaNotes,
  resolveViaAudit,
  resolveViaHeuristic,
  resolveSessionForSha,
  resolveThreads,
  resolveThreadsBySha,

  // Core attribution
  getFileAttribution,
  getThreadsForFile,
  compactLineRanges,

  // Text search / resume
  textSimilarity,
  searchThreadsByText,
  findThreadToResume,

  // Constants
  ATTRIBUTION_TIMEOUT_MS,
};
