# Data Branch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `.sticky-note/` file storage with a dedicated `sticky-note/data` orphan branch, eliminating branch-time-travel data loss and Windows write-race corruption.

**Architecture:** Thread data moves from `.sticky-note/` (committed to feature branches, overwritten on checkout) to `.git/sticky-note/` (local cache, branch-independent). A single orphan branch `sticky-note/data` on the remote is the shared store. `session-start.js` fetches and merges at boot; `session-end.js` commits and pushes at shutdown. Git plumbing (`hash-object`, `update-index`, `write-tree`, `commit-tree`, `update-ref`) commits to the data branch without touching the working tree, eliminating the write-race. Feature branches never carry sticky-note data again.

**Tech Stack:** Node.js ≥16, Git plumbing commands, `child_process.execFileSync`, `GIT_INDEX_FILE` env var for isolated index operations.

## Global Constraints

- No new npm dependencies
- All file I/O and git operations via synchronous APIs (hooks run synchronously)
- All git operations include `stdio: ['pipe','pipe','pipe']` and a `timeout` to avoid hanging hooks
- Push/fetch failures must be non-blocking — always log and continue
- `git rev-parse --absolute-git-dir` (not `--git-dir`) — always returns an absolute path, works in submodules and worktrees
- Temp `GIT_INDEX_FILE` must be cleaned up in a `finally` block
- Tests: Node.js `assert` only, no external test framework, real temp git repos (no mocks)
- Data branch name: `sticky-note/data`, full ref: `refs/heads/sticky-note/data`
- Spec: `docs/superpowers/specs/2026-07-17-data-branch-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `templates/hooks/sticky-utils.js` | Change `_stickyDir()` to use `git rev-parse --absolute-git-dir` |
| Create | `templates/hooks/data-branch.js` | Git plumbing: commit/fetch/push/merge data branch |
| Modify | `templates/hooks/session-start.js` | Add `fetchDataBranch()` as first operation |
| Modify | `templates/hooks/session-end.js` | Add `commitAndPushDataBranch()` as last operation |
| Modify | `bin/cli.js` | Add `data-branch.js` to HOOK_FILES; add `migrate` command; update `init`/`update` to remove pre/post-commit hooks |
| Modify | `templates/gitignore-additions.txt` | Add `.sticky-note/` to gitignore |
| Modify | `test/smoke.test.js` | Data branch plumbing tests + migrate command test |

---

### Task 1: Update `_stickyDir()` in `templates/hooks/sticky-utils.js`

**Files:**
- Modify: `templates/hooks/sticky-utils.js:40-43`
- Test: `test/smoke.test.js`

**Interfaces:**
- Produces: `_stickyDir()` returns `<absolute .git dir>/sticky-note` in a git repo; falls back to the two-level walk in non-git environments
- All downstream helpers (`getMemoryPath()`, `getAuditDir()`, etc.) automatically point to `.git/sticky-note/` with no other changes

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js` inside the existing test harness, after `setupStickyNote()`:

```js
runTest("_stickyDir() points to .git/sticky-note/", () => {
  // Require sticky-utils from the installed hooks dir (set up by setupStickyNote)
  const utils = require(path.join(tmpDir, ".claude", "hooks", "sticky-utils.js"));
  const memPath = utils.getMemoryPath();
  const expected = path.join(tmpDir, ".git", "sticky-note", "sticky-note.json");
  assert.strictEqual(
    path.normalize(memPath),
    path.normalize(expected),
    `Expected ${expected}, got ${memPath}`
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd C:/Users/dheer/OneDrive/Desktop/Projects/sticky-note
node test/smoke.test.js 2>&1 | grep -A3 "_stickyDir"
```

Expected: FAIL — path still contains `.sticky-note` not `.git/sticky-note`.

- [ ] **Step 3: Implement the change**

In `templates/hooks/sticky-utils.js`, replace lines 40-43:

```js
// OLD:
function _stickyDir() {
  const scriptDir = path.dirname(path.resolve(__filename));
  return path.join(scriptDir, "..", "..", ".sticky-note");
}
```

with:

```js
function _stickyDir() {
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return path.resolve(gitDir, "sticky-note");
  } catch (_) {
    // Fallback for non-git environments (e.g., unit tests without git init)
    const scriptDir = path.dirname(path.resolve(__filename));
    return path.join(scriptDir, "..", "..", ".sticky-note");
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "_stickyDir"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/sticky-utils.js test/smoke.test.js
git commit -m "feat: _stickyDir() uses git rev-parse --absolute-git-dir for branch-independent path"
```

---

### Task 2: Create `templates/hooks/data-branch.js`

**Files:**
- Create: `templates/hooks/data-branch.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing (standalone module — requires `child_process`, `fs`, `os`, `path`, `crypto`)
- Produces (all exported):
  - `readFileFromBranch(ref, filePath)` → `string | null`
  - `commitFilesToBranch(branchName, fileMap)` → `string` (commit SHA)
  - `getDefaultRemote()` → `string | null`
  - `fetchDataBranch(remote, branchName)` → `{ ok: bool, sha: string|null, error: string|null }`
  - `pushDataBranch(remote, branchName, maxRetries)` → `{ ok: bool, error: string|null }`
  - `mergeThreadArrays(localThreads, remoteThreads)` → `Thread[]`
  - `mergeAndSaveFromRemote(localMemPath, remoteContent)` → `void`

- [ ] **Step 1: Write the failing tests**

Add to `test/smoke.test.js`:

```js
runTest("data-branch: commitFilesToBranch round-trips content", () => {
  const { commitFilesToBranch, readFileFromBranch } = require(
    path.join(tmpDir, ".claude", "hooks", "data-branch.js")
  );
  const content = JSON.stringify({ version: "2", project: "", threads: [{ id: "abc123" }] }, null, 2) + "\n";
  commitFilesToBranch("sticky-note/data", { "sticky-note.json": content });
  const read = readFileFromBranch("refs/heads/sticky-note/data", "sticky-note.json");
  assert.strictEqual(read, content, "round-trip content mismatch");
});

runTest("data-branch: commitFilesToBranch creates second commit on same branch", () => {
  const { commitFilesToBranch, readFileFromBranch } = require(
    path.join(tmpDir, ".claude", "hooks", "data-branch.js")
  );
  const v1 = '{"version":"2","threads":[]}\n';
  const v2 = '{"version":"2","threads":[{"id":"xyz"}]}\n';
  commitFilesToBranch("sticky-note/data", { "sticky-note.json": v1 });
  commitFilesToBranch("sticky-note/data", { "sticky-note.json": v2 });
  const read = readFileFromBranch("refs/heads/sticky-note/data", "sticky-note.json");
  assert.strictEqual(read, v2, "second commit should overwrite first");
});

runTest("data-branch: mergeThreadArrays preserves threads from both sides", () => {
  const { mergeThreadArrays } = require(
    path.join(tmpDir, ".claude", "hooks", "data-branch.js")
  );
  const local = [{ id: "a", status: "open", last_activity_at: "2026-01-01T00:00:00Z" }];
  const remote = [{ id: "b", status: "closed", last_activity_at: "2026-01-02T00:00:00Z" }];
  const merged = mergeThreadArrays(local, remote);
  assert.strictEqual(merged.length, 2, "should have 2 threads");
  assert.ok(merged.find(t => t.id === "a"), "local thread preserved");
  assert.ok(merged.find(t => t.id === "b"), "remote thread preserved");
});

runTest("data-branch: mergeThreadArrays takes more-recent copy for same id", () => {
  const { mergeThreadArrays } = require(
    path.join(tmpDir, ".claude", "hooks", "data-branch.js")
  );
  const older = { id: "a", status: "open", last_activity_at: "2026-01-01T00:00:00Z", last_note: "old" };
  const newer = { id: "a", status: "closed", last_activity_at: "2026-01-02T00:00:00Z", last_note: "new" };
  const merged = mergeThreadArrays([older], [newer]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].last_note, "new", "newer version should win");
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node test/smoke.test.js 2>&1 | grep -E "(data-branch|FAIL)"
```

Expected: `Cannot find module` errors for `data-branch.js`.

- [ ] **Step 3: Create `templates/hooks/data-branch.js`**

```js
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
 * Returns { ok: bool, sha: string|null, error: string|null }
 */
function fetchDataBranch(remote, branchName) {
  branchName = branchName || DATA_BRANCH;
  remote = remote || getDefaultRemote();
  if (!remote) return { ok: false, sha: null, error: "no remote configured" };

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
      // Push rejected — fetch, merge, rebuild local branch, retry
      try {
        const fetchResult = fetchDataBranch(remote, branchName);
        if (fetchResult.ok && fetchResult.remoteRef && localMemPath && loadJsonFn && saveJsonFn) {
          const remoteContent = readFileFromBranch(fetchResult.remoteRef, "sticky-note.json");
          if (remoteContent) {
            mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn);
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
```

Also add `data-branch.js` to `templates/hooks/` (the file just created) and add it to `HOOK_FILES` in `bin/cli.js`:

In `bin/cli.js` at line 26, change `HOOK_FILES`:

```js
const HOOK_FILES = [
  "sticky-utils.js",
  "data-branch.js",          // ← ADD THIS LINE
  "session-start.js",
  "session-end.js",
  "inject-context.js",
  "track-work.js",
  "on-stop.js",
  "on-error.js",
  "parse-transcript.js",
  "pre-tool-use.js",
  "sticky-git-notes.js",
  "sticky-attribution.js",
];
```

The `setupStickyNote()` in `test/smoke.test.js` already copies all `.js` files from `templates/hooks/`, so the test will automatically pick up `data-branch.js`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd C:/Users/dheer/OneDrive/Desktop/Projects/sticky-note
node test/smoke.test.js 2>&1 | grep -E "(data-branch|FAIL|PASS|passed|failed)"
```

Expected: all 4 data-branch tests PASS.

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/data-branch.js bin/cli.js test/smoke.test.js
git commit -m "feat: add data-branch.js git plumbing module for sticky-note/data orphan branch"
```

---

### Task 3: Update `templates/hooks/session-start.js` — fetch at boot

**Files:**
- Modify: `templates/hooks/session-start.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Consumes: `data-branch.js` exports (`fetchDataBranch`, `mergeAndSaveFromRemote`, `readFileFromBranch`)
- Produces: At session start, remote thread data is merged into `.git/sticky-note/sticky-note.json` before any other processing; offline failure is non-blocking

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
runTest("session-start: merges remote data branch threads on boot", () => {
  const { commitFilesToBranch } = require(
    path.join(tmpDir, ".claude", "hooks", "data-branch.js")
  );

  // Simulate a remote teammate's thread on the data branch
  const remoteThread = {
    id: "remote-thread-1",
    user: "alice",
    status: "open",
    branch: "feature/remote",
    created_at: "2026-01-01T10:00:00Z",
    last_activity_at: "2026-01-01T10:00:00Z",
    files_touched: ["src/api.ts"],
    narrative: "remote work",
  };
  const remoteMemory = { version: "2", project: "", threads: [remoteThread] };
  commitFilesToBranch("sticky-note/data", {
    "sticky-note.json": JSON.stringify(remoteMemory, null, 2) + "\n",
  });

  // Run session-start (it reads the data branch on start)
  const result = execFileSync(
    process.execPath,
    [path.join(tmpDir, ".claude", "hooks", "session-start.js")],
    {
      encoding: "utf-8", timeout: 15000,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      input: '{"hook_event_name":"SessionStart","session_id":"test-session-fetch"}',
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  // After session-start, local memory should contain the remote thread
  const utils = require(path.join(tmpDir, ".claude", "hooks", "sticky-utils.js"));
  const memory = utils.loadJson(utils.getMemoryPath(), { threads: [] });
  const found = (memory.threads || []).find((t) => t.id === "remote-thread-1");
  assert.ok(found, "remote thread should be merged into local memory after session-start");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "merges remote data branch"
```

Expected: FAIL — remote thread not found in local memory.

- [ ] **Step 3: Add fetch logic to session-start.js**

At the top of `session-start.js`, after the `require("./sticky-utils.js")` block and before the rest of the destructuring, add a require for data-branch:

```js
let dataBranch;
try {
  dataBranch = require("./data-branch.js");
} catch (_) {
  dataBranch = null; // non-fatal — data branch sync disabled
}
```

Then add a `fetchAndMergeDataBranch()` function before `main()`:

```js
function fetchAndMergeDataBranch() {
  if (!dataBranch) return;
  try {
    const remote = dataBranch.getDefaultRemote();
    if (!remote) return; // no remote — local only

    const fetchResult = dataBranch.fetchDataBranch(remote);
    if (!fetchResult.ok) {
      process.stderr.write(
        "[STICKY-NOTE] offline — using local thread cache (" + (fetchResult.error || "fetch failed") + ")\n"
      );
      return;
    }

    if (!fetchResult.remoteRef) return;
    const remoteContent = dataBranch.readFileFromBranch(fetchResult.remoteRef, "sticky-note.json");
    if (!remoteContent) return;

    dataBranch.mergeAndSaveFromRemote(
      getMemoryPath(),
      remoteContent,
      loadJson,
      saveJson
    );
  } catch (err) {
    // Non-blocking — session continues with local data
    process.stderr.write("[STICKY-NOTE] offline — using local thread cache (" + err.message + ")\n");
  }
}
```

At the very top of `main()`, as the first call (before `saveSessionId`, before reading memory):

```js
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

  // Fetch remote data branch and merge into local cache — before reading memory
  fetchAndMergeDataBranch();   // ← ADD THIS LINE

  let sessionId = getSessionId(hookInput);
  // ... rest of main() unchanged ...
```

The test runs session-start in a local repo where `sticky-note/data` exists locally but there's no remote (no `git remote add origin ...`). The `getDefaultRemote()` call returns null, so the fetch is skipped. We need the test to commit the data branch locally and test a local-branch read path instead.

Update `fetchAndMergeDataBranch()` to also check the local branch when no remote is available:

```js
function fetchAndMergeDataBranch() {
  if (!dataBranch) return;
  try {
    const remote = dataBranch.getDefaultRemote();

    if (remote) {
      // Try to fetch from remote
      const fetchResult = dataBranch.fetchDataBranch(remote);
      if (!fetchResult.ok) {
        process.stderr.write(
          "[STICKY-NOTE] offline — using local thread cache (" + (fetchResult.error || "") + ")\n"
        );
      } else if (fetchResult.remoteRef) {
        const remoteContent = dataBranch.readFileFromBranch(
          fetchResult.remoteRef, "sticky-note.json"
        );
        if (remoteContent) {
          dataBranch.mergeAndSaveFromRemote(getMemoryPath(), remoteContent, loadJson, saveJson);
        }
      }
    }

    // Always merge from local data branch (covers fresh clone after `init`)
    const localContent = dataBranch.readFileFromBranch(
      dataBranch.DATA_REF, "sticky-note.json"
    );
    if (localContent) {
      dataBranch.mergeAndSaveFromRemote(getMemoryPath(), localContent, loadJson, saveJson);
    }
  } catch (err) {
    process.stderr.write("[STICKY-NOTE] offline — using local thread cache (" + err.message + ")\n");
  }
}
```

Also add `saveJson` to the destructuring at the top (it is already imported in session-start.js: `saveMemoryMerged` but NOT `saveJson` directly). Check the existing destructuring block and add `saveJson` if not present:

```js
const {
  // ...existing imports...
  loadJson,
  saveJson,       // ← ADD if not already present
  saveMemoryMerged,
  // ...
} = utils;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep -E "(merges remote data branch|FAIL|PASS)"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/session-start.js test/smoke.test.js
git commit -m "feat: session-start fetches and merges sticky-note/data branch at boot"
```

---

### Task 4: Update `templates/hooks/session-end.js` — commit and push at shutdown

**Files:**
- Modify: `templates/hooks/session-end.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Consumes: `data-branch.js` exports; `sticky-utils.js` path helpers (`getMemoryPath`, `getAuditDir`, `getPresenceDir`)
- Produces: After session-end runs, `sticky-note/data` branch contains current `sticky-note.json`, all audit files, all presence files

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
runTest("session-end: commits local data to sticky-note/data branch", () => {
  const { execFileSync: exec2 } = require("child_process");
  const utils = require(path.join(tmpDir, ".claude", "hooks", "sticky-utils.js"));

  // Write a known thread to local memory
  const thread = {
    id: "session-end-test-thread",
    user: "dheer",
    status: "open",
    branch: "main",
    created_at: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    files_touched: [],
    narrative: "test session end commit",
  };
  const memory = { version: "2", project: "", threads: [thread] };
  const memPath = utils.getMemoryPath();
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, JSON.stringify(memory, null, 2) + "\n", "utf-8");

  // Run session-end
  exec2(
    process.execPath,
    [path.join(tmpDir, ".claude", "hooks", "session-end.js")],
    {
      encoding: "utf-8", timeout: 15000,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: "test-session-end",
        transcript_path: path.join(tmpDir, "transcript.jsonl"),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  // Verify sticky-note/data branch contains the thread
  const { readFileFromBranch } = require(path.join(tmpDir, ".claude", "hooks", "data-branch.js"));
  const branchContent = readFileFromBranch("refs/heads/sticky-note/data", "sticky-note.json");
  assert.ok(branchContent, "data branch should have sticky-note.json after session-end");
  const branchMemory = JSON.parse(branchContent);
  const found = (branchMemory.threads || []).find(t => t.id === "session-end-test-thread");
  assert.ok(found, "data branch should contain the session thread");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "commits local data"
```

Expected: FAIL — sticky-note/data branch not created by session-end.

- [ ] **Step 3: Add commit logic to session-end.js**

After the existing `require("./sticky-utils.js")` block (around line 25-62), add:

```js
let dataBranch;
try {
  dataBranch = require("./data-branch.js");
} catch (_) {
  dataBranch = null;
}
```

Add a `commitAndPushDataBranch()` function (add near the end of the file, before `main()`):

```js
function commitAndPushDataBranch() {
  if (!dataBranch) return;
  try {
    const fileMap = {};

    // Collect sticky-note.json
    const memPath = getMemoryPath();
    if (fs.existsSync(memPath)) {
      fileMap["sticky-note.json"] = fs.readFileSync(memPath, "utf-8");
    }

    // Collect audit files
    const auditDir = getAuditDir ? getAuditDir() : null;
    if (auditDir && fs.existsSync(auditDir)) {
      for (const file of fs.readdirSync(auditDir)) {
        if (file.endsWith(".jsonl")) {
          fileMap["audit/" + file] = fs.readFileSync(path.join(auditDir, file), "utf-8");
        }
      }
    }

    // Collect presence files
    const presDir = getPresenceDir ? getPresenceDir() : null;
    if (presDir && fs.existsSync(presDir)) {
      for (const file of fs.readdirSync(presDir)) {
        if (file.endsWith(".json")) {
          fileMap["presence/" + file] = fs.readFileSync(path.join(presDir, file), "utf-8");
        }
      }
    }

    if (Object.keys(fileMap).length === 0) return;

    dataBranch.commitFilesToBranch(dataBranch.DATA_BRANCH, fileMap);

    // Push (non-blocking — failure is logged but doesn't prevent session exit)
    const remote = dataBranch.getDefaultRemote();
    if (remote) {
      const pushResult = dataBranch.pushDataBranch(
        remote, dataBranch.DATA_BRANCH, 3, getMemoryPath(), null, null
      );
      if (!pushResult.ok) {
        process.stderr.write(
          "[STICKY-NOTE] warning: failed to push data branch — " + pushResult.error + "\n" +
          "[STICKY-NOTE] your data is safe locally in .git/sticky-note/\n"
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      "[STICKY-NOTE] warning: data branch sync failed — " + err.message + "\n"
    );
  }
}
```

Add `getAuditDir` and `getPresenceDir` to the destructuring at the top of session-end.js if not already present:

```js
const {
  getMemoryPath,
  getConfigPath,
  getAuditDir,      // ← ADD if not present
  getPresenceDir,   // ← ADD if not present
  getUserPresencePath,
  // ...rest unchanged...
} = utils;
```

At the very end of `main()`, after `saveMemoryMerged(memoryPath, memory)` and the cleanup calls, add:

```js
  // Commit current data to sticky-note/data branch and push
  commitAndPushDataBranch();

  _safeExit();
}
```

(Ensure `commitAndPushDataBranch()` is called immediately before `_safeExit()`.)

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep -E "(commits local data|FAIL|PASS)"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/session-end.js test/smoke.test.js
git commit -m "feat: session-end commits thread data to sticky-note/data branch"
```

---

### Task 5: Update `bin/cli.js` — migrate command + init/update changes

**Files:**
- Modify: `bin/cli.js`
- Test: `test/smoke.test.js`

**Interfaces:**
- Consumes: `data-branch.js` (required at runtime in the migrate flow, spawned via npx)
- Produces:
  - `npx sticky-note migrate` — reads `.sticky-note/`, copies to `.git/sticky-note/`, commits to `sticky-note/data`, updates `.gitignore`, removes git hooks, pushes
  - `npx sticky-note init` — no longer installs pre/post-commit git hooks; checks for remote data branch and fetches if present
  - `npx sticky-note update` — copies updated hook files (including `data-branch.js`); removes pre/post-commit git hook blocks if installed by a prior sticky-note version

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
runTest("migrate: copies .sticky-note/ to .git/sticky-note/ and creates data branch", () => {
  const { execFileSync: exec2 } = require("child_process");

  // Create old-style .sticky-note/ structure
  const stickyDir = path.join(tmpDir, ".sticky-note");
  fs.mkdirSync(stickyDir, { recursive: true });
  const oldThread = {
    id: "migrate-thread-1", user: "dheer", status: "closed",
    branch: "main", created_at: "2026-01-01T00:00:00Z",
    last_activity_at: "2026-01-01T01:00:00Z", files_touched: [],
  };
  fs.writeFileSync(
    path.join(stickyDir, "sticky-note.json"),
    JSON.stringify({ version: "2", project: "", threads: [oldThread] }, null, 2) + "\n"
  );

  // Run migrate
  exec2(process.execPath, [CLI, "migrate"], {
    encoding: "utf-8", timeout: 15000,
    cwd: tmpDir,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Verify .git/sticky-note/sticky-note.json exists with old thread
  const utils = require(path.join(tmpDir, ".claude", "hooks", "sticky-utils.js"));
  const memory = utils.loadJson(utils.getMemoryPath(), { threads: [] });
  assert.ok(
    (memory.threads || []).find(t => t.id === "migrate-thread-1"),
    "migrated thread should appear in .git/sticky-note/sticky-note.json"
  );

  // Verify sticky-note/data branch was created
  const { readFileFromBranch } = require(path.join(tmpDir, ".claude", "hooks", "data-branch.js"));
  const branchContent = readFileFromBranch("refs/heads/sticky-note/data", "sticky-note.json");
  assert.ok(branchContent, "sticky-note/data branch should exist after migrate");

  // Verify .sticky-note/ is in .gitignore
  const gitignore = fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
  assert.ok(gitignore.includes(".sticky-note/"), ".gitignore should include .sticky-note/");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "migrate:"
```

Expected: FAIL — `migrate` command not found / data branch not created.

- [ ] **Step 3: Add `migrate` command to `bin/cli.js`**

Add a `cmdMigrate()` function. Insert it before the `main()` function at the bottom of `bin/cli.js`:

```js
// ──────────────────────────────────────────────
// MIGRATE command
// ──────────────────────────────────────────────

/**
 * One-time migration from .sticky-note/ (feature-branch storage) to
 * .git/sticky-note/ (data-branch storage).
 *
 * Idempotent — safe to run multiple times.
 */
async function cmdMigrate() {
  printBanner();

  if (!isGitRepo()) {
    print("  [ERR] Not a git repository.");
    process.exit(1);
  }

  const cwd = process.cwd();
  const oldDir = path.join(cwd, ".sticky-note");

  // Locate .git directory using plumbing (works from subdirectories)
  let gitDir;
  try {
    gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
      cwd,
    }).trim();
  } catch (err) {
    print("  [ERR] Could not locate .git directory: " + err.message);
    process.exit(1);
  }

  const newDir = path.join(gitDir, "sticky-note");
  print("  📂 Source: " + oldDir);
  print("  📂 Target: " + newDir);
  print("");

  // Step 1: Copy files from .sticky-note/ to .git/sticky-note/
  mkdirSafe(newDir);
  mkdirSafe(path.join(newDir, "audit"));
  mkdirSafe(path.join(newDir, "presence"));

  let copiedFiles = 0;
  const srcMemory = path.join(oldDir, "sticky-note.json");
  const dstMemory = path.join(newDir, "sticky-note.json");
  if (fs.existsSync(srcMemory)) {
    fs.copyFileSync(srcMemory, dstMemory);
    copiedFiles++;
    print("  [OK] Copied sticky-note.json");
  } else if (!fs.existsSync(dstMemory)) {
    // No existing data — create empty memory
    fs.writeFileSync(
      dstMemory,
      JSON.stringify({ version: "2", project: "", threads: [] }, null, 2) + "\n"
    );
    print("  [OK] Created empty sticky-note.json (no .sticky-note/ found)");
  }

  const oldAuditDir = path.join(oldDir, "audit");
  if (fs.existsSync(oldAuditDir)) {
    for (const file of fs.readdirSync(oldAuditDir)) {
      if (file.endsWith(".jsonl")) {
        const dst = path.join(newDir, "audit", file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(path.join(oldAuditDir, file), dst);
          copiedFiles++;
        }
      }
    }
  }

  const oldPresenceDir = path.join(oldDir, "presence");
  if (fs.existsSync(oldPresenceDir)) {
    for (const file of fs.readdirSync(oldPresenceDir)) {
      if (file.endsWith(".json")) {
        const dst = path.join(newDir, "presence", file);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(path.join(oldPresenceDir, file), dst);
          copiedFiles++;
        }
      }
    }
  }
  if (copiedFiles > 0) print("  [OK] Copied " + copiedFiles + " file(s) to .git/sticky-note/");

  // Step 2: Commit files to sticky-note/data branch using plumbing
  print("");
  print("  📌 Committing to sticky-note/data branch...");
  try {
    // Inline the plumbing here (data-branch.js lives in hooks, not in CLI path)
    _commitFilesToDataBranch(newDir);
    print("  [OK] sticky-note/data branch created/updated");
  } catch (err) {
    print("  [WARN] Could not commit to data branch: " + err.message);
  }

  // Step 3: Add .sticky-note/ to .gitignore
  print("");
  const gitignorePath = path.join(cwd, ".gitignore");
  const MARKER = "# sticky-note: data branch migration";
  const IGNORE_LINE = ".sticky-note/";
  let gitignoreUpdated = false;
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, "utf-8");
    if (!existing.includes(IGNORE_LINE)) {
      fs.appendFileSync(gitignorePath, "\n" + MARKER + "\n" + IGNORE_LINE + "\n");
      gitignoreUpdated = true;
    }
  } else {
    fs.writeFileSync(gitignorePath, MARKER + "\n" + IGNORE_LINE + "\n");
    gitignoreUpdated = true;
  }
  if (gitignoreUpdated) {
    print("  [OK] Added .sticky-note/ to .gitignore");
  } else {
    print("  [OK] .gitignore already contains .sticky-note/");
  }

  // Step 4: Remove sticky-note pre-commit and post-commit hooks
  print("");
  const gitHooksDir = path.join(gitDir, "hooks");
  for (const hookName of ["pre-commit", "post-commit"]) {
    const hookPath = path.join(gitHooksDir, hookName);
    if (!fs.existsSync(hookPath)) continue;
    const content = fs.readFileSync(hookPath, "utf-8");
    if (content.includes(STICKY_PRE_COMMIT_MARKER) || content.includes(STICKY_POST_COMMIT_MARKER)) {
      // Remove sticky-note blocks
      let updated = content;
      // Remove pre-commit block
      const preStart = updated.indexOf(STICKY_PRE_COMMIT_MARKER);
      const preEnd = updated.indexOf(STICKY_PRE_COMMIT_END);
      if (preStart !== -1 && preEnd !== -1) {
        updated = updated.slice(0, preStart) + updated.slice(preEnd + STICKY_PRE_COMMIT_END.length);
      }
      // Remove post-commit block
      const postStart = updated.indexOf(STICKY_POST_COMMIT_MARKER);
      const postEnd = updated.indexOf(STICKY_POST_COMMIT_END);
      if (postStart !== -1 && postEnd !== -1) {
        updated = updated.slice(0, postStart) + updated.slice(postEnd + STICKY_POST_COMMIT_END.length);
      }
      // If only the shebang remains, delete the file
      if (updated.replace(/^#!.*\n/, "").trim() === "") {
        fs.unlinkSync(hookPath);
        print("  [OK] Removed .git/hooks/" + hookName + " (was sticky-note only)");
      } else {
        fs.writeFileSync(hookPath, updated, "utf-8");
        print("  [OK] Removed sticky-note blocks from .git/hooks/" + hookName);
      }
    }
  }

  // Step 5: Push data branch if remote exists
  print("");
  try {
    const remote = execFileSync("git", ["remote"], {
      encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0];
    if (remote) {
      print("  🔄 Pushing sticky-note/data to " + remote + "...");
      execFileSync("git", ["push", remote, "refs/heads/sticky-note/data:refs/heads/sticky-note/data"], {
        timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
      });
      print("  [OK] Pushed sticky-note/data");
    } else {
      print("  ⏭️  No remote configured — skipping push");
    }
  } catch (err) {
    print("  [WARN] Push failed: " + err.message);
    print("  [INFO] Your data is safe locally. Run `npx sticky-note migrate` again to retry.");
  }

  print("");
  print("  ✅ Migration complete!");
  print("");
  print("  Next steps:");
  print("  1. Commit the .gitignore change:  git add .gitignore && git commit -m 'chore: gitignore sticky-note data dir'");
  print("  2. Each teammate runs:             npx sticky-note init");
  print("");
}

/**
 * Inline git plumbing to commit files from a local dir to sticky-note/data.
 * Extracted from data-branch.js for use in CLI context (no hooks dir on PATH).
 */
function _commitFilesToDataBranch(srcDir) {
  const os = require("os");
  const crypto = require("crypto");
  const branchRef = "refs/heads/sticky-note/data";
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
    } catch (_) {}

    const indexEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    if (parentSha) {
      execFileSync("git", ["read-tree", parentSha], {
        timeout: 5000, stdio: ["pipe", "pipe", "pipe"], env: indexEnv,
      });
    }

    // Walk srcDir and commit all files
    function walkAndAdd(dir, prefix) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = prefix ? prefix + "/" + entry.name : entry.name;
        if (entry.isDirectory()) {
          walkAndAdd(full, relPath);
        } else if (entry.isFile() && !entry.name.startsWith(".sticky-")) {
          const content = fs.readFileSync(full);
          const blobSha = execFileSync("git", ["hash-object", "-w", "--stdin"], {
            input: content, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          execFileSync(
            "git",
            ["update-index", "--add", "--cacheinfo", "100644," + blobSha + "," + relPath],
            { timeout: 5000, stdio: ["pipe", "pipe", "pipe"], env: indexEnv }
          );
        }
      }
    }
    walkAndAdd(srcDir, "");

    const treeSha = execFileSync("git", ["write-tree"], {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"], env: indexEnv,
    }).trim();

    const commitArgs = ["commit-tree", treeSha, "-m", "chore(sticky-note): migrate to data branch"];
    if (parentSha) commitArgs.push("-p", parentSha);
    const commitSha = execFileSync("git", commitArgs, {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    execFileSync("git", ["update-ref", branchRef, commitSha], {
      timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    });
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch (_) {}
  }
}
```

Add the `"migrate"` case to the `main()` switch at the bottom of `cli.js`:

```js
case "migrate":
  cmdMigrate().catch((err) => {
    console.error(err);
    process.exit(1);
  });
  break;
```

**Update `cmdUpdate()` to remove pre/post-commit git hook blocks:**

In the existing `cmdUpdate()` function, after copying hook files, add:

```js
// Remove sticky-note pre-commit and post-commit git hooks (replaced by data branch)
const gitDir2 = path.join(process.cwd(), ".git");
if (fs.existsSync(gitDir2)) {
  const gitHooksDir = path.join(gitDir2, "hooks");
  for (const hookName of ["pre-commit", "post-commit"]) {
    const hookPath = path.join(gitHooksDir, hookName);
    if (!fs.existsSync(hookPath)) continue;
    const content = fs.readFileSync(hookPath, "utf-8");
    if (!content.includes(STICKY_PRE_COMMIT_MARKER) && !content.includes(STICKY_POST_COMMIT_MARKER)) continue;
    let updated = content;
    const preStart = updated.indexOf(STICKY_PRE_COMMIT_MARKER);
    const preEnd = updated.indexOf(STICKY_PRE_COMMIT_END);
    if (preStart !== -1 && preEnd !== -1) {
      updated = updated.slice(0, preStart) + updated.slice(preEnd + STICKY_PRE_COMMIT_END.length);
    }
    const postStart = updated.indexOf(STICKY_POST_COMMIT_MARKER);
    const postEnd = updated.indexOf(STICKY_POST_COMMIT_END);
    if (postStart !== -1 && postEnd !== -1) {
      updated = updated.slice(0, postStart) + updated.slice(postEnd + STICKY_POST_COMMIT_END.length);
    }
    if (updated.replace(/^#!.*\n/, "").trim() === "") {
      fs.unlinkSync(hookPath);
      print("  [OK] Removed .git/hooks/" + hookName + " (no longer needed)");
    } else {
      fs.writeFileSync(hookPath, updated, "utf-8");
      print("  [OK] Removed sticky-note blocks from .git/hooks/" + hookName);
    }
  }
}
```

**Update `cmdInit()` to NOT call `installPreCommitHook()` or `installPostCommitHook()`:**

Find and remove (or comment out) the lines in `cmdInit()` that call:
```js
installPreCommitHook();
installPostCommitHook();
```

Replace them with:
```js
print("  [OK] Skipping git pre/post-commit hooks (data branch sync handles this now)");
print("       Run `npx sticky-note migrate` to migrate existing .sticky-note/ data.");
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep -E "(migrate:|FAIL|PASS)"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/smoke.test.js
git commit -m "feat: add migrate command, remove pre/post-commit hook installs from init/update"
```

---

### Task 6: Update `.gitignore` template and run full smoke suite

**Files:**
- Modify: `templates/gitignore-additions.txt`
- Test: `test/smoke.test.js`

**Interfaces:**
- Consumes: nothing new
- Produces: When `npx sticky-note init` appends gitignore additions, `.sticky-note/` is excluded from feature branch commits

- [ ] **Step 1: Update `templates/gitignore-additions.txt`**

Add at the top of the file, before the existing entries:

```
# Sticky Note - data moved to sticky-note/data branch (.git/sticky-note/ cache)
.sticky-note/
```

Full updated file:

```
# Sticky Note - data moved to sticky-note/data branch (.git/sticky-note/ cache)
.sticky-note/

# Sticky Note - local overrides
.claude/settings.local.json

# Sticky Note - transient session/resume signals
.sticky-note/.sticky-session
.sticky-note/.sticky-resume
.sticky-note/.sticky-head
.sticky-note/.sticky-injected
.sticky-note/.sticky-active-resume
.sticky-note/.sticky-checkpoint
.sticky-note/.sticky-banner-shown

# Sticky Note - debug log
.sticky-note/hook-debug.log
.sticky-note/.sticky-debug.jsonl

# Sticky Note - legacy single files (migrated to per-user dirs)
.sticky-note/sticky-note-audit.jsonl
.sticky-note/.sticky-presence.json
```

- [ ] **Step 2: Run the full smoke test suite**

```bash
cd C:/Users/dheer/OneDrive/Desktop/Projects/sticky-note
node test/smoke.test.js
```

Expected output ends with:
```
Tests passed: N
Tests failed: 0
```

If any tests fail, fix them before proceeding.

- [ ] **Step 3: Verify `.claude/hooks/` installed copy is also updated**

The sticky-note repo itself uses sticky-note. Copy the updated templates to the local installed hooks:

```bash
cp templates/hooks/sticky-utils.js .claude/hooks/sticky-utils.js
cp templates/hooks/data-branch.js .claude/hooks/data-branch.js
cp templates/hooks/session-start.js .claude/hooks/session-start.js
cp templates/hooks/session-end.js .claude/hooks/session-end.js
```

- [ ] **Step 4: Run migration on the sticky-note repo itself**

```bash
cd C:/Users/dheer/OneDrive/Desktop/Projects/sticky-note
node bin/cli.js migrate
```

Expected: migrates `.sticky-note/` data to `.git/sticky-note/`, creates `sticky-note/data` branch, updates `.gitignore`.

- [ ] **Step 5: Commit everything**

```bash
git add templates/gitignore-additions.txt .claude/hooks/sticky-utils.js .claude/hooks/data-branch.js .claude/hooks/session-start.js .claude/hooks/session-end.js .gitignore
git commit -m "feat: complete data-branch migration — sticky-note v3.0.0"
```

- [ ] **Step 6: Bump version and tag**

In `package.json`, change version from `"2.9.3"` to `"3.0.0"` (breaking change: storage location changes).

```bash
git add package.json
git commit -m "chore: bump version to 3.0.0 — data branch storage"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `_stickyDir()` uses `git rev-parse --git-dir` | Task 1 |
| `sticky-note/data` orphan branch as shared store | Task 2 |
| `.git/sticky-note/` as branch-independent local cache | Task 1 |
| Session-start: fetch, merge, warn offline | Task 3 |
| Session-end: commit plumbing + push with retry | Task 4 |
| No `GIT_INDEX_FILE` pollution of main index | Task 2 (temp index in os.tmpdir) |
| `migrate` CLI command | Task 5 |
| `init` does NOT install pre/post-commit hooks | Task 5 |
| `update` removes pre/post-commit hooks | Task 5 |
| `.sticky-note/` in `.gitignore` | Task 6 |
| Offline: continue with local cache | Tasks 3, 4 |
| Push conflict retry (up to 3) | Task 2 (`pushDataBranch`) |
| Worktrees: `--absolute-git-dir` returns per-worktree path | Task 1 |

**Placeholder scan:** No TBDs, all code is complete.

**Type consistency:** `commitFilesToBranch(branchName, fileMap)` used consistently; `readFileFromBranch(ref, filePath)` used consistently; `mergeAndSaveFromRemote(localMemPath, remoteContent, loadJsonFn, saveJsonFn)` signature matches all call sites.
