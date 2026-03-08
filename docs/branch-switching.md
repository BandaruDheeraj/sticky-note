# Sticky Note & Branch Switching: Design Notes

## The Problem

Sticky Note stores session data in `.sticky-note/` — a git-tracked directory
that includes `sticky-note.json`, per-user audit logs (`audit/<user>.jsonl`),
and per-user presence files (`presence/<user>.json`).

These files are **git-tracked by design** so teammates can see each other's
session context, audit trails, and active presence. But this creates a
fundamental tension:

> **Git-tracked files that change on every AI tool call will always have
> uncommitted changes, and `git checkout` refuses to switch branches when
> tracked files have local modifications that would be overwritten.**

### Why This Matters

1. **AI hooks write on every tool call** — `track-work.js` updates presence
   and audit on every tool invocation, so `.sticky-note/` is *always* dirty.
2. **Branch switches are common** — developers and AI assistants frequently
   switch between `main`, feature branches, and hotfix branches.
3. **Losing sticky-note data is bad** — the whole point is to preserve
   context for handoff. Discarding changes defeats the purpose.

### What Happens Without a Solution

```
$ git checkout main
error: Your local changes to the following files would be overwritten by checkout:
        .sticky-note/audit/alice.jsonl
        .sticky-note/presence/alice.json
        .sticky-note/sticky-note.json
Please commit your changes or stash changes before you switch branches.
Aborting.
```

The developer is forced to manually stash or commit before every branch switch.
AI assistants get stuck in a loop trying to checkout and failing.

---

## Design Constraints

1. **No `pre-checkout` hook in Git** — Git only provides `post-checkout`
   (fires *after* a successful checkout). There is no way to intercept a
   checkout *before* it happens via native hooks.

2. **Sticky-note data is branch-independent** — Session metadata, audit
   trails, and presence are about the *repository*, not about the *code on
   a specific branch*. Ideally they would float across branches seamlessly.

3. **Per-user files reduce but don't eliminate conflicts** — Two users won't
   conflict on `audit/alice.jsonl` vs `audit/bob.jsonl`, but the *same user*
   will conflict with their own file if it diverged between branches.

4. **AI assistants need explicit instructions** — They follow the rules in
   `CLAUDE.md` / `copilot-instructions.md`, so any branch-switching protocol
   must be documented there.

5. **Human developers need it to "just work"** — We can't expect humans to
   remember a special command every time they type `git checkout`.

---

## Solution: Three-Layer Defense

We use a layered approach to handle branch switching in all scenarios.

### Layer A: CLI Command (`npx sticky-note switch <branch>`)

A dedicated command that wraps the branch switch with automatic stash/pop:

```bash
npx sticky-note switch feature/v3
```

**What it does:**
1. `git stash push -m "sticky-note-auto" -- .sticky-note/`
2. `git switch <branch>`
3. `git stash pop`
4. On conflict: `git checkout --theirs -- .sticky-note/` (local data wins —
   it's always more recent than what's on the target branch)

**When to use:** Any time you want a guaranteed clean switch.

### Layer B: Git Alias (`git sw`)

During `npx sticky-note init`, we configure a git alias:

```bash
git config alias.sw '!npx sticky-note switch'
```

This gives developers a short, memorable command:

```bash
git sw main
git sw feature/v3
```

**Limitation:** Only works if the developer remembers to use `git sw` instead
of `git checkout` or `git switch`.

### Layer C: AI Assistant Instructions

All instruction templates (`CLAUDE.md`, `copilot-instructions.md`) include:

```markdown
## Branch switching

NEVER use raw `git checkout` or `git switch`.
ALWAYS use: `npx sticky-note switch <branch>`
This auto-stashes .sticky-note/ files before switching and restores after.
```

This ensures AI assistants always use the safe path. Since AI assistants
follow instruction files reliably, this covers the majority of branch
switches in AI-assisted workflows.

---

## What About Raw `git checkout`?

If a human (or a misconfigured AI) runs `git checkout main` directly,
Git will refuse if `.sticky-note/` has uncommitted changes. This is
actually a *safe* failure mode:

- No data is lost (Git aborts the checkout)
- The error message is clear about what to do
- The developer can then run `npx sticky-note switch main`

### Could We Use `core.hooksPath` or Filters?

We explored several alternatives:

| Approach | Why It Doesn't Work |
|----------|-------------------|
| `pre-checkout` hook | Doesn't exist in Git |
| `post-checkout` hook | Fires after success — checkout already failed |
| Git clean/smudge filters | For content transforms, not stash/restore |
| `--skip-worktree` flag | Hides changes from `git status` and `git add`, making it easy to forget to commit. Dangerous for shared data. |
| `--assume-unchanged` | Same problems as skip-worktree |
| `.gitattributes` merge driver | Only applies during `git merge`, not `git checkout` |

**Conclusion:** There is no way to fully automate stash-before-checkout
using native Git mechanisms. The wrapper command approach (Layers A + B)
combined with AI instructions (Layer C) provides the best practical coverage.

---

## Sticky-Note Data: Branch-Independent by Nature

An important conceptual point: sticky-note data describes *who worked on
the repo, when, and what they did*. It's metadata about the development
process, not about the code itself.

This means:
- `sticky-note.json` threads can span multiple branches
- Audit entries from `feature/v2` are still relevant when you're on `main`
- Presence data is about *right now*, not about a specific branch

In an ideal world, `.sticky-note/` would exist outside the branch tree
entirely (like `.git/` does). But then it couldn't be shared via normal
`git push`/`git pull`, which is the whole point.

### Why Not an Orphan Branch?

One option is to store sticky-note data on a dedicated orphan branch
(e.g., `sticky-note-data`). This would:

- ✅ Keep data completely separate from source code branches
- ✅ Eliminate checkout conflicts entirely
- ❌ Require complex multi-branch commit workflows
- ❌ Break the simple mental model of "commit and push your work"
- ❌ Make it invisible in normal `git log` and file browsing
- ❌ Add significant complexity to hooks and CLI

We decided the wrapper-command approach is simpler and more maintainable.

---

## Recommendations for Teams

1. **Always use `npx sticky-note switch` or `git sw`** for branch changes
2. **Commit `.sticky-note/` regularly** — at minimum, at session end
3. **Pull before starting work** to get teammates' latest audit/presence data
4. **If checkout fails**, don't `git checkout --force` — use the switch command
5. **Configure your AI assistant** to use the switch command (this happens
   automatically via the instruction templates installed by `npx sticky-note init`)

---

## Future Considerations

- **File system watchers**: A background process could auto-commit
  `.sticky-note/` changes periodically, reducing the "always dirty" problem
- **Sparse checkout**: Git sparse-checkout could exclude `.sticky-note/`
  from the working tree on branches where you don't need it
- **Git worktrees**: Using `git worktree` instead of branch switching
  sidesteps the problem entirely (each worktree has its own working directory)
- **Pre-checkout hook proposal**: If Git ever adds a `pre-checkout` hook,
  we could auto-stash without wrappers
