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
