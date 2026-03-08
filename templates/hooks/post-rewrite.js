#!/usr/bin/env node
"use strict";
/**
 * post-rewrite.js — Git post-rewrite hook for Sticky Note
 *
 * Copies Git Notes from old commit SHAs to new SHAs when commits
 * are rewritten via rebase or amend. This keeps session attribution
 * alive through history rewrites.
 *
 * Install: place in .git/hooks/post-rewrite (or use core.hooksPath)
 * Git calls this with: post-rewrite <command>
 * Stdin receives: <old-sha> <new-sha>\n per rewritten commit
 */

const fs = require("fs");
const path = require("path");

let gitNotes;
try {
  // Try hooks dir first (deployed)
  gitNotes = require(path.join(__dirname, "..", ".claude", "hooks", "sticky-git-notes.js"));
} catch (_) {
  try {
    // Try relative to .git/hooks/
    gitNotes = require(path.join(__dirname, "..", "..", ".claude", "hooks", "sticky-git-notes.js"));
  } catch (_) {
    try {
      // Try templates
      gitNotes = require(path.join(__dirname, "..", "..", "templates", "hooks", "sticky-git-notes.js"));
    } catch (_) {
      // Can't load git-notes module — exit silently
      process.exit(0);
    }
  }
}

function main() {
  // Read stdin: "old_sha new_sha\n" pairs
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf-8");
  } catch (_) {
    process.exit(0);
  }

  if (!stdin.trim()) process.exit(0);

  const pairs = gitNotes.parsePostRewriteInput(stdin);
  if (pairs.length === 0) process.exit(0);

  const copied = gitNotes.copyNotesForRewrite(pairs);

  if (copied > 0 && process.env.STICKY_NOTE_DEBUG) {
    process.stderr.write(`[sticky-note] Copied ${copied} note(s) to rewritten commits\n`);
  }
}

try {
  main();
} catch (_) {
  // Never fail a git hook
  process.exit(0);
}
