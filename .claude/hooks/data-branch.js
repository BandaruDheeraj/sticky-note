#!/usr/bin/env node
"use strict";
/**
 * data-branch.js — Git plumbing for the sticky-note/data orphan branch.
 *
 * Reads/writes files via git plumbing (hash-object, update-index, write-tree,
 * commit-tree, update-ref). No working-tree checkout is ever performed.
 * All operations are synchronous; callers receive result objects on failure.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const DATA_BRANCH = "sticky-note/data";
const DATA_REF = "refs/heads/" + DATA_BRANCH;

const GIT_OPTS = { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] };

// ── Git helpers ───────────────────────────────────────────

function getDefaultRemote() {
  try {
    const out = execFileSync("git", ["remote"], {
      encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out.split(/\r?\n/)[0] || null;
  } catch (_) {
    return null;
  }
}

/** Returns file content from a git ref as a string, or null if not found. */
function readFileFromBranch(ref, filePath) {
  try {
    return execFileSync("git", ["show", ref + ":" + filePath], GIT_OPTS);
  } catch (_) {
    return null;
  }
}

/**
 * Commit { relativePath: content } to a branch using git plumbing.
 * Does not touch the working tree or the main index. Returns the new commit SHA.
 */
function commitFilesToBranch(branchName, fileMap) {
  const branchRef = "refs/heads/" + branchName;
  const tmpIndex = path.join(
    os.tmpdir(),
    "sticky-idx-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
  );

  try {
    let parentSha = null;
    try {
      parentSha = execFileSync("git", ["rev-parse", "--verify", branchRef], {
        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (_) {
      // Branch doesn't exist yet — first commit creates it as orphan
    }

    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    if (parentSha) {
      execFileSync("git", ["read-tree", parentSha], {
        timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
        env: indexEnv,
      });
    }

    for (const [filePath, content] of Object.entries(fileMap)) {
      const blobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
        input: content,
        encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      execFileSync(
        "git",
        ["update-index", "--add", "--cacheinfo", "100644," + blobSha + "," + filePath],
        { timeout: 5000, stdio: ["pipe", "pipe", "pipe"], env: indexEnv }
      );
    }

    const treeSha = execFileSync("git", ["write-tree"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      env: indexEnv,
    }).trim();

    const commitArgs = ["commit-tree", treeSha, "-m", "chore(sticky-note): sync thread data"];
    if (parentSha) {
      commitArgs.push("-p", parentSha);
    }

    const commitSha = execFileSync("git", commitArgs, GIT_OPTS).trim();

    execFileSync("git", ["update-ref", branchRef, commitSha], {
      timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });

    return commitSha;
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch (_) {}
  }
}

// ── Fetch ─────────────────────────────────────────────────

/**
 * Fetch the remote data branch into a local remote-tracking ref.
 * Returns { ok, sha, error, remoteRef }.
 */
function fetchDataBranch(remote, branchName) {
  branchName = branchName || DATA_BRANCH;
  remote = remote || getDefaultRemote();
  if (!remote) return { ok: false, sha: null, error: "no remote configured", remoteRef: null };

  const remoteRef = "refs/remotes/" + remote + "/" + branchName;
  try {
    execFileSync(
      "git",
      ["fetch", remote, branchName + ":" + remoteRef],
      { timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    );
    let sha = null;
    try {
      sha = execFileSync("git", ["rev-parse", "--verify", remoteRef], {
        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (_) {}
    return { ok: true, sha, error: null, remoteRef };
  } catch (err) {
    return { ok: false, sha: null, error: err.message, remoteRef };
  }
}

// ── Push with retry ────────────────────────────────────────

/**
 * Push the local data branch to the remote, retrying on rejection.
 * On non-fast-forward rejection, fetches and merges before retrying.
 * Returns { ok, error }.
 */
function pushDataBranch(remote, branchName, maxRetries, localMemPath, loadJsonFn, saveJsonFn) {
  branchName = branchName || DATA_BRANCH;
  remote = remote || getDefaultRemote();
  maxRetries = maxRetries || 3;
  if (!remote) return { ok: false, error: "no remote configured" };

  const pushSpec = DATA_REF + ":" + DATA_REF;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execFileSync("git", ["push", remote, pushSpec], {
        timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true, error: null };
    } catch (err) {
      if (attempt === maxRetries) {
        return { ok: false, error: err.message };
      }

      // Fetch, merge, and re-commit so the next push attempt advances the ref
      try {
        const fetchResult = fetchDataBranch(remote, branchName);
        if (fetchResult.ok && fetchResult.remoteRef && localMemPath) {
          const remoteContent = readFileFromBranch(fetchResult.remoteRef, "sticky-note.json");
          if (remoteContent) {
            mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn);
            const mergedContent = fs.readFileSync(localMemPath, "utf-8");
            commitFilesToBranch(branchName, { "sticky-note.json": mergedContent });
          }
        }
      } catch (_) {}

      // Brief exponential backoff (busy-wait — synchronous context)
      const end = Date.now() + Math.pow(2, attempt) * 300;
      while (Date.now() < end) {}
    }
  }
  return { ok: false, error: "max retries exceeded" };
}

// ── Thread merge ──────────────────────────────────────────

function _mostRecentTimestamp(thread) {
  return thread.last_activity_at || thread.updated_at || thread.created_at || "";
}

/**
 * Merge two thread arrays, preferring the more-recently-active copy
 * when both contain the same thread ID.
 */
function mergeThreadArrays(localThreads, remoteThreads) {
  const merged = new Map();

  for (const t of (localThreads || [])) {
    if (t && t.id) merged.set(t.id, t);
  }

  for (const t of (remoteThreads || [])) {
    if (!t || !t.id) continue;
    const existing = merged.get(t.id);
    if (!existing || _mostRecentTimestamp(t) > _mostRecentTimestamp(existing)) {
      merged.set(t.id, t);
    }
  }

  return Array.from(merged.values());
}

const EMPTY_MEMORY = { version: "2", project: "", threads: [] };

/**
 * Merge remote sticky-note.json content into the local memory file.
 * Uses loadJsonFn/saveJsonFn when provided, otherwise reads/writes directly.
 */
function mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn) {
  let remoteMemory;
  try {
    remoteMemory = JSON.parse(remoteContent);
  } catch (_) {
    return; // corrupt remote — skip
  }

  const localMemory = loadJsonFn
    ? loadJsonFn(localMemPath, { ...EMPTY_MEMORY })
    : { ...EMPTY_MEMORY };

  const localThreads = Array.isArray(localMemory.threads) ? localMemory.threads.filter(Boolean) : [];
  const remoteThreads = Array.isArray(remoteMemory.threads) ? remoteMemory.threads.filter(Boolean) : [];
  localMemory.threads = mergeThreadArrays(localThreads, remoteThreads);

  if (saveJsonFn) {
    saveJsonFn(localMemPath, localMemory);
  } else {
    fs.mkdirSync(path.dirname(localMemPath), { recursive: true });
    fs.writeFileSync(localMemPath, JSON.stringify(localMemory, null, 2) + "\n", "utf-8");
  }
}

// ── Exports ───────────────────────────────────────────────

module.exports = {
  DATA_BRANCH,
  DATA_REF,
  getDefaultRemote,
  readFileFromBranch,
  commitFilesToBranch,
  fetchDataBranch,
  pushDataBranch,
  mergeThreadArrays,
  mergeAndSaveFromRemote,
};
