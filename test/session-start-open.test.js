// test/session-start-open.test.js
"use strict";
/**
 * Tests that session-start.js emits a session_open event at session start,
 * capturing model, branch, user, sticky_version, and mcp_servers.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const TEMPLATES = path.join(__dirname, "..", "templates");
let tmpDir;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \u2713 " + name);
    passed++;
  } catch (err) {
    console.error("  \u2717 " + name + ": " + (err.message || err));
    failed++;
  }
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-note-session-open-"));
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init", { cwd: tmpDir, stdio: "pipe" });

  // Set up .sticky-note config
  const stickyDir = path.join(tmpDir, ".sticky-note");
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  fs.mkdirSync(path.join(stickyDir, "audit"), { recursive: true });
  fs.mkdirSync(path.join(stickyDir, "presence"), { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  fs.writeFileSync(
    path.join(stickyDir, "sticky-note.json"),
    JSON.stringify({ version: "2", project: "", threads: [] }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(stickyDir, "sticky-note-config.json"),
    JSON.stringify({
      stale_days: 14,
      inject_token_budget: 1000,
      mcp_servers: [],
      skills: [],
      conventions: [],
      hook_version: "2.5.0",
    }, null, 2) + "\n"
  );

  // Copy hook files from templates
  const hookFiles = fs.readdirSync(path.join(TEMPLATES, "hooks")).filter(f => f.endsWith(".js"));
  for (const file of hookFiles) {
    fs.copyFileSync(
      path.join(TEMPLATES, "hooks", file),
      path.join(hooksDir, file)
    );
  }
}

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* best effort */ }
}

function runHook(hooksDir, input) {
  execFileSync("node", [path.join(hooksDir, "session-start.js")], {
    input: JSON.stringify(input),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });
}

function readAuditLines(auditDir) {
  const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
  if (!auditFile) return [];
  return fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
    .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

console.log("\n  session-start session_open event tests\n");

setup();

try {
  test("session-start.js writes session_open event", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    const hookInput = {
      session_id: "sess-open-test",
      model: "claude-sonnet-4-6",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open");
    assert.ok(openEvent, "session_open event should be written");
    assert.ok(openEvent.data, "session_open must have data");
    assert.ok(openEvent.data.branch !== undefined, "data.branch required");
    assert.ok(openEvent.data.user, "data.user required");
  });

  test("session_open event captures model from hookInput", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      session_id: "sess-model-test",
      model: "claude-opus-4",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open" && l.session_id === "sess-model-test");
    assert.ok(openEvent, "session_open event should be written");
    assert.strictEqual(openEvent.data.model, "claude-opus-4", "model should be captured from hookInput");
  });

  test("session_open event has ts and session_id fields", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      session_id: "sess-fields-test",
      model: "claude-sonnet-4-6",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open" && l.session_id === "sess-fields-test");
    assert.ok(openEvent, "session_open event should be written");
    assert.ok(openEvent.ts, "session_open should have ts field");
    assert.strictEqual(openEvent.session_id, "sess-fields-test", "session_id should match hookInput");
  });

  test("session_open event has mcp_servers field (array)", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      session_id: "sess-mcp-test",
      model: "claude-sonnet-4-6",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open" && l.session_id === "sess-mcp-test");
    assert.ok(openEvent, "session_open event should be written");
    assert.ok(Array.isArray(openEvent.data.mcp_servers), "data.mcp_servers should be an array");
  });

  test("session_open event has sticky_version field", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      session_id: "sess-version-test",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open" && l.session_id === "sess-version-test");
    assert.ok(openEvent, "session_open event should be written");
    // sticky_version may be null or a string — just check the key exists
    assert.ok("sticky_version" in openEvent.data, "data.sticky_version key should exist");
  });

  test("session_open model defaults to null when not provided", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      session_id: "sess-nomodel-test",
      // no model field
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const openEvent = lines.find(l => l.type === "session_open" && l.session_id === "sess-nomodel-test");
    assert.ok(openEvent, "session_open event should be written even without model");
    // model should be null (not undefined, not an error)
    assert.strictEqual(openEvent.data.model, null, "model should be null when not provided");
  });

} finally {
  cleanup();
}

// Summary
if (failed > 0) {
  console.error(`\n  ${failed} test(s) failed, ${passed} passed\n`);
  process.exit(1);
} else {
  console.log(`\n  ${passed} test(s) passed\n`);
}
