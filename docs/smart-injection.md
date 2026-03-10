# Smart injection — two-tier context model (V2.5)

Sticky Note V2.5 replaces V2's "inject top N threads per prompt" with a
smarter two-tier model: **eager** injection for stuck threads at session
start, and **lazy** injection for all other threads when you first touch
a file they authored.

---

## How it works

### Tier 1: eager injection (session start)

Threads with `status: "stuck"` are injected immediately when a session
begins, before you type anything. These represent unresolved blockers
that any developer should know about.

Why eager? Stuck threads are urgent. If Alice hit a wall on the auth
module, Bob needs to know before he starts working, not after he's
already reading the same code.

The cost is minimal. Stuck threads are rare, and their payloads are
compact (narrative + failed_approaches).

### Tier 2: lazy injection (PreToolUse hook)

All non-stuck threads are held in reserve. When a tool call fires (Read,
Edit, Write, Bash), the **PreToolUse hook** runs the built-in attribution
engine on the target file:

1. `git blame --line-porcelain <file>` → maps lines to commit SHAs
2. Three-tier SHA resolution:
   - **Git Notes** (`refs/notes/sticky-note`) → session ID (survives rebase/amend)
   - **Audit JSONL** → `commit_sha` / `commit_shas[]` fields → session ID
   - **File + date heuristic** → thread's `files_touched[]` + time window
3. Session ID lookup in `sticky-note.json` → loads thread with line ranges

If a thread is found and hasn't been injected this session, it's delivered
as a system note **before the tool executes**, including the specific
line ranges the thread authored.

Bob's AI assistant now knows Alice worked on lines 45–80 of
`src/auth/refresh.ts` and what she was doing. All before it reads the file.

---

## Decision tree

```
Session starts
│
├─ EAGER: inject stuck threads → mark as injected
│
└─ Tool call fires
   │
   ├─ File in injected_this_session? → skip
   ├─ No blame data for file?        → skip
   ├─ No thread for SHA?             → skip
   └─ Thread found → inject with line ranges, mark as injected

UserPromptSubmit fires (inject-context.js)
│
└─ Score remaining threads (skip already-injected)
   └─ Inject top N under token budget
```

---

## Deduplication

Each thread is injected **at most once per session**, tracked via
`.sticky-note/.sticky-injected`:

```json
{
  "session_id": "abc-123",
  "thread_ids": ["9c2a2b01", "04ef07db"]
}
```

Three injection points all respect this set:
- **session-start.js** — marks stuck threads as injected
- **pre-tool-use.js** — marks file-attributed threads as injected
- **inject-context.js** — skips threads already in the set

The set is cleared at session start.

---

## Three-tier SHA resolution

The attribution engine uses three fallback tiers to resolve commit SHAs
to sessions, so attribution survives history rewrites:

| Tier | Source | Survives Rebase? | Speed |
|------|--------|-----------------|-------|
| 1 | Git Notes (`refs/notes/sticky-note`) | ✅ Yes (with rewriteRef config) | Fast |
| 2 | Audit JSONL (`commit_sha` fields) | ❌ SHAs become stale | Fast |
| 3 | File + date heuristic | ✅ Always works | Slower |

Run `npx sticky-note update` to configure Git Notes rewrite automatically.

---

## Token budgeting

Eager injection (stuck threads) uses a separate, compact budget — stuck
threads are short by nature (narrative + failed approaches).

Lazy injection has no token budget — it injects only the threads relevant
to the specific file being accessed, which is typically 0–2 threads.

The UserPromptSubmit hook (`inject-context.js`) continues to apply the
configurable `inject_token_budget` (default: 1000 tokens) for any
remaining threads it scores and injects.

---

## Configuration

In `.sticky-note/sticky-note-config.json`:

```json
{
  "inject_token_budget": 1000,
  "stale_days": 14
}
```

Diagnostic: `npx sticky-note status` (shows attribution engine health)
