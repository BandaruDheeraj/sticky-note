# Design: Dedicated Data Branch for sticky-note Storage

**Date:** 2026-07-17  
**Status:** Approved  

## Problem

Thread data in sticky-note is stored in `.sticky-note/sticky-note.json`, which is committed to each feature branch. This causes two failure classes:

1. **Branch time-travel.** Checking out a branch replaces the working-tree copy of `sticky-note.json` with whatever that branch last committed. On long-lived parallel branches, this can be months out of date. Teams lose each other's threads on every branch switch.

2. **Write-race corruption.** The `.git/hooks/pre-commit` hook auto-stages `.sticky-note/` on every commit. On Windows, `fs.renameSync` can fail if git has the file open (index lock, antivirus), causing the fallback `writeFileSync` to race with the `git add`. The result is a 0-byte file committed and propagated — confirmed in MOBA commit `668039f`, which wiped 79 threads.

The design below eliminates both failure classes.

---

## Design

### Section 1: Data Model & Storage

**Feature branches:** `.sticky-note/` is added to `.gitignore` and never committed to a feature branch again. The pre-commit and post-commit hooks that auto-stage those files are removed entirely.

**Data branch:** A single orphan branch `sticky-note/data` in the same repository holds all sticky-note files:
```
sticky-note.json
audit/<user>.jsonl
presence/<user>.json
merge-driver.js
```
No application code lives on this branch. It only ever receives sticky-note commits.

**Local working copy:** Hooks read and write `.git/sticky-note/` — inside the `.git` directory. This path is branch-independent; no git operation (checkout, switch, pull, merge) touches it. It is the in-session scratch space that feeds into and out of the data branch at sync points.

Data flow:
```
remote sticky-note/data  ←→  .git/sticky-note/  ←→  hooks
                               (local cache)
```
Feature branches never participate in this flow.

---

### Section 2: Sync Protocol

All sync operations are non-blocking. If the network is unavailable, the session continues using the local cache and syncs at the next available opportunity.

**Session start — fetch:**
1. Run `git fetch origin sticky-note/data` (5s timeout).
2. If successful, read the fetched branch's `sticky-note.json` and merge threads into `.git/sticky-note/sticky-note.json` using the existing merge driver.
3. If fetch fails, emit `[STICKY-NOTE] offline — using local thread cache` and continue.

**During session:**
All hook reads and writes go to `.git/sticky-note/`. No git operations are triggered by hook activity.

**Session end — commit and push:**
1. Commit the current state of `.git/sticky-note/` to the local `sticky-note/data` branch using git plumbing (`git hash-object -w` → `git update-index` → `git write-tree` → `git commit-tree` → `git update-ref`). No worktree checkout needed.
2. Push `sticky-note/data` to remote.
3. If push is rejected (concurrent push from a teammate), fetch, merge, and retry — up to 3 attempts. If all retries fail, log a warning; the data is safe locally and will push at the next session end.

**Manual sync:**
`npx sticky-note sync` runs the same commit-and-push sequence as session end. Useful for sharing mid-session progress or recovering after an offline period.

**Fresh clone / new teammate:**
`npx sticky-note init` checks for `refs/sticky-note/data` on the remote. If it exists, fetch and populate `.git/sticky-note/`. If not, create a new orphan branch. New teammates get full thread history on first init.

---

### Section 3: Hook & Code Changes

**`sticky-utils.js` — path resolution:**

`_stickyDir()` changes from walking up two directories (fragile when invoked from a subdirectory) to using `git rev-parse --git-dir` to locate `.git/`, then appending `sticky-note/`:

```js
function _stickyDir() {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return path.resolve(gitDir, 'sticky-note');
  } catch (_) {
    // Fallback: old two-level walk (non-git environments)
    const scriptDir = path.dirname(path.resolve(__filename));
    return path.join(scriptDir, '..', '..', '.sticky-note');
  }
}
```

This also fixes the subdirectory launch bug (where `.claude/hooks/on-stop.js` resolved to a wrong path when Claude Code opened from `backend/`).

**`session-start.js`:**

Gains `fetchDataBranch()` as the first operation, before reading memory. On success, merges remote threads into `.git/sticky-note/sticky-note.json`. On failure, warns and continues.

**`session-end.js`:**

Gains `commitAndPushDataBranch()` as the final operation, after saving memory. Commits `.git/sticky-note/` to `sticky-note/data` and pushes with retry.

**Removed: pre-commit and post-commit git hooks.**

`sticky-note init` and `sticky-note update` no longer install `.git/hooks/pre-commit` or `.git/hooks/post-commit`. `sticky-note update` removes them if present from a prior install. These were the source of the write-race; with data in `.git/sticky-note/`, git never auto-stages sticky-note files.

**`cli.js` — new `migrate` command:**

One-time upgrade for existing projects:
1. Read existing `.sticky-note/sticky-note.json` and related files.
2. Create orphan branch `sticky-note/data` and commit the existing data to it.
3. Add `.sticky-note/` to `.gitignore`.
4. Copy current data to `.git/sticky-note/`.
5. Remove `.git/hooks/pre-commit` and `.git/hooks/post-commit` if sticky-note installed them.
6. Push `sticky-note/data` to remote.

**`cli.js` — updated `init`:**

- Checks remote for `refs/sticky-note/data`; fetches if present instead of creating fresh.
- Does not install pre/post-commit hooks.
- Prints guidance to run `npx sticky-note migrate` if upgrading from an existing install.

**`cli.js` — updated `update`:**

- Updates hook scripts as before.
- Removes `.git/hooks/pre-commit` and `.git/hooks/post-commit` if they contain sticky-note content.

**All other hooks (`inject-context.js`, `pre-tool-use.js`, `track-work.js`, `on-stop.js`, `on-error.js`):**

No changes. They read/write paths returned by `_stickyDir()` and transparently work against `.git/sticky-note/` after the path change.

---

### Section 4: Edge Cases

**Offline / no remote:** Session continues using local cache. On next session-end that has connectivity, the accumulated commits push normally. No data is lost.

**Push conflict (concurrent teammate push):** Fetch the remote, merge using the merge driver (thread-level, field-level merge — existing behavior), push the merged result. Up to 3 retries with exponential backoff.

**Corrupted local cache:** On session start, if `.git/sticky-note/sticky-note.json` is missing or invalid JSON, fetch from `sticky-note/data` branch to restore it. If the data branch is also absent (first run on a fresh clone before init), start with an empty thread list.

**No remote configured:** `fetch` and `push` steps are skipped silently. The data branch exists only locally. Teams working without a shared remote lose the sharing feature but retain all local functionality.

**Teammate on old version (pre-migration):** The data branch does not exist on remote yet. Their `init` creates it fresh. Thread history from before migration lives only in git history on main/feature branches and must be recovered manually via `npx sticky-note migrate`.

**`.git/sticky-note/` on worktrees:** `git rev-parse --git-dir` returns the linked worktree's `.git` file path (e.g., `.git/worktrees/agent-abc/`). The sticky-note local cache would be isolated per worktree. For agent worktrees this is desirable — each agent gets its own scratch space. For the main worktree, `--git-dir` returns `.git/` as expected.

---

## What Does Not Change

- Thread data model (`sticky-note.json` schema, all fields)
- Merge driver (thread-level 3-way merge)
- Scoring and injection logic (`inject-context.js`, `pre-tool-use.js`)
- Audit trail (`audit/<user>.jsonl`)
- Presence (`presence/<user>.json`)
- MCP server
- `resume`, `threads`, `audit`, `who`, `gc`, `reset`, `checkpoint`, `overlap`, `claim` commands
- The `run-hook` command added today

**`switch` and `pull` commands:** These simplify. With `.sticky-note/` gitignored there is nothing to stash or auto-commit, so `switch` becomes a thin wrapper around `git switch` (kept for discoverability and the branch-context warning) and `pull` drops the auto-commit step.

---

## Migration Path for Existing Projects

```bash
# One-time per project (run from project root)
npx sticky-note migrate

# Each teammate runs after pulling the updated .gitignore
npx sticky-note init
```

The `migrate` command is idempotent — safe to run multiple times.
