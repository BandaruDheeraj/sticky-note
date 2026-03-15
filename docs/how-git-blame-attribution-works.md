# How git blame powers Sticky Note's attribution engine

*Sticky Note uses `git blame`, Git Notes, and a three-tier fallback
pipeline to figure out which AI session wrote which lines of code.
Here's how the whole thing works.*

---

## The problem

You're an AI coding assistant. A developer asks you to edit
`src/auth/refresh.ts`. You open the file and see 200 lines of code. What
you don't know is that Alice spent three hours last week rewriting lines
45–80 to fix a token refresh race condition — and she left a stuck thread
because the fix broke integration tests.

Without context, you might blunder into those same lines and repeat her
mistakes. With context, you'd know exactly what she tried, what failed,
and what's left to do.

That's what Sticky Note's attribution engine is for.

---

## The core idea

Every time an AI assistant edits a file, Sticky Note records metadata
about the session on the resulting commit. Later, when *any* assistant
touches that file, Sticky Note runs `git blame` to discover which commits
produced which lines, resolves those commits back to sessions and threads,
and injects the relevant context *before the tool executes*.

The result: your AI knows Alice worked on lines 45–80, what she was doing,
and what went wrong — before it reads a single line of the file.

---

## How it works

### Recording attribution (the write path)

When an AI session makes edits and the work gets committed, Sticky Note's
`session-end.js` hook writes attribution data to the commit using
**Git Notes**:

```bash
git notes --ref refs/notes/sticky-note add -f -m '<json>' <commit-sha>
```

The JSON payload looks like this:

```json
[
  {
    "session_id": "062383e7-6223-490a-95d2-839e075752d1",
    "user": "alice",
    "file": "src/auth/refresh.ts",
    "type": "ai_edit",
    "ts": "2026-03-08T21:15:52.373Z",
    "lines_changed": ["45-80"],
    "checkpoint": "fixing token refresh race condition"
  }
]
```

This metadata lives in a separate Git ref (`refs/notes/sticky-note`).
It doesn't modify the commit SHA, doesn't pollute the commit message,
and won't show up in `git log` unless you ask for it.

As a backup, the same session info is also written to the **audit JSONL**
file (`.sticky-note/audit/<user>.jsonl`), which provides a second
resolution path.

### Reading attribution (the read path)

When a tool call fires — Read, Edit, Write, Bash — the `pre-tool-use.js`
hook intercepts it and extracts the target file path. Then the attribution
engine kicks in:

```
Tool call: Read("src/auth/refresh.ts")
    │
    ▼
pre-tool-use.js intercepts
    │
    ▼
git blame --line-porcelain src/auth/refresh.ts
    │
    ▼
Parse output → { line 45: sha abc123, line 46: sha abc123, ... }
    │
    ▼
For each unique SHA → three-tier resolution
    │
    ▼
SHA → session_id → thread → inject context
```

### Three-tier SHA resolution

This is where it gets interesting. A commit SHA alone doesn't tell you
which Sticky Note session produced it. The attribution engine resolves
SHAs to sessions using three fallback tiers:

#### Tier 1: Git Notes (fast and reliable)

```bash
git notes --ref refs/notes/sticky-note show <sha>
```

If the commit has a sticky-note Git Note, the session ID is right there
in the JSON. This is the happy path: fast, precise, and it **survives
rebases** (when `notes.rewriteRef` is configured).

#### Tier 2: Audit JSONL (fast, fragile to history rewrites)

Search `.sticky-note/audit/*.jsonl` for entries where `commit_sha` or
`commit_shas[]` matches the blame SHA. This works well for linear
history but breaks when commits are rebased or amended (the SHAs change
but the audit entries still reference the old ones).

#### Tier 3: file + date heuristic (slow, but always works)

When a SHA has no notes and no audit match (common after squash merges),
the engine falls back to a heuristic:

1. Get the commit's author date
2. Extract the commit message and scan for referenced SHAs (7–40 hex
   chars). Many squash merges include the original commit SHAs in the
   message body. If found, retry Tier 1 and 2 on those SHAs first.
3. Last resort: find threads whose `files_touched[]` includes the file
   and whose activity window overlaps the commit date. The window is
   asymmetric: thread start minus 1 hour to thread end plus 24 hours,
   biased toward catching work that preceded the commit.

This tier is slower (requires `git log` calls) but catches cases the
other tiers miss.

```
┌─────────────────────────────────────────────┐
│          Three-Tier Resolution              │
│                                             │
│  SHA ──→ Tier 1: Git Notes                  │
│          Found? ──→ return session_id ✓     │
│          Not found? ↓                       │
│                                             │
│          Tier 2: Audit JSONL                │
│          Found? ──→ return session_id ✓     │
│          Not found? ↓                       │
│                                             │
│          Tier 3: Heuristic                  │
│          Check squash SHAs in commit msg    │
│          Check file + date window overlap   │
│          Found? ──→ return session_id ✓     │
│          Not found? ──→ unattributed line   │
└─────────────────────────────────────────────┘
```

### Thread lookup and injection

Once we have a session ID, the engine looks up the corresponding thread
in `sticky-note.json` (matching on `session_id`, `id`, or
`related_session_ids`). The thread's full context — narrative, failed
approaches, handoff summary — is formatted and injected as system context
*before the tool executes*:

```
[STICKY-NOTE] [STUCK] alice's thread on src/auth/refresh.ts [lines 45-80] (feature/auth):
Rewrote token refresh to use sliding window expiry. Race condition when
two tabs refresh simultaneously — second tab gets 401.
[!] 2 failed approach(es) - check thread be004d60 for details
Handoff: Need to add mutex/lock around the refresh call. See failing test in auth.test.ts:142.
```

The AI assistant now has precise context about what Alice did, what broke,
and what to try next. All before it reads the file.

---

## The two-tier injection model

Not all threads are injected the same way. Sticky Note uses a two-tier
model to balance urgency with token efficiency:

### Eager injection (session start)

Threads with `status: "stuck"` are injected **immediately** when a session
begins, before the developer types anything. If someone hit a wall, the
next person working in the repo needs to know right away.

### Lazy injection (PreToolUse hook)

All other threads are injected **on demand** — only when you touch a file
they authored. This is the git-blame-powered path described above. It's
lazy because it only fires when relevant, keeping the context window clean
for files that have no interesting thread history.

### Deduplication

Each thread is injected **at most once per session**, tracked via
`.sticky-note/.sticky-injected`. Whether a thread came in eagerly at
session start or lazily via a tool call, it won't repeat.

---

## Why Git Notes?

You might wonder: why not just store attribution in commit messages, or
in a database, or in the audit log alone?

Commit messages are immutable. You can't add attribution after the
fact, and nobody wants JSON blobs cluttering their commit history.

A database means external infrastructure. Sticky Note only needs git.

Audit logs alone break on rebase. The SHAs change, but the log entries
still point at the old ones.

Git Notes fix all of these:

- You can add them after a commit already exists
- They live in git itself, no external infrastructure needed
- They survive rebases when you configure `notes.rewriteRef`:

```bash
git config notes.rewriteRef refs/notes/sticky-note
git config notes.rewrite.rebase true
git config notes.rewrite.amend true
```

With this configuration, when you `git rebase` or `git commit --amend`,
Git automatically copies the notes from the old SHAs to the new ones.

Notes are also shared with the team via standard git push/fetch:

```bash
git push origin refs/notes/sticky-note
git fetch origin refs/notes/sticky-note:refs/notes/sticky-note
```

Sticky Note configures these refspecs automatically during `npx sticky-note init`.

---

## Try it yourself

### Check attribution health

```bash
npx sticky-note status
```

Look for the "Attribution Engine (V2.5)" section. It confirms all
components are installed and Git Notes rewrite is configured.

### Query file attribution

```bash
npx sticky-note get-line-attribution --file src/auth/refresh.ts
npx sticky-note get-line-attribution --file bin/cli.js --lines 1:50
```

Returns JSON showing which threads authored which lines, resolved via
which tier.

### List all Git Notes

```bash
git notes --ref sticky-note list
```

Each line shows `<note-blob-sha> <commit-sha>` — every commit that has
sticky-note attribution attached.

### Read a specific note

```bash
git notes --ref sticky-note show <commit-sha>
```

Returns the raw JSON array of attribution entries for that commit.

### Smart resume using attribution

```bash
npx sticky-note resume-thread --query "token refresh race condition"
```

This searches threads by text similarity and boosts results whose
git-blame-attributed files overlap with your query context.

---

## Performance

The attribution engine needs to be fast since it runs in the
PreToolUse hook:

| Operation | Budget | Notes |
|-----------|--------|-------|
| `git blame --line-porcelain` | 10s timeout | Runs once per file per tool call |
| Git Notes lookup per SHA | 3s timeout | Usually <50ms; only unique SHAs checked |
| Audit JSONL scan | No timeout | Fast string `includes()` pre-filter before JSON parse |
| Heuristic fallback | 3s per SHA | Only reached if Tier 1 and 2 miss |
| Total attribution budget | 500ms target | Most files resolve in <200ms via Tier 1 |

The engine short-circuits: as soon as a higher tier resolves a SHA, lower
tiers are skipped. For repos with Git Notes configured (the default after
`npx sticky-note init`), nearly all attribution resolves via Tier 1 with
no fallback needed.

---

## Wrapping up

The basic idea is simple: `git blame` already knows who wrote each line.
Sticky Note adds a layer on top that maps commits back to AI sessions
and threads, so the next assistant to touch the file knows what happened
last time. Three fallback tiers handle the messy cases (rebases, squash
merges, missing notes), and the whole thing runs automatically after
`npx sticky-note init`.
