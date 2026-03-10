# Thread resume — local mode (V2.5)

Thread resume lets one developer pick up where another left off.
Alice's thread becomes Bob's active thread — one thread, two
contributors, continuous audit trail.

---

## Quick Start

```bash
# Search by topic
npx sticky-note resume-thread --query "auth refresh sliding window"

# Search by user
npx sticky-note resume-thread --user alice

# Combined: topic + user + file context
npx sticky-note resume-thread --query "auth fix" --user alice --file src/auth/refresh.ts

# Natural language (positional query)
npx sticky-note resume-thread "pick up where Alice left off on auth"

# JSON output (for MCP tool integration)
npx sticky-note resume-thread --query "auth" --json
```

---

## How it works

### 1. Thread discovery

`resume-thread` searches all non-expired threads using:

- Text similarity — matches query against narrative, failed_approaches,
  handoff_summary, last_note, and files_touched
- User filter — optional, filters to a specific thread author
- File attribution — boosts threads whose attributed lines (via
  built-in `git blame`) overlap with the specified file

### 2. Match selection

- If one clear winner: selected automatically
- If top 2 scores are within 0.5 of each other: both shown, best selected
- JSON mode returns best_match + alternatives for programmatic use

### 3. Resume activation

When a thread is resumed:

1. `.sticky-resume` signal file is written (for session-start hook)
2. `.sticky-active-resume` marker is written (for session-end hook)
3. Next AI session picks up the thread's full context automatically
4. Session-end appends to the resumed thread (not a new thread)

### 4. Thread update on session end

When Bob's session ends on a resumed thread:

- `contributors[]` is updated: `["alice", "bob"]`
- `resumed_by` is set to `"bob"`
- `resumed_at` is timestamped
- `resume_history[]` gets a new entry
- Files touched, narrative, prompts are merged into Alice's thread

---

## Thread schema additions (V2.5)

All fields are **optional and backward-compatible** — V1/V2 threads work
unchanged.

| Field | Type | Description |
|-------|------|-------------|
| `contributors` | `string[]` | All users who have worked on this thread |
| `resumed_by` | `string` | Most recent user to resume this thread |
| `resumed_at` | `string` | ISO timestamp of most recent resume |
| `resume_history` | `object[]` | Full chain: `{ user, at, session_id }` |

Example thread with resume data:

```json
{
  "id": "9c2a2b01-...",
  "user": "alice",
  "contributors": ["alice", "bob"],
  "resumed_by": "bob",
  "resumed_at": "2026-03-07T14:22:00Z",
  "resume_history": [
    { "user": "bob", "at": "2026-03-07T14:22:00Z", "session_id": "def-456" }
  ],
  "resume_chain": [
    { "session_id": "abc-123", "tool": "claude-code", ... },
    { "session_id": "def-456", "tool": "copilot-cli", ... }
  ]
}
```

---

## Injection vs resume

| | Injection | Resume |
|---|-----------|--------|
| **Context** | Read-only background | Active thread |
| **Thread** | Unchanged | Appended to |
| **Contributors** | Not updated | Updated |
| **New thread created?** | No | No — same thread |
| **Audit trail** | Separate session | Continuous |

---

## Limitation: push required

In V2.5, `resume-thread` reads `sticky-note.json` and audit JSONL
**locally**. If Alice is on a different machine and hasn't pushed, her
threads are not visible to Bob.

**Workaround:** Alice pushes her branch. Bob pulls. Resume works.

**Workaround:** Ensure both developers push/pull regularly so thread
data stays in sync.

---

## What resume is not

- ✗ Not a fork — one thread, multiple contributors
- ✗ Not an assignment — Bob pulls, Alice doesn't push
- ✗ Not a lock — Alice can resume her own thread concurrently
- ✗ Not required — smart injection still works without resume
