#!/usr/bin/env node
"use strict";
/**
 * data-branch.js — Git plumbing module for the sticky-note/data branch.
 *
 * Commits files to and reads files from the sticky-note/data orphan branch
 * using git plumbing commands (hash-object, update-index, write-tree,
 * commit-tree, update-ref). No working-tree checkout is ever performed.
 *
 * All operations are synchronous and non-blocking on failure — callers
 * receive a result object indicating success/failure rather than an exception.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const DATA_BRANCH = "sticky-note/data";
const DATA_REF = "refs/heads/" + DATA_BRANCH;

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

/**
 * Read a file's content from a git ref (branch, commit, remote-tracking ref).
 * Returns the file content as a string, or null if not found.
 */
function readFileFromBranch(ref, filePath) {
  try {
    return execFileSync("git", ["show", ref + ":" + filePath], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (_) {
    return null;
  }
}

/**
 * Commit a map of { relativePath: content } to the sticky-note/data branch
 * using git plumbing. Does not touch the working tree or the main index.
 * Returns the new commit SHA.
 *
 * @param {string} branchName  e.g. "sticky-note/data"
 * @param {Object} fileMap     e.g. { "sticky-note.json": "...", "audit/user.jsonl": "..." }
 */
function commitFilesToBranch(branchName, fileMap) {
  const branchRef = "refs/heads/" + branchName;
  const tmpIndex = path.join(
    os.tmpdir(),
    "sticky-idx-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
  );

  try {
    // Resolve parent commit SHA (null if branch doesn't exist yet)
    let parentSha = null;
    try {
      parentSha = execFileSync("git", ["rev-parse", "--verify", branchRef], {
        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch (_) {
      // Branch doesn't exist yet — first commit will create it (orphan)
    }

    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    // Seed the temp index from the existing tree so we only update changed files
    if (parentSha) {
      execFileSync("git", ["read-tree", parentSha], {
        timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
        env: indexEnv,
      });
    }

    // Write each file as a blob and add to index
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

    // Write tree from temp index
    const treeSha = execFileSync("git", ["write-tree"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      env: indexEnv,
    }).trim();

    // Build commit-tree args
    const commitArgs = [
      "commit-tree", treeSha,
      "-m", "chore(sticky-note): sync thread data",
    ];
    if (parentSha) {
      commitArgs.push("-p", parentSha);
    }

    const commitSha = execFileSync("git", commitArgs, {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Advance the branch ref
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
 * Returns { ok: bool, sha: string|null, error: string|null, remoteRef: string }
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
 * Push the local data branch to the remote with up to maxRetries attempts.
 * On push rejection (non-fast-forward), fetches and merges before retrying.
 * Returns { ok: bool, error: string|null }
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
      // Push rejected — fetch, merge, re-commit merged result, then retry
      try {
        const fetchResult = fetchDataBranch(remote, branchName);
        if (fetchResult.ok && fetchResult.remoteRef && localMemPath) {
          const remoteContent = readFileFromBranch(fetchResult.remoteRef, "sticky-note.json");
          if (remoteContent) {
            mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn);
            // Re-commit the merged file so the retry push advances the ref
            const mergedContent = fs.readFileSync(localMemPath, "utf-8");
            commitFilesToBranch(branchName, { "sticky-note.json": mergedContent });
          }
        }
      } catch (_) {}
      // Brief backoff before retry (busy-wait, synchronous context)
      const waitMs = Math.pow(2, attempt) * 300;
      const end = Date.now() + waitMs;
      while (Date.now() < end) {}
    }
  }
  return { ok: false, error: "max retries exceeded" };
}

// ── Thread merge ──────────────────────────────────────────

/**
 * Merge two thread arrays, preferring the more-recently-active copy for
 * same-id threads. Threads only present in one array are preserved as-is.
 */
function mergeThreadArrays(localThreads, remoteThreads) {
  const merged = new Map();

  for (const t of (localThreads || [])) {
    if (t && t.id) merged.set(t.id, t);
  }

  for (const t of (remoteThreads || [])) {
    if (!t || !t.id) continue;
    const existing = merged.get(t.id);
    if (!existing) {
      merged.set(t.id, t);
      continue;
    }
    // Same thread on both sides — keep the more recent one
    const localTs = existing.last_activity_at || existing.updated_at || existing.created_at || "";
    const remoteTs = t.last_activity_at || t.updated_at || t.created_at || "";
    if (remoteTs > localTs) {
      merged.set(t.id, t);
    }
  }

  return Array.from(merged.values());
}

/**
 * Merge remote sticky-note.json content into the local memory file.
 * Writes the merged result back to localMemPath.
 *
 * @param {string} localMemPath   Absolute path to local sticky-note.json
 * @param {string} remoteContent  Raw JSON string from the remote branch
 * @param {Function|null} loadJsonFn  Optional: (filePath, defaultVal) => object
 * @param {Function|null} saveJsonFn  Optional: (filePath, object) => void
 */
function mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn) {
  let remoteMemory;
  try {
    remoteMemory = JSON.parse(remoteContent);
  } catch (_) {
    return; // corrupt remote — skip
  }

  const localMemory = loadJsonFn
    ? loadJsonFn(localMemPath, { version: "2", project: "", threads: [] })
    : { version: "2", project: "", threads: [] };

  const mergedThreads = mergeThreadArrays(
    Array.isArray(localMemory.threads) ? localMemory.threads.filter(Boolean) : [],
    Array.isArray(remoteMemory.threads) ? remoteMemory.threads.filter(Boolean) : []
  );

  localMemory.threads = mergedThreads;
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
