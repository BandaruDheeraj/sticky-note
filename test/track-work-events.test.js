// test/track-work-events.test.js
"use strict";
/**
 * Tests that track-work.js emits tool_call and tool_result events
 * in addition to the legacy tool_use audit entry.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-note-tw-events-"));
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

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

console.log("\n  track-work events tests\n");

setup();

try {
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

  test("track-work.js still writes legacy tool_use entry", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: { output: "hello\n" },
      session_id: "sess-tool-use-legacy",
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

    const toolUse = lines.find(l => l.type === "tool_use" && l.tool === "Bash");
    assert.ok(toolUse, "legacy tool_use entry should still be written");
  });

  test("track-work.js tool_call has ts and session_id", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const hookInput = {
      tool_name: "Glob",
      tool_input: { pattern: "*.ts" },
      tool_response: { output: "src/foo.ts\n" },
      session_id: "sess-fields-check",
    };

    execFileSync("node", [path.join(hooksDir, "track-work.js")], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpDir,
    });

    const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
    const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
      .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));

    const toolCall = lines.find(l => l.type === "tool_call" && l.session_id === "sess-fields-check");
    assert.ok(toolCall, "tool_call event should be written");
    assert.ok(toolCall.ts, "tool_call should have ts");
    assert.strictEqual(toolCall.session_id, "sess-fields-check");
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
