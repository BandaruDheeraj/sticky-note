#!/usr/bin/env node
"use strict";
/**
 * inject-context-prompt.test.js
 *
 * Tests that inject-context.js writes a full user_prompt event using the
 * event-writer schema (data.content, no 500-char truncation).
 */

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

const TEMPLATES = path.join(__dirname, "..", "templates");

let tmpDir;
let passed = 0;
let failed = 0;
const failures = [];

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-inject-prompt-test-"));
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init", { cwd: tmpDir, stdio: "pipe" });

  // Set up .claude/hooks
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookFiles = fs.readdirSync(path.join(TEMPLATES, "hooks")).filter(f => f.endsWith(".js"));
  for (const file of hookFiles) {
    fs.copyFileSync(
      path.join(TEMPLATES, "hooks", file),
      path.join(hooksDir, file)
    );
  }

  // Set up .sticky-note dir with minimal config
  const stickyDir = path.join(tmpDir, ".sticky-note");
  fs.mkdirSync(path.join(stickyDir, "audit"), { recursive: true });
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
}

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message || String(err) });
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message || err}`);
  }
}

console.log("\n  inject-context user_prompt event tests\n");

setup();

try {
  run("inject-context.js writes user_prompt event with full content (no 500-char truncation)", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    // Create a prompt longer than 500 chars
    const longPrompt = "fix the auth sliding window bug ".repeat(20); // 640 chars
    assert.ok(longPrompt.length > 500, "test prompt should be > 500 chars");

    const hookInput = {
      prompt: longPrompt,
      session_id: "sess-prompt-test",
    };

    execFileSync("node", [path.join(hooksDir, "inject-context.js")], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      timeout: 15000,
    });

    const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
    assert.ok(auditFile, "audit file should be written");

    const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    const promptEvent = lines.find(l => l.type === "user_prompt");
    assert.ok(promptEvent, "user_prompt event should be written to audit");

    // Check full content is in data.content (new schema) or prompt (legacy)
    const capturedContent =
      (promptEvent.data && promptEvent.data.content) || promptEvent.prompt || "";
    assert.ok(
      capturedContent.length > 500,
      `prompt should not be truncated to 500 chars, got ${capturedContent.length} chars`
    );
    assert.strictEqual(
      capturedContent,
      longPrompt,
      "captured content should match the full prompt verbatim"
    );
  });

  run("inject-context.js user_prompt event has data.content field", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    // Clear any previous audit files
    for (const f of fs.readdirSync(auditDir)) {
      fs.unlinkSync(path.join(auditDir, f));
    }

    const testPrompt = "test prompt for schema validation " + "x".repeat(200);
    const hookInput = {
      prompt: testPrompt,
      session_id: "sess-schema-test",
    };

    execFileSync("node", [path.join(hooksDir, "inject-context.js")], {
      input: JSON.stringify(hookInput),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      timeout: 15000,
    });

    const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
    assert.ok(auditFile, "audit file should be written");

    const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .map(l => JSON.parse(l));

    const promptEvent = lines.find(l => l.type === "user_prompt");
    assert.ok(promptEvent, "user_prompt event should be written");
    assert.ok(
      promptEvent.data && typeof promptEvent.data.content === "string",
      "event should have data.content field (structured event schema)"
    );
    assert.strictEqual(
      promptEvent.data.content,
      testPrompt,
      "data.content should contain full prompt"
    );
    assert.ok(promptEvent.ts, "event should have ts field");
    assert.ok(promptEvent.session_id, "event should have session_id field");
  });

  run("inject-context.js user_prompt event keeps legacy prompt field for backward compat", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    // Clear previous audit files
    for (const f of fs.readdirSync(auditDir)) {
      fs.unlinkSync(path.join(auditDir, f));
    }

    const testPrompt = "legacy compat test " + "y".repeat(300);
    execFileSync("node", [path.join(hooksDir, "inject-context.js")], {
      input: JSON.stringify({ prompt: testPrompt, session_id: "sess-legacy-test" }),
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: tmpDir,
      env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      timeout: 15000,
    });

    const auditFile = fs.readdirSync(auditDir).find(f => f.endsWith(".jsonl"));
    const lines = fs.readFileSync(path.join(auditDir, auditFile), "utf-8")
      .split("\n").filter(l => l.trim()).map(l => JSON.parse(l));
    const promptEvent = lines.find(l => l.type === "user_prompt");
    assert.ok(promptEvent, "user_prompt event should exist");
    assert.ok(
      typeof promptEvent.prompt === "string",
      "legacy prompt field should be present for backward compat"
    );
    // Legacy field is truncated at 500 per spec
    assert.ok(
      promptEvent.prompt.length <= 500,
      "legacy prompt field should be truncated to 500 chars"
    );
  });

} finally {
  cleanup();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) {
    console.log(`    \u2717 ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
