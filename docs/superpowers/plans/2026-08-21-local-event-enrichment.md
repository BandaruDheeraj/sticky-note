# Local Session Event Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich all local Claude Code hook outputs to capture full-fidelity event data (tool args, tool results, AI thinking, AI responses) into the audit JSONL and push the complete event stream to the Worker at session end for team-wide AI blame.

**Architecture:** A new shared `event-writer.js` utility defines the event schema and provides builder/sanitizer functions. Each hook imports it and writes structured events. At session end, `session-end.js` parses AI thinking and response blocks from the local transcript JSONL and pushes the complete ordered event stream to the Worker's events endpoint (no-op if cloud not configured or endpoint not yet live).

**Tech Stack:** Node.js (CJS), no new dependencies. Tests use Node's built-in `assert`. Run with `node test/smoke.test.js` and `node test/event-writer.test.js`.

## Global Constraints

- All hook files must remain CJS (`require`/`module.exports`) — no ESM
- Every hook must call `process.exit(0)` and never throw to stdout — failures must be silent
- Tool result data capped at 10 KB per event; cap is enforced in `event-writer.js`
- For Edit/Write/MultiEdit args: if `old_string`, `new_string`, or `content` exceeds 1 KB, replace with `{ _hash: sha256hex, _len: N }` — preserve verbatim if ≤ 1 KB
- `appendAuditLineBoth` from `sticky-utils.js` is the only write path for local events
- Cloud push at session end is best-effort — failure must not block `process.exit(0)`
- All template files live in `templates/hooks/`; deployed copies live in `.claude/hooks/` but are NOT edited directly — the plan only modifies template files

---

### Task 1: Create `event-writer.js`

**Files:**
- Create: `templates/hooks/event-writer.js`
- Test: `test/event-writer.test.js`

**Interfaces:**
- Produces:
  - `buildEvent(type, data, sessionId)` → `{ ts, type, session_id, data }`
  - `sanitizeToolArgs(toolName, args)` → sanitized args object (large strings replaced with hash+len)
  - `capResult(result)` → string capped at 10 KB
  - `EVENT_TYPES` → object with string constants for all event type names

- [ ] **Step 1: Write the failing test**

```js
// test/event-writer.test.js
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const { buildEvent, sanitizeToolArgs, capResult, EVENT_TYPES } = require("../templates/hooks/event-writer.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
    passed++;
  } catch (err) {
    console.error("  ✗ " + name + ": " + err.message);
    failed++;
  }
}

// buildEvent
test("buildEvent returns required fields", () => {
  const e = buildEvent("tool_call", { tool: "Read" }, "sess-1");
  assert.strictEqual(e.type, "tool_call");
  assert.strictEqual(e.session_id, "sess-1");
  assert.ok(e.ts, "ts required");
  assert.deepStrictEqual(e.data, { tool: "Read" });
});

test("buildEvent ts is ISO string", () => {
  const e = buildEvent("user_prompt", { content: "hello" }, "s");
  assert.ok(!isNaN(new Date(e.ts).getTime()), "ts must be valid ISO date");
});

// EVENT_TYPES
test("EVENT_TYPES has all required keys", () => {
  const required = [
    "SESSION_OPEN", "USER_PROMPT", "AI_THINKING", "AI_RESPONSE",
    "TOOL_CALL", "TOOL_RESULT", "TOOL_ERROR", "TOOL_DENIED",
    "CONTEXT_COMPRESSED", "GIT_COMMIT", "SUBAGENT_SPAWN", "SUBAGENT_RESULT",
    "CHECKPOINT", "SESSION_CLOSE",
  ];
  for (const key of required) {
    assert.ok(key in EVENT_TYPES, `EVENT_TYPES missing ${key}`);
    assert.strictEqual(typeof EVENT_TYPES[key], "string");
  }
});

// sanitizeToolArgs
test("sanitizeToolArgs passes through non-write tools unchanged", () => {
  const args = { file_path: "src/foo.ts", limit: 100 };
  const result = sanitizeToolArgs("Read", args);
  assert.deepStrictEqual(result, args);
});

test("sanitizeToolArgs keeps short old_string/new_string verbatim", () => {
  const args = { file_path: "f.ts", old_string: "foo", new_string: "bar" };
  const result = sanitizeToolArgs("Edit", args);
  assert.strictEqual(result.old_string, "foo");
  assert.strictEqual(result.new_string, "bar");
});

test("sanitizeToolArgs replaces large old_string with hash+len", () => {
  const big = "x".repeat(1025);
  const args = { file_path: "f.ts", old_string: big, new_string: "bar" };
  const result = sanitizeToolArgs("Edit", args);
  assert.ok(!("old_string" in result), "old_string should be removed");
  assert.ok(result.old_string_ref, "old_string_ref should be added");
  assert.strictEqual(result.old_string_ref._len, 1025);
  assert.ok(result.old_string_ref._hash, "hash required");
});

test("sanitizeToolArgs replaces large content with hash+len for Write", () => {
  const big = "y".repeat(1025);
  const args = { file_path: "f.ts", content: big };
  const result = sanitizeToolArgs("Write", args);
  assert.ok(!("content" in result), "content should be removed");
  assert.ok(result.content_ref, "content_ref should be added");
  assert.strictEqual(result.content_ref._len, 1025);
});

// capResult
test("capResult passes through short strings", () => {
  assert.strictEqual(capResult("hello"), "hello");
});

test("capResult truncates strings over 10KB", () => {
  const big = "z".repeat(11 * 1024);
  const result = capResult(big);
  assert.ok(result.length < big.length, "should be truncated");
  assert.ok(result.includes("[truncated"), "should have truncation marker");
});

test("capResult returns non-strings as-is", () => {
  assert.strictEqual(capResult(null), null);
  assert.deepStrictEqual(capResult({ a: 1 }), { a: 1 });
});

console.log("\nEvent Writer Tests");
// (tests run synchronously via the test() calls above)
if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log(`\n${passed} test(s) passed`);
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/event-writer.test.js
```

Expected: `Cannot find module '../templates/hooks/event-writer.js'`

- [ ] **Step 3: Write `templates/hooks/event-writer.js`**

```js
#!/usr/bin/env node
"use strict";
/**
 * event-writer.js — Shared Event Schema and Builder (V4)
 *
 * Provides event type constants, a builder for structured events,
 * and sanitizers for tool args and results.
 * Imported by track-work.js, on-error.js, inject-context.js,
 * session-start.js, and session-end.js.
 */

const crypto = require("crypto");

const MAX_RESULT_BYTES = 10 * 1024;        // 10 KB cap on tool results
const MAX_ARG_INLINE_BYTES = 1 * 1024;    // 1 KB: keep verbatim below this

const EVENT_TYPES = {
  SESSION_OPEN:         "session_open",
  USER_PROMPT:          "user_prompt",
  AI_THINKING:          "ai_thinking",
  AI_RESPONSE:          "ai_response",
  TOOL_CALL:            "tool_call",
  TOOL_RESULT:          "tool_result",
  TOOL_ERROR:           "tool_error",
  TOOL_DENIED:          "tool_denied",
  CONTEXT_COMPRESSED:   "context_compressed",
  GIT_COMMIT:           "git_commit",
  SUBAGENT_SPAWN:       "subagent_spawn",
  SUBAGENT_RESULT:      "subagent_result",
  CHECKPOINT:           "checkpoint",
  SESSION_CLOSE:        "session_close",
};

const WRITE_TOOLS = new Set([
  "Edit", "edit", "Write", "write", "MultiEdit", "multi_edit",
]);

/**
 * Build a structured event object.
 * @param {string} type - One of EVENT_TYPES values
 * @param {object} data - Event-specific payload
 * @param {string} sessionId - Session ID for correlation
 * @returns {{ ts: string, type: string, session_id: string, data: object }}
 */
function buildEvent(type, data, sessionId) {
  return {
    ts: new Date().toISOString(),
    type,
    session_id: sessionId || null,
    data: data || {},
  };
}

function _sha256hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function _refOf(str) {
  return { _hash: _sha256hex(str), _len: str.length };
}

/**
 * Sanitize tool call args before storing.
 * - Non-write tools: returned unchanged.
 * - Write tools: large string fields (old_string, new_string, content) are
 *   replaced with a { _hash, _len } reference if they exceed MAX_ARG_INLINE_BYTES.
 *   Short strings are kept verbatim.
 */
function sanitizeToolArgs(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (!WRITE_TOOLS.has(toolName)) return args;

  const out = { ...args };

  for (const field of ["old_string", "new_string"]) {
    if (typeof out[field] === "string" &&
        Buffer.byteLength(out[field], "utf-8") > MAX_ARG_INLINE_BYTES) {
      out[field + "_ref"] = _refOf(out[field]);
      delete out[field];
    }
  }

  if (typeof out.content === "string" &&
      Buffer.byteLength(out.content, "utf-8") > MAX_ARG_INLINE_BYTES) {
    out.content_ref = _refOf(out.content);
    delete out.content;
  }

  return out;
}

/**
 * Cap a tool result string to MAX_RESULT_BYTES.
 * Non-string values are returned unchanged.
 */
function capResult(result) {
  if (typeof result !== "string") return result;
  const bytes = Buffer.byteLength(result, "utf-8");
  if (bytes <= MAX_RESULT_BYTES) return result;
  const cutoff = Math.floor(MAX_RESULT_BYTES * 0.95);
  return result.slice(0, cutoff) + `...[truncated, ${bytes} bytes total]`;
}

module.exports = { EVENT_TYPES, buildEvent, sanitizeToolArgs, capResult, MAX_RESULT_BYTES, MAX_ARG_INLINE_BYTES };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/event-writer.test.js
```

Expected: all tests pass, `N test(s) passed`

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/event-writer.js test/event-writer.test.js
git commit -m "feat: add event-writer.js with event schema, sanitizers, and tests"
```

---

### Task 2: Enrich `track-work.js` with full tool_call + tool_result events

**Files:**
- Modify: `templates/hooks/track-work.js`

**Interfaces:**
- Consumes: `buildEvent`, `sanitizeToolArgs`, `capResult`, `EVENT_TYPES` from `event-writer.js`
- Produces: Two new audit JSONL entries per hook fire — `tool_call` and `tool_result` — in addition to the existing `tool_use` entry (kept for backward compat)

**Background:** `hookInput.tool_input` contains full args; `hookInput.tool_response` contains the result. Both are available in PostToolUse hooks. The existing entry type `tool_use` is kept so existing audit queries don't break.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js` inside the `run()` function (after the existing tests):

```js
test("track-work.js writes tool_call and tool_result events", () => {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  const auditDir = path.join(tmpDir, ".sticky-note", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const hookInput = {
    tool_name: "Read",
    tool_input: { file_path: "src/foo.ts", limit: 100 },
    tool_response: { output: "line1\nline2\n" },
    session_id: "sess-tool-call-test",
  };

  execFileSync("node", [path.join(hooksDir, "track-work.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });

  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  assert.ok(auditFile, "audit file should exist");
  const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const toolCall = lines.find(l => l.type === "tool_call");
  const toolResult = lines.find(l => l.type === "tool_result");
  assert.ok(toolCall, "tool_call event should be written");
  assert.ok(toolResult, "tool_result event should be written");
  assert.strictEqual(toolCall.data.tool, "Read");
  assert.deepStrictEqual(toolCall.data.args, { file_path: "src/foo.ts", limit: 100 });
  assert.strictEqual(toolResult.data.result, "line1\nline2\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "tool_call"
```

Expected: `AssertionError: tool_call event should be written`

- [ ] **Step 3: Add event-writer import and enriched writes to `track-work.js`**

After the existing imports at the top of `main()` (after line `const isWriteTool = WRITE_TOOLS.has(toolName);`), add:

```js
// Load event-writer (best-effort — don't break if missing)
let eventWriter = null;
try { eventWriter = require("./event-writer.js"); } catch (_) {}
```

Then replace the `const entry = { ... }; appendAuditLineBoth(entry, cloud);` block (around line 273-289) with:

```js
const now2 = new Date().toISOString();

// Legacy entry — kept for backward compat with existing audit queries
const entry = {
  type: "tool_use",
  user,
  ts: now2,
  tool: toolName,
  session_id: sessionId,
};
if (filePath) entry.file = filePath;
if (lineRanges) entry.lines_changed = lineRanges.map((r) => `${r.start}-${r.end}`);
if (checkpoint) entry.checkpoint_topic = checkpoint.topic;
appendAuditLineBoth(entry, cloud);

// New enriched events for AI blame
if (eventWriter) {
  try {
    const rawArgs = hookInput.tool_input || {};
    const sanitizedArgs = eventWriter.sanitizeToolArgs(toolName, rawArgs);
    const callEvent = eventWriter.buildEvent(
      eventWriter.EVENT_TYPES.TOOL_CALL,
      { tool: toolName, args: sanitizedArgs },
      sessionId
    );
    appendAuditLineBoth(callEvent, cloud);

    // tool_response may be a string or object
    let rawResult = hookInput.tool_response;
    if (rawResult && typeof rawResult === "object" && "output" in rawResult) {
      rawResult = rawResult.output;
    } else if (rawResult && typeof rawResult === "object") {
      rawResult = JSON.stringify(rawResult);
    }
    const cappedResult = eventWriter.capResult(
      typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult)
    );
    const resultData = {
      tool: toolName,
      result: cappedResult,
    };
    if (lineRanges) {
      resultData.lines_changed = lineRanges.map((r) => `${r.start}-${r.end}`);
    }
    const resultEvent = eventWriter.buildEvent(
      eventWriter.EVENT_TYPES.TOOL_RESULT,
      resultData,
      sessionId
    );
    appendAuditLineBoth(resultEvent, cloud);
  } catch (_) {
    // enrichment is best-effort — never break the hook
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | tail -5
```

Expected: test passes (or at minimum the new test passes — check for PASS on the new test name)

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/track-work.js
git commit -m "feat: enrich track-work.js with tool_call + tool_result events for AI blame"
```

---

### Task 3: Add `tool_denied` event to `on-error.js`

**Files:**
- Modify: `templates/hooks/on-error.js`

**Interfaces:**
- Consumes: `buildEvent`, `EVENT_TYPES` from `event-writer.js`
- Produces: `tool_denied` audit event when user rejects permission; existing `error` event still written for actual errors

**Background:** Claude Code's PostToolUseFailure hook fires for both user denials and real errors. A denial is detectable via `hookInput.blocked === true` or error text matching "permission denied", "blocked by user", "user rejected". Write `tool_denied` for denials; keep the existing `error` entry for everything else.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("on-error.js writes tool_denied event for user denial", () => {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  const auditDir = path.join(tmpDir, ".sticky-note", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const hookInput = {
    tool_name: "Bash",
    tool_input: { command: "rm -rf dist/" },
    error: "Tool was blocked by the user",
    blocked: true,
    session_id: "sess-denial-test",
  };

  execFileSync("node", [path.join(hooksDir, "on-error.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });

  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const denial = lines.find(l => l.type === "tool_denied");
  assert.ok(denial, "tool_denied event should be written");
  assert.strictEqual(denial.data.tool, "Bash");
  assert.deepStrictEqual(denial.data.args, { command: "rm -rf dist/" });
  assert.ok(denial.data.reason.includes("blocked"), "reason should describe denial");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep -A3 "tool_denied"
```

Expected: `AssertionError: tool_denied event should be written`

- [ ] **Step 3: Add denial detection and event write to `on-error.js`**

Add import at the top (after the existing utils import block):

```js
let eventWriter = null;
try { eventWriter = require("./event-writer.js"); } catch (_) {}
```

Add a helper function before `main()`:

```js
function _isDenial(hookInput) {
  if (hookInput.blocked === true) return true;
  const msg = (hookInput.error || hookInput.message || "").toLowerCase();
  return (
    msg.includes("blocked by the user") ||
    msg.includes("user rejected") ||
    msg.includes("permission denied by user") ||
    msg.includes("tool was blocked")
  );
}
```

Then inside `main()`, after the existing `appendAuditLineBoth(auditEntry, cloud);` call, add:

```js
// Write structured event for AI blame
if (eventWriter) {
  try {
    const isDenial = _isDenial(hookInput);
    if (isDenial) {
      const denialEvent = eventWriter.buildEvent(
        eventWriter.EVENT_TYPES.TOOL_DENIED,
        {
          tool: toolName,
          args: hookInput.tool_input || {},
          reason: errorMsg,
        },
        sessionId
      );
      appendAuditLineBoth(denialEvent, cloud);
    } else {
      const errorEvent = eventWriter.buildEvent(
        eventWriter.EVENT_TYPES.TOOL_ERROR,
        {
          tool: toolName,
          args: hookInput.tool_input || {},
          error: errorMsg,
        },
        sessionId
      );
      appendAuditLineBoth(errorEvent, cloud);
    }
  } catch (_) {
    // best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep "tool_denied"
```

Expected: `✓ on-error.js writes tool_denied event for user denial`

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/on-error.js
git commit -m "feat: add tool_denied and tool_error structured events to on-error.js"
```

---

### Task 4: Enrich `user_prompt` capture in `inject-context.js`

**Files:**
- Modify: `templates/hooks/inject-context.js` (lines 413–425)

**Interfaces:**
- Consumes: `buildEvent`, `EVENT_TYPES` from `event-writer.js`
- Produces: enriched `user_prompt` audit entry — verbatim prompt (no 500-char truncation), aligned to event schema with `data.content` field alongside legacy `prompt` field

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("inject-context.js writes user_prompt event with full content", () => {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  const auditDir = path.join(tmpDir, ".sticky-note", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const longPrompt = "fix the auth sliding window bug ".repeat(20); // > 500 chars
  const hookInput = {
    prompt: longPrompt,
    session_id: "sess-prompt-test",
  };

  execFileSync("node", [path.join(hooksDir, "inject-context.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });

  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const promptEvent = lines.find(l => l.type === "user_prompt");
  assert.ok(promptEvent, "user_prompt event should be written");
  // Must not be truncated to 500 chars
  assert.ok(
    (promptEvent.data && promptEvent.data.content || promptEvent.prompt || "").length > 500,
    "prompt should not be truncated to 500 chars"
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep "user_prompt"
```

Expected: `AssertionError: prompt should not be truncated to 500 chars`

- [ ] **Step 3: Update the `promptAudit` block in `inject-context.js`**

Find the block starting at line ~413 (the "Audit the user prompt" comment) and replace it:

```js
// Capture user_prompt event for AI blame
let eventWriter2 = null;
try { eventWriter2 = require("./event-writer.js"); } catch (_) {}

try {
  const promptEntry = eventWriter2
    ? eventWriter2.buildEvent(
        eventWriter2.EVENT_TYPES.USER_PROMPT,
        { content: prompt },       // verbatim, no truncation
        sessionId
      )
    : {
        type: "user_prompt",
        user: getUser(),
        ts: new Date().toISOString(),
        session_id: sessionId,
        data: { content: prompt },
      };
  // Keep legacy `prompt` field for backward compat with existing audit queries
  promptEntry.prompt = prompt.substring(0, 500);
  appendAuditLineBoth(promptEntry, cloud);
} catch (_) {
  // ignore
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep "user_prompt"
```

Expected: `✓ inject-context.js writes user_prompt event with full content`

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/inject-context.js
git commit -m "feat: remove 500-char truncation from user_prompt audit event"
```

---

### Task 5: Add `session_open` event to `session-start.js`

**Files:**
- Modify: `templates/hooks/session-start.js`

**Interfaces:**
- Consumes: `buildEvent`, `EVENT_TYPES` from `event-writer.js`
- Produces: `session_open` audit event written at session start with model, branch, user, sticky_version, mcp_servers

**Background:** The `session_open` event is the first event in every thread's event stream. It captures the session configuration at start time, enabling AI blame to know which model and context was active throughout.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("session-start.js writes session_open event", () => {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  const auditDir = path.join(tmpDir, ".sticky-note", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  const hookInput = {
    session_id: "sess-open-test",
    model: "claude-sonnet-4-6",
  };

  execFileSync("node", [path.join(hooksDir, "session-start.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });

  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  assert.ok(auditFile, "audit file should exist");
  const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const openEvent = lines.find(l => l.type === "session_open");
  assert.ok(openEvent, "session_open event should be written");
  assert.ok(openEvent.data, "session_open must have data");
  assert.ok(openEvent.data.branch !== undefined, "data.branch required");
  assert.ok(openEvent.data.user, "data.user required");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep "session_open"
```

Expected: `AssertionError: session_open event should be written`

- [ ] **Step 3: Add `session_open` write to `session-start.js`**

At the end of `session-start.js`'s `main()` function, before the `_emit(output)` call, add:

```js
// Write session_open event for AI blame
let _eventWriter = null;
try { _eventWriter = require("./event-writer.js"); } catch (_) {}
if (_eventWriter) {
  try {
    const pkg = (() => {
      try { return require("../../package.json"); } catch (_) { return {}; }
    })();
    const openEvent = _eventWriter.buildEvent(
      _eventWriter.EVENT_TYPES.SESSION_OPEN,
      {
        model: hookInput.model || hookInput.api_info?.model || null,
        branch: getBranch(),
        user: getUser(),
        sticky_version: pkg.version || null,
        mcp_servers: (loadJson(getConfigPath(), {}).mcp_servers || [])
          .map(s => (typeof s === "object" ? s.name : s))
          .filter(Boolean),
      },
      getSessionId(hookInput)
    );
    appendAuditLineBoth(openEvent, useCloud());
  } catch (_) {
    // best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node test/smoke.test.js 2>&1 | grep "session_open"
```

Expected: `✓ session-start.js writes session_open event`

- [ ] **Step 5: Commit**

```bash
git add templates/hooks/session-start.js
git commit -m "feat: write session_open event at session start for AI blame"
```

---

### Task 6: Extract AI events from transcript and push event stream to Worker

**Files:**
- Modify: `templates/hooks/session-end.js`

**Interfaces:**
- Consumes: `buildEvent`, `EVENT_TYPES` from `event-writer.js`; `getCloudConfig`, `getProjectName` from `sticky-utils.js` (already imported)
- Produces:
  - `extractAiEventsFromTranscript(transcriptPath, sessionId)` → array of `{ type, ts, session_id, data }` events (ai_thinking, ai_response, context_compressed)
  - Pushes complete event stream to `POST /threads/{threadId}/events` on Worker at session end (best-effort, non-blocking)

**Background:** Claude Code's transcript JSONL has one JSON object per line. Each line is an entry with `entry.message.role` ("user" | "assistant") and `entry.message.content` (array of blocks). Thinking blocks: `{ type: "thinking", thinking: "..." }`. Assistant text: `{ type: "text", text: "..." }`. Context compression appears as a message with a `summary` field or `type: "context_refresh"` in some versions — we extract what we can and skip unknown formats.

- [ ] **Step 1: Write the failing test**

Add to `test/smoke.test.js`:

```js
test("session-end.js extracts ai_thinking events from transcript", () => {
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  const auditDir = path.join(tmpDir, ".sticky-note", "audit");
  fs.mkdirSync(auditDir, { recursive: true });

  // Write a fake transcript with a thinking block
  const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript.jsonl");
  const thinkingEntry = {
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I should look at the auth module first." },
        { type: "text", text: "Let me check the auth logic." },
      ],
    },
  };
  fs.writeFileSync(transcriptPath, JSON.stringify(thinkingEntry) + "\n");

  const hookInput = {
    session_id: "sess-ai-events-test",
    transcript_path: transcriptPath,
  };

  execFileSync("node", [path.join(hooksDir, "session-end.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });

  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

  const thinkingEvent = lines.find(l => l.type === "ai_thinking");
  assert.ok(thinkingEvent, "ai_thinking event should be extracted and written");
  assert.ok(
    thinkingEvent.data.content.includes("auth module"),
    "thinking content should match transcript"
  );

  const responseEvent = lines.find(l => l.type === "ai_response");
  assert.ok(responseEvent, "ai_response event should be extracted and written");
  assert.ok(responseEvent.data.content.includes("auth logic"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node test/smoke.test.js 2>&1 | grep "ai_thinking"
```

Expected: `AssertionError: ai_thinking event should be extracted and written`

- [ ] **Step 3: Add `extractAiEventsFromTranscript` function to `session-end.js`**

Add after the existing `extractFailedApproaches` function (around line 378):

```js
// ── AI event extraction for AI blame ─────────────────────

let _eventWriter = null;
try { _eventWriter = require("./event-writer.js"); } catch (_) {}

/**
 * Parse Claude Code's transcript JSONL to extract ai_thinking,
 * ai_response, and context_compressed events for the AI blame stream.
 * Returns an array of structured events ordered by their appearance.
 */
function extractAiEventsFromTranscript(transcriptPath, sessionId) {
  if (!_eventWriter) return [];
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];

  const events = [];
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch (_) {
    return [];
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_) { continue; }

    // Context compression: Claude Code emits entries with a summary field
    // when the context window is compacted.
    if (entry.type === "summary" && entry.summary) {
      events.push(_eventWriter.buildEvent(
        _eventWriter.EVENT_TYPES.CONTEXT_COMPRESSED,
        {
          summary: String(entry.summary).substring(0, 1000),
          tokens_before: entry.tokens_before || null,
          tokens_after: entry.tokens_after || null,
        },
        sessionId
      ));
      continue;
    }

    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const role = message.role || entry.role || "";
    if (role !== "assistant") continue;

    const contentBlocks = _getContentBlocks(entry); // reuse existing helper
    if (!Array.isArray(contentBlocks)) continue;

    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;

      if (block.type === "thinking" && block.thinking) {
        events.push(_eventWriter.buildEvent(
          _eventWriter.EVENT_TYPES.AI_THINKING,
          { content: block.thinking },
          sessionId
        ));
      }

      if (block.type === "text" && block.text && block.text.trim()) {
        events.push(_eventWriter.buildEvent(
          _eventWriter.EVENT_TYPES.AI_RESPONSE,
          { content: block.text },
          sessionId
        ));
      }
    }

    // Token usage may appear on the entry itself (Claude Code's format)
    if (entry.usage && _eventWriter) {
      const last = events[events.length - 1];
      if (last && last.type === _eventWriter.EVENT_TYPES.AI_RESPONSE) {
        last.data.input_tokens = entry.usage.input_tokens || null;
        last.data.output_tokens = entry.usage.output_tokens || null;
        last.data.cache_read_tokens = entry.usage.cache_read_input_tokens || null;
      }
    }
  }

  return events;
}

/**
 * Collect all events for this session from the audit JSONL files
 * (tool_call, tool_result, tool_error, tool_denied, user_prompt, session_open)
 * plus the AI events extracted from the transcript.
 * Sort by ts. Returns an array ready to push to the Worker.
 */
function collectSessionEvents(sessionId, hookInput) {
  const events = [];

  // Gather structured events from audit (written by hooks during the session)
  const typesForBlame = new Set([
    "tool_call", "tool_result", "tool_error", "tool_denied",
    "user_prompt", "session_open", "checkpoint",
  ]);

  for (const auditPath of getAllAuditPaths()) {
    try {
      const raw = fs.readFileSync(auditPath, "utf-8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch (_) { continue; }
        if (entry.session_id === sessionId && typesForBlame.has(entry.type)) {
          events.push(entry);
        }
      }
    } catch (_) {
      // ignore unreadable audit file
    }
  }

  // Add AI events from transcript
  const transcriptEvents = extractAiEventsFromTranscript(
    hookInput.transcript_path || "", sessionId
  );
  events.push(...transcriptEvents);

  // Sort by ts ascending
  events.sort((a, b) => {
    if (a.ts < b.ts) return -1;
    if (a.ts > b.ts) return 1;
    return 0;
  });

  return events;
}
```

- [ ] **Step 4: Add AI event writes and cloud push to `main()` in `session-end.js`**

In `main()`, after `captureTranscript(...)` is called (around line 1055), add:

```js
// Extract AI events from transcript and write to audit for local AI blame
const aiEvents = extractAiEventsFromTranscript(
  hookInput.transcript_path || "", sessionId
);
for (const ev of aiEvents) {
  try { appendAuditLineBoth(ev, cloud); } catch (_) {}
}

// Push complete event stream to Worker for team-wide AI blame
// This is a no-op if cloud is not configured or the endpoint doesn't exist yet.
if (cloud && existing && existing.id) {
  try {
    const allEvents = collectSessionEvents(sessionId, hookInput);
    if (allEvents.length > 0) {
      const { url: stickyUrl, apiKey: stickyApiKey } = getCloudConfig();
      const projectName = getProjectName();
      const headers = {
        "Content-Type": "application/json",
        "X-Sticky-Project": projectName,
      };
      if (stickyApiKey) headers["X-Sticky-API-Key"] = stickyApiKey;
      fetch(`${stickyUrl}/threads/${existing.id}/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: allEvents }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {}); // non-fatal
    }
  } catch (_) {
    // non-fatal — Worker endpoint may not exist until Plan 2 ships
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
node test/smoke.test.js 2>&1 | tail -10
```

Expected: new test passes; existing tests unchanged.

```bash
node test/event-writer.test.js
```

Expected: all event-writer tests still pass.

- [ ] **Step 6: Commit**

```bash
git add templates/hooks/session-end.js
git commit -m "feat: extract ai_thinking/ai_response events from transcript and push event stream to Worker"
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| tool_call + tool_result with full args/result | Task 2 |
| tool_denied event | Task 3 |
| tool_error event | Task 3 |
| user_prompt verbatim capture | Task 4 |
| session_open event at start | Task 5 |
| ai_thinking extraction | Task 6 |
| ai_response extraction | Task 6 |
| context_compressed extraction | Task 6 |
| Event stream push to Worker at session end | Task 6 |
| 10 KB cap on tool results | Task 1 (capResult) + Task 2 |
| diff/hash for large Write/Edit args | Task 1 (sanitizeToolArgs) + Task 2 |
| Secrets redacted | Inherited — existing `redactSecrets` in session-end.js already covers transcript; audit events go through existing `appendAuditLineBoth` which doesn't redact inline. Add note: for audit events written during the session (tool_call args etc.), redaction at write time is not implemented in this plan — it is inherited from the session-end transcript redaction. Flag as a follow-up. |

**Not covered by Plan 1 (deferred to Plan 2):**
- Worker `/threads/{id}/events` endpoint to receive pushed events (Plan 2 Task 1)
- Durable Object for KV storage (Plan 2)
- Remote MCP write tools for cowork sessions (Plan 2)
- Init wizard GitHub PAT + connector URL output (Plan 2)
