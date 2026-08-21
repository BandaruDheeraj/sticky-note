// test/on-error-events.test.js
"use strict";
/**
 * Tests that on-error.js emits tool_denied events for user denials and
 * tool_error events for genuine errors, in addition to the legacy error entry.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-note-on-error-events-"));
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
  execFileSync("node", [path.join(hooksDir, "on-error.js")], {
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

console.log("\n  on-error events tests\n");

setup();

try {
  test("on-error.js writes tool_denied event for user denial (blocked: true)", () => {
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

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const denial = lines.find(l => l.type === "tool_denied");
    assert.ok(denial, "tool_denied event should be written");
    assert.strictEqual(denial.data.tool, "Bash");
    assert.deepStrictEqual(denial.data.args, { command: "rm -rf dist/" });
    assert.ok(denial.data.reason.includes("blocked"), "reason should describe denial");
  });

  test("on-error.js writes tool_denied event when error text matches denial pattern", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Write",
      tool_input: { file_path: "secret.txt", content: "data" },
      error: "blocked by the user",
      session_id: "sess-denial-text-test",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const denial = lines.find(l => l.type === "tool_denied" && l.session_id === "sess-denial-text-test");
    assert.ok(denial, "tool_denied event should be written for text-based denial detection");
    assert.strictEqual(denial.data.tool, "Write");
  });

  test("on-error.js writes tool_error event for genuine errors", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Process exited with code 1",
      session_id: "sess-error-test",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const errorEvent = lines.find(l => l.type === "tool_error" && l.session_id === "sess-error-test");
    assert.ok(errorEvent, "tool_error event should be written for genuine errors");
    assert.strictEqual(errorEvent.data.tool, "Bash");
    assert.deepStrictEqual(errorEvent.data.args, { command: "npm test" });
    assert.ok(errorEvent.data.error.includes("exited"), "error field should contain error message");
  });

  test("on-error.js still writes legacy error entry alongside new events", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Glob",
      tool_input: { pattern: "*.ts" },
      error: "ENOENT: no such file or directory",
      session_id: "sess-legacy-error",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const legacyError = lines.find(l => l.type === "error" && l.session_id === "sess-legacy-error");
    assert.ok(legacyError, "legacy error entry should still be written");
    assert.strictEqual(legacyError.tool, "Glob");
  });

  test("on-error.js tool_denied has ts and session_id fields", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Edit",
      tool_input: { file_path: "src/index.js", old_string: "a", new_string: "b" },
      error: "user rejected the operation",
      session_id: "sess-fields-denial",
    };

    runHook(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const denial = lines.find(l => l.type === "tool_denied" && l.session_id === "sess-fields-denial");
    assert.ok(denial, "tool_denied event should be written");
    assert.ok(denial.ts, "tool_denied should have ts field");
    assert.strictEqual(denial.session_id, "sess-fields-denial", "tool_denied should have session_id");
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
