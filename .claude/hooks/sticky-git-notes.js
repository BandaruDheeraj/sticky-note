/**
 * sticky-git-notes.js — Git Notes utilities for Sticky Note attribution
 *
 * Stores session/thread attribution on commits using native Git Notes
 * under refs/notes/sticky-note. Notes survive rebase/amend when
 * notes.rewriteRef is configured (see configureRewriteRef).
 *
 * SPDX-License-Identifier: Apache-2.0
 */

"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const NOTES_REF = "refs/notes/sticky-note";
const NOTE_TIMEOUT_MS = 3000;

// ── Write ────────────────────────────────────────────────

/**
 * Write (or append to) a Git Note on a commit.
 * Data is stored as a JSON array — each call appends an entry.
 */
function writeNote(sha, data) {
  if (!sha || !data) return false;
  try {
    const existing = readNote(sha);
    const entries = Array.isArray(existing) ? existing : existing ? [existing] : [];
    entries.push(data);
    const json = JSON.stringify(entries);
    execFileSync("git", ["notes", "--ref", NOTES_REF, "add", "-f", "-m", json, sha], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Write a single Git Note (overwrite existing).
 */
function writeNoteFull(sha, data) {
  if (!sha || !data) return false;
  try {
    const json = JSON.stringify(data);
    execFileSync("git", ["notes", "--ref", NOTES_REF, "add", "-f", "-m", json, sha], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Read ─────────────────────────────────────────────────

/**
 * Read the Git Note on a commit. Returns parsed JSON or null.
 */
function readNote(sha) {
  if (!sha) return null;
  try {
    const raw = execFileSync("git", ["notes", "--ref", NOTES_REF, "show", sha], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Aggregate notes from multiple SHAs into one array.
 */
function aggregateNotes(shas) {
  const results = [];
  for (const sha of shas) {
    const note = readNote(sha);
    if (!note) continue;
    if (Array.isArray(note)) {
      results.push(...note);
    } else {
      results.push(note);
    }
  }
  return results;
}

// ── Git Blame ────────────────────────────────────────────

/**
 * Run git blame --line-porcelain on a file and parse the output.
 * Returns: { lines: { lineNum: sha }, shas: Set<sha> }
 */
function gitBlame(file) {
  try {
    const raw = execFileSync("git", ["blame", "--line-porcelain", file], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parseBlameOutput(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Parse git blame --line-porcelain output.
 * Each block starts with: <sha> <orig_line> <final_line> [num_lines]
 */
function parseBlameOutput(raw) {
  const lines = {};
  const shas = new Set();
  let currentSha = null;
  let currentLine = null;

  for (const line of raw.split("\n")) {
    // Lines starting with a 40-char hex SHA begin a new block
    const headerMatch = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)/);
    if (headerMatch) {
      currentSha = headerMatch[1];
      currentLine = parseInt(headerMatch[2], 10);
      lines[currentLine] = currentSha;
      shas.add(currentSha);
    }
  }
  return { lines, shas: Array.from(shas) };
}

/**
 * Get SHAs for a specific line range from blame data.
 */
function getShasForLineRange(blameData, startLine, endLine) {
  if (!blameData || !blameData.lines) return [];
  const result = new Set();
  for (let i = startLine; i <= endLine; i++) {
    if (blameData.lines[i]) {
      result.add(blameData.lines[i]);
    }
  }
  return Array.from(result);
}

// ── Configuration ────────────────────────────────────────

/**
 * Configure Git to preserve sticky-note notes on rebase/amend.
 * Returns true if configuration succeeded.
 */
function configureRewriteRef() {
  try {
    execFileSync("git", ["config", "notes.rewriteRef", NOTES_REF], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["config", "notes.rewrite.rebase", "true"], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    execFileSync("git", ["config", "notes.rewrite.amend", "true"], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Check if notes.rewriteRef is already configured.
 */
function isRewriteConfigured() {
  try {
    const val = execFileSync("git", ["config", "--get", "notes.rewriteRef"], {
      encoding: "utf-8",
      timeout: NOTE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return val.includes("sticky-note");
  } catch (_) {
    return false;
  }
}

/**
 * Configure git remote to push/fetch sticky-note notes.
 */
function configureRemoteNotes(remote = "origin") {
  try {
    // Add fetch refspec for notes
    try {
      execFileSync("git", ["config", "--add", `remote.${remote}.fetch`, `+${NOTES_REF}:${NOTES_REF}`], {
        encoding: "utf-8",
        timeout: NOTE_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (_) { /* may already exist */ }

    // Add push refspec for notes
    try {
      execFileSync("git", ["config", "--add", `remote.${remote}.push`, `+${NOTES_REF}:${NOTES_REF}`], {
        encoding: "utf-8",
        timeout: NOTE_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (_) { /* may already exist */ }

    return true;
  } catch (_) {
    return false;
  }
}

// ── Post-Rewrite Support ─────────────────────────────────

/**
 * Copy notes from old SHAs to new SHAs.
 * Input: array of { oldSha, newSha } pairs (from post-rewrite hook stdin).
 */
function copyNotesForRewrite(pairs) {
  let copied = 0;
  for (const { oldSha, newSha } of pairs) {
    const note = readNote(oldSha);
    if (note) {
      if (writeNoteFull(newSha, note)) copied++;
    }
  }
  return copied;
}

/**
 * Parse post-rewrite hook stdin: "old_sha new_sha\n" pairs.
 */
function parsePostRewriteInput(stdin) {
  const pairs = [];
  for (const line of stdin.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^[0-9a-f]{40}$/.test(parts[0]) && /^[0-9a-f]{40}$/.test(parts[1])) {
      pairs.push({ oldSha: parts[0], newSha: parts[1] });
    }
  }
  return pairs;
}

// ── Checkpoint Support ───────────────────────────────────

/**
 * Read the current checkpoint from .sticky-checkpoint file.
 */
function getCurrentCheckpoint() {
  try {
    const fs = require("fs");
    const stickyDir = path.join(process.cwd(), ".sticky-note");
    const cpFile = path.join(stickyDir, ".sticky-checkpoint");
    if (!fs.existsSync(cpFile)) return null;
    return JSON.parse(fs.readFileSync(cpFile, "utf-8"));
  } catch (_) {
    return null;
  }
}

/**
 * Save a checkpoint.
 */
function saveCheckpoint(data) {
  try {
    const fs = require("fs");
    const stickyDir = path.join(process.cwd(), ".sticky-note");
    if (!fs.existsSync(stickyDir)) fs.mkdirSync(stickyDir, { recursive: true });
    const cpFile = path.join(stickyDir, ".sticky-checkpoint");
    fs.writeFileSync(cpFile, JSON.stringify(data), "utf-8");
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Clear the current checkpoint.
 */
function clearCheckpoint() {
  try {
    const fs = require("fs");
    const cpFile = path.join(process.cwd(), ".sticky-note", ".sticky-checkpoint");
    if (fs.existsSync(cpFile)) fs.unlinkSync(cpFile);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  NOTES_REF,

  // Write
  writeNote,
  writeNoteFull,

  // Read
  readNote,
  aggregateNotes,

  // Git Blame
  gitBlame,
  parseBlameOutput,
  getShasForLineRange,

  // Configuration
  configureRewriteRef,
  isRewriteConfigured,
  configureRemoteNotes,

  // Post-Rewrite
  copyNotesForRewrite,
  parsePostRewriteInput,

  // Checkpoint
  getCurrentCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
};
