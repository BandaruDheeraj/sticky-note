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

  const event = hookInput.hook_event_name || "";
  // PascalCase = Claude Code, camelCase = Copilot CLI
  if (event && event[0] === event[0].toUpperCase()) return "claude-code";
  if (event && event[0] === event[0].toLowerCase()) return "copilot-cli";

  return "unknown";
}
```

This three-layer check (explicit flag → env var → event name casing)
means the right runtime gets detected even if one signal is missing.

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
- Thread lifecycle (`closed` vs `open`)
- State cleanup (full cleanup vs preserve across turns)
- Status messaging ("closed" vs "updated")
- Dedup handling (clear per session vs preserve across turns)

Everything else — the attribution engine, git blame pipeline, Git Notes,
thread scoring, resume search — works identically in both tools.

---

## What we'd do differently

The silent protocol mismatch (`output` vs `additionalContext`) wasted
more debugging time than any other issue. No errors, no warnings,
context just vanished. We log every emit call during development now.

The other thing that bit us: assuming "session" means the same thing
everywhere. It doesn't. If we were starting over, we'd design for
per-turn semantics first and treat per-session as the special case.

The rest is standard cross-platform stuff. Normalize paths at the
boundary. Detect the runtime once and branch only where behavior
actually differs. About 95% of the hook code is shared between both
tools, which feels about right.

One thing that turned out better than expected: the instruction file
fallback. Even when hooks aren't configured at all, the AI reads
`.github/copilot-instructions.md` and self-serves the same
functionality by calling CLI commands directly. We almost didn't build
that, and it's saved us more than once.
