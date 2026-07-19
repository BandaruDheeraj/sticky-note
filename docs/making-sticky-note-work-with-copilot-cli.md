# Making Sticky Note work with Copilot CLI

*We built Sticky Note for Claude Code first. Getting it to work in
Copilot CLI meant dealing with a bunch of runtime differences nobody
warns you about.*

---

## Where we started

Sticky Note was born as a Claude Code project. Claude Code has a rich hook
system: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`. You drop JavaScript files into `.claude/hooks/`, wire them
up in `settings.json`, and they fire automatically at the right moments.

The hooks read stdin for context (tool inputs, transcripts, session IDs),
write JSON to stdout to inject context back into the conversation, and
that's it.

Then we wanted Sticky Note to work in Copilot CLI too.

---

## ⚠️ Copilot CLI hook limitations

Before getting into solutions, here are the specific limitations we hit.
Copilot CLI's hook system is newer than Claude Code's, and several gaps
forced us into workarounds:

1. **Per-turn lifecycle, not per-session.** Copilot CLI fires
   `sessionStart` and `sessionEnd` on *every user prompt*, not once per
   conversation. There is no concept of a persistent session boundary.
   This means any state management that assumes "start once, end once"
   breaks immediately — threads get prematurely closed, dedup tracking
   gets wiped, and transient files get cleaned up mid-conversation.

   *How Claude Code does it:* `SessionStart` fires once when you open a
   session. `SessionEnd` fires once when you close it (or it times out).
   A session can span dozens of prompts and hundreds of tool calls, and
   the hooks only fire at the bookends. This makes state management
   straightforward — initialize on start, finalize on end.

2. **Different output protocol with no shared spec.** Copilot CLI
   expects `{ "additionalContext": "..." }` on stdout to inject context.
   There's no shared protocol or content negotiation — and critically,
   **sending the wrong key produces no error**. Your hook runs, writes
   to stdout, exits successfully, and the context silently vanishes.
   This is the most dangerous kind of incompatibility because nothing
   tells you it's broken.

   *How Claude Code does it:* Hooks write `{ "output": "..." }` to
   stdout to inject context into the conversation. The key name is
   documented, and while the failure mode is similarly silent, Claude
   Code's hook ecosystem is more established so the protocol is less
   likely to surprise you.

3. **No transcript access.** Copilot CLI does not provide hooks with
   access to the conversation history. Hooks that need to analyze what
   happened during a session (extracting narratives, detecting failed
   approaches, summarizing work) have to reconstruct context from the
   audit trail instead of reading it directly.

   *How Claude Code does it:* The hook input includes a
   `transcript_path` pointing to a JSONL file containing the full
   conversation — every user prompt, assistant response, tool call, and
   tool result. Our `session-end.js` hook reads this transcript to
   extract narratives, detect error patterns, identify failed approaches,
   and build a rich thread summary. It's the single most useful piece of
   data for understanding what happened in a session.

4. **No native session identity.** Copilot CLI's per-turn model means
   session IDs may or may not persist between turns depending on the
   implementation. We had to add our own session ID persistence layer
   (a `.sticky-session` file) to maintain continuity across turns in
   the same conversation.

   *How Claude Code does it:* A stable `session_id` is provided in the
   hook input payload and remains consistent across all hook invocations
   within a session. Hooks can use it directly without any persistence
   layer — `SessionStart` gets the same ID as `SessionEnd`, and every
   `PreToolUse` and `PostToolUse` in between.

5. **Hook config lives in a different location and format.** Copilot CLI
   uses `.github/hooks/hooks.json`. There's no hook config inheritance or
   shared format, so you maintain two config files pointing at the same
   scripts.

   *How Claude Code does it:* Hook configuration lives in
   `.claude/settings.json` in the project root, alongside the hook
   scripts in `.claude/hooks/`. Config and scripts are co-located, and
   the settings file supports matchers (tool name, file pattern) to
   selectively fire hooks — a feature Copilot CLI's config doesn't
   currently offer.

6. **Cross-platform command differences.** Copilot CLI runs on Windows
   natively (PowerShell), whereas Claude Code primarily targets
   Unix-like environments. Every hook command needs both a `bash` and
   `powershell` variant, including different syntax for setting
   environment variables (`VAR=1 cmd` vs `$env:VAR='1'; cmd`).

   *How Claude Code does it:* Hooks are specified as a single `command`
   string that runs in the system shell. Since Claude Code runs
   primarily on macOS and Linux, you typically only need the bash
   variant. Windows support isn't a primary concern for Claude Code's
   hook system.

7. **Instruction file location differs.** Copilot CLI reads
   `.github/copilot-instructions.md`. Since the instruction file is the
   fallback when hooks aren't running at all, we need to maintain both —
   and the Copilot CLI version includes extra self-serve guidance that
   assumes hooks may not be present.

   *How Claude Code does it:* Instructions live in `CLAUDE.md` at the
   repo root. Claude Code reads this file automatically at session start,
   and because Claude Code's hooks are reliable and well-established,
   the instructions can focus on conventions and guidelines rather than
   including fallback "do this manually if hooks aren't working" sections.

 8. **Hook output is invisible to users.** This is the one that bit us
    hardest. Both runtimes let hooks inject context into the AI's working
    memory via stdout (`additionalContext` or `output`). But that context
    goes to the *model*, not the *user*. The AI decides whether to surface
    it. For background context (thread data, attribution), that's fine —
    the AI uses it silently. For urgent warnings (someone else is editing
    your files), it's a problem. The AI routinely absorbs the warning and
    says nothing.

    We tried stronger language in the injected text ("TELL THE USER
    IMMEDIATELY"), prescribed exact banner formats, and added instructions
    to `copilot-instructions.md`. None of it was reliable — the model
    sometimes complied, sometimes didn't.

    *How Claude Code does it:* Claude Code doesn't have this problem in
    the same way because its model tends to surface injected context more
    reliably. We still hit absorption issues occasionally, but less often.

    The solution we found — using `preToolUse` deny responses as a
    user-visible message channel — is covered in Challenge 8 below.

These aren't bugs. They're what happens when two tools get built
independently with different assumptions. But they mean that
"write a hook once, run it everywhere" is aspirational for now. Every
hook in Sticky Note has Copilot CLI-specific branches to work
around these differences.

---

## Challenge 1: different hook config, same scripts

Claude Code reads hooks from `.claude/settings.json`. Copilot CLI reads
them from `.github/hooks/hooks.json`. Two config files, two formats, but
we didn't want to maintain two sets of hook scripts.

**The solution:** One set of hook scripts lives in `.claude/hooks/`. The
Copilot CLI config in `.github/hooks/hooks.json` points at the *same*
scripts, but passes a `--copilot-cli` flag and sets a `COPILOT_CLI=1`
environment variable:

```json
{
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "bash": "COPILOT_CLI=1 node .claude/hooks/session-start.js --copilot-cli",
        "powershell": "$env:COPILOT_CLI='1'; node .claude/hooks/session-start.js --copilot-cli"
      }
    ]
  }
}
```

Every hook script checks for this flag early and branches behavior where
needed:

```javascript
function _isCopilotCli() {
  return process.argv.includes("--copilot-cli") || !!process.env.COPILOT_CLI;
}
```

This meant we could keep a single codebase for all hooks while handling
the runtime differences with simple conditionals.

---

## Challenge 2: different event names

Claude Code and Copilot CLI use different naming conventions for the same
lifecycle events:

| Lifecycle Event          | Claude Code         | Copilot CLI            |
|--------------------------|---------------------|------------------------|
| Session starts           | `SessionStart`      | `sessionStart`         |
| Session ends             | `SessionEnd`        | `sessionEnd`           |
| User submits prompt      | `UserPromptSubmit`  | `userPromptSubmitted`  |
| Before tool executes     | `PreToolUse`        | `preToolUse`           |
| After tool executes      | `PostToolUse`       | `postToolUse`          |
| Error occurs             | `PostToolUseFailure`| `errorOccurred`        |

Claude Code uses PascalCase. Copilot CLI uses camelCase. The hook input
payload includes a `hook_event_name` field, so we use the casing to
auto-detect which runtime we're in:

```javascript
function detectTool(hookInput) {
  if (process.argv.includes("--copilot-cli")) return "copilot-cli";
  if (process.env.COPILOT_CLI) return "copilot-cli";

  if (hookInput) {
    const event = hookInput.hook_event_name || "";
    // PascalCase = Claude Code, camelCase = Copilot CLI
    if (event && event[0] === event[0].toUpperCase()
             && event[0] !== event[0].toLowerCase()) return "claude-code";
    if (event && event[0] === event[0].toLowerCase()
             && event[0] !== event[0].toUpperCase()) return "copilot-cli";
    // Only Claude Code provides transcript access
    if ("transcript_path" in hookInput) return "claude-code";
  }

  return "unknown";
}
```

This four-layer check (explicit flag → env var → event name casing →
transcript presence) means the right runtime gets detected even if one
signal is missing. The extra `!== toLowerCase()`/`!== toUpperCase()`
guards prevent false positives on digits or symbols in the event name.

---

## Challenge 3: different output protocols

This was the subtlest difference. Both runtimes read JSON from stdout to
inject context into the conversation, but they expect **different keys**:

- **Claude Code** expects `{ "output": "text to inject" }`
- **Copilot CLI** expects `{ "additionalContext": "text to inject" }`

If you send `output` to Copilot CLI, it silently ignores it. If you send
`additionalContext` to Claude Code, same thing. No error, just silence —
your context injection simply doesn't work.

Every hook that injects context uses a wrapper:

```javascript
function _emit(text) {
  if (_isCopilotCli()) {
    process.stdout.write(JSON.stringify({ additionalContext: text }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ output: text }) + "\n");
  }
}
```

This was one of those bugs that took forever to find because there was
no error. Things just silently didn't work until we checked the protocol
difference.

---

## Challenge 4: per-turn vs per-session lifecycle

This is the big one.

In **Claude Code**, `SessionStart` fires once when you open a session and
`SessionEnd` fires once when you close it. A session is a long-lived
conversation — you might have 50 tool calls across 20 prompts, and the
hooks fire at the bookends.

In **Copilot CLI**, `sessionStart` and `sessionEnd` fire **on every
turn**. Each user prompt is its own mini-session. This difference
breaks a bunch of assumptions:

### Thread status: open vs closed

In Claude Code, `session-end.js` closes the thread because the session
is truly over. In Copilot CLI, closing the thread on every turn would
mean it flips between open and closed dozens of times in a conversation.

**Fix:** Copilot CLI threads stay `"open"`:

```javascript
status: isCopilotCli ? "open" : "closed",
closed_at: isCopilotCli ? null : now,
```

### Dedup state

`session-start.js` clears the injection dedup set
(`.sticky-injected`) at the start of each session so threads can be
re-injected next time. But in Copilot CLI, "session start" fires every
turn, so clearing the dedup set would re-inject the same threads on
every single prompt.

**Fix:** Skip the clear for Copilot CLI:

```javascript
// Copilot CLI fires SessionStart per-turn; clearing would lose dedup state.
if (!isCopilotCli) {
  clearInjectedSet();
  clearActiveResumeThreadId();
}
```

### Transient file cleanup

At session end, Claude Code cleans up transient files (`.sticky-session`,
`.sticky-head`, `.sticky-injected`, presence data). In Copilot CLI, doing
this after every turn would destroy state that the next turn needs.

**Fix:** Skip cleanup for Copilot CLI:

```javascript
// Copilot CLI fires per-turn; clearing would break state across turns.
if (!isCopilotCli) {
  clearPresence(user);
  clearSessionFile();
  clearHeadFile();
  clearInjectedSet();
}
```

### Status messages

Even the human-facing output adapts:

```javascript
const statusLabel = isCopilotCli ? "updated" : "closed";
const statusMsg = `[STICKY-NOTE] Session ${statusLabel} - thread ${
  isCopilotCli ? "updated" : "created"
}`;
```

A Claude Code user sees "Session closed — thread created." A Copilot CLI
user sees "Session updated — thread updated." Same hook, different
wording that matches the actual lifecycle.

---

## Challenge 5: cross-platform commands

Copilot CLI runs on Windows, macOS, and Linux. Claude Code primarily
targets macOS and Linux. The hooks need to work everywhere.

The `hooks.json` config includes **both bash and PowerShell** variants
for every hook:

```json
{
  "bash": "COPILOT_CLI=1 node .claude/hooks/session-start.js --copilot-cli",
  "powershell": "$env:COPILOT_CLI='1'; node .claude/hooks/session-start.js --copilot-cli"
}
```

Setting environment variables works differently (`VAR=1 command` in bash
vs `$env:VAR='1'; command` in PowerShell), so both forms are provided.
The runtime picks the right one for the OS.

Inside the hooks themselves, all path handling uses `path.join()` and a
`normalizeSep()` helper that converts backslashes to forward slashes for
consistent storage:

```javascript
function normalizeSep(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/") : p;
}
```

This ensures that file paths recorded on Windows can be matched against
file paths recorded on macOS, and vice versa.

---

## Challenge 6: the instruction file split

Claude Code reads AI instructions from `CLAUDE.md` at the repo root.
Copilot CLI reads from `.github/copilot-instructions.md`. Same purpose,
different locations, different audiences.

We maintain both, but with a difference: the Copilot CLI instructions
include a **self-serve fallback** that Claude Code doesn't need.

Since Copilot CLI's hook support was initially limited (and some
deployments may not run hooks at all), the instructions tell the AI to
self-serve context directly:

```markdown
### Proactive context injection (V2.5)

Copilot CLI does not have lifecycle hooks, so **you must self-serve context**.

#### 1. At session start, check for stuck/open threads
Before doing any work, read `.sticky-note/sticky-note.json`...

#### 2. Before editing a file, check for prior thread context
The first time you edit or read a file in a session, run:
  npx sticky-note get-line-attribution --file <path>
```

This means Sticky Note works in Copilot CLI even when hooks aren't
configured. The AI reads the instructions and calls the CLI commands
itself. Hooks just make it automatic.

---

## Challenge 7: cross-tool thread continuity

A thread started in Claude Code should be resumable in Copilot CLI, and
vice versa. This required:

1. **Tool-agnostic thread format:** Every thread records a `tool` field
   (`"claude-code"` or `"copilot-cli"`), but the thread structure itself
   is identical. No tool-specific fields.

2. **Session ID compatibility:** Both tools generate UUIDs for session
   IDs. The `session-start.js` hook normalizes this — if the runtime
   doesn't provide a session ID, the hook generates one:

   ```javascript
   if (sessionId === "unknown") {
     sessionId = crypto.randomUUID();
   }
   saveSessionId(sessionId);
   ```

3. **Prompts stored for cross-tool resume:** Each thread stores the
   user's prompts (up to 20, truncated to 300 chars). When resuming a
   thread in a different tool, the prompts provide enough context to
   understand what happened:

   ```json
   {
     "prompts": [
       "fix the auth token refresh race condition",
       "that didn't work, try using a mutex instead",
       "run the tests again"
     ]
   }
   ```

4. **Smart resume works across tools:** The `resume-thread` command
   searches by text similarity against narratives and prompts — it
   doesn't filter by tool. "Pick up where the last session left off"
   works whether that session was Claude Code or Copilot CLI.

---

## Challenge 8: getting messages to the user

This one took us twelve releases to solve.

### The problem

Overlap detection landed in v2.6.0: when you start working and someone
else has an open thread touching the same files, you should know about
it. The detection logic was straightforward. Getting the warning in
front of the user was not.

Hook output (`additionalContext` in Copilot CLI) goes to the AI model's
context window. The model *sees* it, but it doesn't necessarily *show*
it. For thread context and attribution data, that's the right behavior —
the AI should absorb it silently and use it when relevant. But for
"hey, Alice is actively editing the same files you're about to touch,"
silent absorption defeats the purpose.

### What we tried (and what failed)

**Attempt 1: sessionStart output.** Put the overlap warning in
`session-start.js` output. Copilot CLI silently dropped it. Turns out
`sessionStart` hook output isn't reliably surfaced at all.

**Attempt 2: userPromptSubmitted output.** Moved the warning into
`inject-context.js` so it arrives with every prompt. The AI received it
but treated it as background context. No mention to the user.

**Attempt 3: stronger language.** Added directives like "TELL THE USER
IMMEDIATELY" and "You MUST surface this warning" to the injected text.
Sometimes the AI complied. Sometimes it didn't. Not reliable enough for
a safety-critical warning.

**Attempt 4: exact banner format.** Prescribed the exact text the AI
should display, down to the emoji and formatting. Added matching rules
to both `CLAUDE.md` and `copilot-instructions.md`. Better compliance
rate, but still not guaranteed.

**Attempt 5: stderr.** Wrote a concise banner directly to `stderr` so
it appears in the user's terminal regardless of what the AI does:

```javascript
process.stderr.write("\n⚠️  OVERLAP DETECTED — someone else is touching your files:\n");
process.stderr.write(`   [STUCK] alice: src/auth.ts — token refresh race condition\n`);
```

This works for humans reading the terminal, but AI assistants don't
relay stderr content. So the user sees a raw banner scrolling past in
the hook output, potentially before the AI has even started responding.
Better than nothing, but not great.

### What actually works: preToolUse deny

The breakthrough was realizing that Copilot CLI's `preToolUse` hook can
return a **deny response**:

```javascript
return {
  permissionDecision: "deny",
  permissionDecisionReason: "⚠️ Overlap detected: alice is working on src/auth.ts..."
};
```

When a tool call is denied, the AI *has* to tell the user about it —
it needs to explain why the action failed. This is the one output
channel where the model can't silently absorb the message, because the
tool call didn't succeed and the user needs to know why.

The pattern: on the first tool call of a session, if file overlaps
exist, deny it with the warning as the reason. Copilot CLI auto-retries
the tool call. On retry, the overlap check passes (already warned), and
the tool proceeds normally. The user sees the warning, the work
continues, and the deny is invisible except for a brief pause.

```javascript
function _checkOverlapsAndDeny() {
  if (!_isCopilotCli()) return null;
  if (isOverlapWarned()) return null;

  // ... detect file overlaps with other users' open threads ...

  if (warnings.length === 0) return null;

  markOverlapWarned();

  return {
    permissionDecision: "deny",
    permissionDecisionReason: formatOverlapWarning(warnings),
  };
}
```

### The dedup problem

One deny per session. Sounds simple. It wasn't.

Copilot CLI sessions share the filesystem. The `.sticky-session` file
that tracks session identity gets reused across concurrent sessions on
the same machine. So "already warned for this session" leaked between
sessions: warn Session A, Session B thinks it was already warned, skips
the warning entirely.

We tried several approaches:

**TTL-based dedup (v2.6.9):** If the warning was shown more than 60
seconds ago, reset and re-warn. The idea was that a retry comes within
seconds (so it passes), but a new session would be more than 60 seconds
later. Broke because long-running sessions would get re-denied every 60
seconds.

**Signal file (v2.6.10):** `inject-context.js` writes an
`.overlap-pending` file when overlaps are detected. `pre-tool-use.js`
reads and deletes it atomically on the first tool call. No shared state,
no TTL. Broke because the signal file was shared across concurrent
sessions — Session A's pending file got consumed by Session B.

**PID-keyed dedup (v2.6.11):** The fix that stuck. Copilot CLI sets a
`COPILOT_LOADER_PID` environment variable that's unique per session and
inherited by hook child processes. The warned state is stored as a JSON
object keyed by PID:

```javascript
// .sticky-note/.overlap-warned
{
  "12345": { "warned_at": "2026-03-14T..." },
  "67890": { "warned_at": "2026-03-14T..." }
}
```

Each session gets its own deny state. A 1-hour TTL cleans up stale
entries from dead sessions. No cross-session interference.

### Auto-closing orphaned threads

The per-turn lifecycle creates another problem: Copilot CLI threads
never close. There's no reliable session-end signal, so threads stay
`"open"` indefinitely. This pollutes overlap detection — a thread from
yesterday looks active today.

The fix: `session-start.js` now runs `autoCloseCopilotCliThreads()`,
which closes any `copilot-cli` thread that's been inactive for longer
than a configurable threshold (default 24 hours):

```javascript
if (thread.tool === "copilot-cli" && thread.status === "open") {
  const hoursInactive = (now - lastActivity) / (1000 * 60 * 60);
  if (hoursInactive >= autoCloseHours) {
    thread.status = "closed";
  }
}
```

Configurable via `copilot_cli_auto_close_hours` in
`sticky-note-config.json`.

### The final architecture

Overlap warnings now use a three-channel approach:

1. **`additionalContext`** (inject-context.js) — full formatted warning
   with CRITICAL INSTRUCTION directive. The AI *might* surface it.
2. **stderr** (inject-context.js) — concise terminal banner. The user
   *will* see it scroll past in hook output.
3. **preToolUse deny** (pre-tool-use.js) — blocks the first tool call
   with the warning as the deny reason. The AI *must* report it.

Channels 1 and 2 fire on every prompt where overlaps exist. Channel 3
fires once per session (PID-keyed). Together they guarantee the user
sees the warning through at least one path.

---

## The result

The full hook mapping, both tools running the same scripts:

| Hook Script          | Claude Code Event     | Copilot CLI Event     |
|----------------------|-----------------------|-----------------------|
| `session-start.js`   | SessionStart          | sessionStart          |
| `session-end.js`     | SessionEnd            | sessionEnd            |
| `inject-context.js`  | UserPromptSubmit      | userPromptSubmitted   |
| `pre-tool-use.js`    | PreToolUse            | preToolUse            |
| `track-work.js`      | PostToolUse           | postToolUse           |
| `on-error.js`        | PostToolUseFailure    | errorOccurred         |

Six hooks, one codebase, two runtimes. The `--copilot-cli` flag and
`COPILOT_CLI` env var flow through every hook, triggering the behavioral
differences where the two runtimes diverge:

- Output protocol (`output` vs `additionalContext`)
- Thread lifecycle (`closed` vs `open`, with auto-close for stale threads)
- State cleanup (full cleanup vs preserve across turns)
- Status messaging ("closed" vs "updated")
- Dedup handling (clear per session vs PID-keyed persistence)
- User-facing warnings (injected context vs preToolUse deny + stderr)
- Thread garbage collection (manual gc vs auto-close after 24h inactivity)

Everything else — the attribution engine, git blame pipeline, Git Notes,
thread scoring, resume search — works identically in both tools.

---

## What we'd do differently

The biggest lesson: **hook output is not user output.** We spent twelve
releases learning that injected context goes to the model, not the
user, and the model decides what to surface. If you need guaranteed
user visibility from a hook, the only reliable mechanism in Copilot CLI
is a `preToolUse` deny. We'd design around that constraint from day one
instead of discovering it through trial and error.

The silent protocol mismatch (`output` vs `additionalContext`) wasted
more debugging time than any other single issue. No errors, no warnings,
context just vanished. We log every emit call during development now.

Assuming "session" means the same thing everywhere was wrong. Copilot
CLI's per-turn model means session IDs, dedup state, and cleanup logic
all need different semantics. If we were starting over, we'd design for
per-turn first and treat per-session as the special case.

Concurrent sessions sharing filesystem state was a recurring headache.
The `COPILOT_LOADER_PID` discovery solved the dedup problem, but we
could have avoided three intermediate releases if we'd looked for a
per-session environment variable sooner.

The instruction file fallback turned out better than expected. Even when
hooks aren't configured at all, the AI reads
`.github/copilot-instructions.md` and self-serves the same
functionality by calling CLI commands directly. We almost didn't build
that, and it's saved us more than once.
