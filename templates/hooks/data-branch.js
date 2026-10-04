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

// ── Credential helpers ────────────────────────────────────

/**
 * Read STICKY_PUSH_TOKEN from env or .env.sticky file.
 * Returns the token string or null.
 */
function _getPushToken() {
  if (process.env.STICKY_PUSH_TOKEN) return process.env.STICKY_PUSH_TOKEN;
  try {
    // Walk up to find .env.sticky
    let dir = process.cwd();
    for (let i = 0; i < 20; i++) {
      const envPath = path.join(dir, ".env.sticky");
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, "utf-8");
        const match = content.match(/^STICKY_PUSH_TOKEN=(.+)$/m);
        if (match) return match[1].trim();
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch (_) {}
  return null;
}

/**
 * Given a remote name, return an authenticated push URL if STICKY_PUSH_TOKEN
 * is configured. Embeds the token into the HTTPS URL so the push works from
 * any process context without needing a credential helper.
 * Returns null if no token or remote URL is not HTTPS.
 */
function _getAuthenticatedUrl(remote) {
  const token = _getPushToken();
  if (!token) return null;
  try {
    const url = execFileSync("git", ["remote", "get-url", remote], GIT_OPTS).trim();
    if (!url.startsWith("https://")) return null;
    // Insert token: https://TOKEN@github.com/...
    return url.replace(/^https:\/\/([^@]*)@?/, `https://${token}@`);
  } catch (_) {
    return null;
  }
}

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

/** Returns all file paths in a git ref as an array. */
function listFilesInBranch(ref) {
  try {
    const out = execFileSync("git", ["ls-tree", "-r", "--name-only", ref], GIT_OPTS);
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch (_) {
    return [];
  }
}

/**
 * Commit { relativePath: content } to a branch using git plumbing.
 * Does not touch the working tree or the main index. Returns the new commit SHA.
 * explicitParentSha: if provided, use this SHA as the parent instead of the
 * current local branch tip (used during retry to parent off the remote SHA).
 */
function commitFilesToBranch(branchName, fileMap, explicitParentSha) {
  const branchRef = "refs/heads/" + branchName;
  const tmpIndex = path.join(
    os.tmpdir(),
    "sticky-idx-" + process.pid + "-" + crypto.randomBytes(4).toString("hex")
  );

  try {
    let parentSha = explicitParentSha || null;
    if (!parentSha) {
      try {
        parentSha = execFileSync("git", ["rev-parse", "--verify", branchRef], {
          encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      } catch (_) {
        // Branch doesn't exist yet — first commit creates it as orphan
      }
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
  // Use token-authenticated URL if available — bypasses credential helpers so
  // pushes work from background hook processes (no keychain/credential-manager needed).
  const pushTarget = _getAuthenticatedUrl(remote) || remote;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      execFileSync("git", ["push", pushTarget, pushSpec], {
        timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true, error: null };
    } catch (err) {
      if (attempt === maxRetries) {
        return { ok: false, error: err.message };
      }

      // Fetch remote, build a merged file map (local files + remote files +
      // merged sticky-note.json), then re-commit parented off the remote SHA
      // so the next push attempt is a fast-forward.
      try {
        const fetchResult = fetchDataBranch(remote, branchName);
        if (fetchResult.ok && fetchResult.remoteRef) {
          // Get the remote SHA to use as parent for the re-commit
          const remoteSha = execFileSync(
            "git", ["rev-parse", fetchResult.remoteRef], GIT_OPTS
          ).trim();

          // Build merged file map: start with remote files as base, then
          // overlay local files so this user's audit/presence are preserved.
          // Capture remote sticky-note.json BEFORE the local overlay so we
          // have the actual remote content to merge (not the local overwrite).
          const fileMap = {};
          const localRef = "refs/heads/" + branchName;
          let remoteStickyContent = null;

          // Only allow valid data-branch paths — prevents perpetuating bad paths
          // that may have been committed by an earlier buggy migration.
          function _isValidDataPath(f) {
            if (f === "sticky-note.json") return true;
            return f.startsWith("audit/") || f.startsWith("presence/") || f.startsWith("transcripts/");
          }

          for (const f of listFilesInBranch(fetchResult.remoteRef)) {
            if (!_isValidDataPath(f)) continue;
            const content = readFileFromBranch(fetchResult.remoteRef, f);
            if (content !== null) {
              fileMap[f] = content;
              if (f === "sticky-note.json") remoteStickyContent = content;
            }
          }
          for (const f of listFilesInBranch(localRef)) {
            if (!_isValidDataPath(f)) continue;
            const content = readFileFromBranch(localRef, f);
            if (content !== null) fileMap[f] = content;
          }

          // Merge sticky-note.json from both sides using captured remote content
          if (localMemPath && remoteStickyContent) {
            mergeAndSaveFromRemote(
              localMemPath, remoteStickyContent, loadJsonFn, saveJsonFn
            );
            fileMap["sticky-note.json"] = fs.readFileSync(localMemPath, "utf-8");
          }

          if (Object.keys(fileMap).length > 0) {
            commitFilesToBranch(branchName, fileMap, remoteSha);
          }
        }
      } catch (_) {}

      // Brief exponential backoff — use Atomics.wait to block without CPU spin
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.pow(2, attempt) * 300);
      } catch (_) {
        // Atomics.wait unavailable (e.g. SharedArrayBuffer disabled) — skip delay
      }
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

  let localMemory;
  if (loadJsonFn) {
    localMemory = loadJsonFn(localMemPath, { ...EMPTY_MEMORY });
  } else {
    try {
      localMemory = JSON.parse(fs.readFileSync(localMemPath, "utf-8"));
    } catch (_) {
      localMemory = { ...EMPTY_MEMORY };
    }
  }

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
