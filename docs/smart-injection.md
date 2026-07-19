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
├─ OVERLAP CHECK (inject-context.js, every prompt)
│  │
│  ├─ Detect file overlaps with other users' open/stuck threads
│  ├─ Format warning → inject via additionalContext + stderr
│  └─ On first tool call (Copilot CLI only) → preToolUse deny with warning
│
└─ Tool call fires (pre-tool-use.js)
   │
   ├─ Overlap deny pending?             → deny with warning, mark warned
   ├─ File in injected_this_session?    → skip
   ├─ No blame data for file?           → skip
   ├─ No thread for SHA?               → skip
   └─ Thread found → inject with line ranges, mark as injected

UserPromptSubmit fires (inject-context.js)
│
├─ Overlap detection → prepend warning if overlaps found
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

The set is cleared at session start. For Copilot CLI (where `sessionStart`
fires per-turn), the set is preserved across turns to avoid re-injection.

Overlap deny dedup is separate: tracked via `.sticky-note/.overlap-warned`,
keyed by `COPILOT_LOADER_PID` so concurrent sessions don't interfere.
See [Making Sticky Note work with Copilot CLI](./making-sticky-note-work-with-copilot-cli.md#challenge-8-getting-messages-to-the-user)
for the full story.

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

## Overlap detection (V2.6)

V2.6 added a third injection trigger: **file overlap warnings**. When
you start working and another user has an open or stuck thread touching
the same files, you get warned before you start editing.

### How overlaps are detected

On every prompt, `inject-context.js` compares your recently modified
files (from `git diff HEAD~5`, unstaged, and staged changes) against
the `files_touched` lists of other users' open/stuck threads. Any
intersection triggers a warning.

### Three-channel delivery

Getting overlap warnings in front of the user turned out to be harder
than detecting them. The AI model often silently absorbs injected
context without relaying it. We ended up with three channels:

1. **`additionalContext`** — formatted markdown warning injected via
   `inject-context.js` on every prompt. The AI *might* surface it.
2. **stderr** — concise banner written directly to the terminal. The
   user sees it scroll past in hook output regardless of AI behavior.
3. **preToolUse deny** (Copilot CLI only) — the first tool call of
   a session is denied with the overlap warning as the reason. The AI
   *must* report why the tool call failed, guaranteeing visibility.

The deny channel fires once per session, keyed by
`COPILOT_LOADER_PID` to isolate concurrent sessions.

### Auto-closing stale Copilot CLI threads

Copilot CLI has no reliable session-end signal, so threads stay `"open"`
indefinitely. To prevent stale threads from triggering false overlap
warnings, `session-start.js` auto-closes any `copilot-cli` thread
inactive for longer than `copilot_cli_auto_close_hours` (default: 24).

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
  "stale_days": 14,
  "copilot_cli_auto_close_hours": 24
}
```

Diagnostic: `npx sticky-note status` (shows attribution engine health)
