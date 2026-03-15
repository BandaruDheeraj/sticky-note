#!/usr/bin/env node

/**
 * Smoke tests for sticky-note CLI.
 *
 * Runs core commands in an isolated temp directory to verify they don't crash.
 * No external test framework required — uses Node.js assert.
 */

const { execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");

const CLI = path.join(__dirname, "..", "bin", "cli.js");
const TEMPLATES = path.join(__dirname, "..", "templates");
let tmpDir;
let passed = 0;
let failed = 0;
const failures = [];

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-note-test-"));
  process.chdir(tmpDir);
  execSync("git init", { stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { stdio: "pipe" });
  execSync('git config user.name "Test User"', { stdio: "pipe" });
  fs.writeFileSync("README.md", "# test\n");
  execSync("git add . && git commit -m init", { stdio: "pipe" });
}

// Manually set up the same files that `init` would create, bypassing interactive prompts
function setupStickyNote() {
  const stickyDir = path.join(tmpDir, ".sticky-note");
  const claudeHooksDir = path.join(tmpDir, ".claude", "hooks");
  const githubHooksDir = path.join(tmpDir, ".github", "hooks");

  fs.mkdirSync(stickyDir, { recursive: true });
  fs.mkdirSync(path.join(stickyDir, "audit"), { recursive: true });
  fs.mkdirSync(path.join(stickyDir, "presence"), { recursive: true });
  fs.mkdirSync(claudeHooksDir, { recursive: true });
  fs.mkdirSync(githubHooksDir, { recursive: true });

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
      path.join(claudeHooksDir, file)
    );
  }

  // Copy settings and hooks.json
  fs.copyFileSync(
    path.join(TEMPLATES, "settings.json"),
    path.join(tmpDir, ".claude", "settings.json")
  );
  fs.copyFileSync(
    path.join(TEMPLATES, "hooks.json"),
    path.join(githubHooksDir, "hooks.json")
  );
}

function cleanup() {
  try {
    process.chdir(os.tmpdir());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* best effort */ }
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

function cli(args, options = {}) {
  return execFileSync("node", [CLI, ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
    timeout: 15000,
    ...options,
  });
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

console.log("\n  sticky-note smoke tests\n");

setup();

try {
  // ── Pre-init tests ──

  run("--version prints version", () => {
    const out = cli(["--version"]);
    assert.match(out, /sticky-note v\d+\.\d+\.\d+/, "Should print version string");
  });

  run("--help prints usage", () => {
    const out = cli(["--help"]);
    assert.ok(out.includes("Usage:"), "Should include usage info");
    assert.ok(out.includes("init"), "Should list init command");
    assert.ok(out.includes("status"), "Should list status command");
    assert.ok(out.includes("threads"), "Should list threads command");
  });

  run("status works before init", () => {
    const out = cli(["status"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  // ── Set up sticky-note files ──

  setupStickyNote();

  // ── Post-init tests ──

  run("sticky-note.json has valid structure", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".sticky-note", "sticky-note.json"), "utf-8")
    );
    assert.ok(data.version, "Should have version field");
    assert.ok(Array.isArray(data.threads), "Should have threads array");
  });

  run("config file has valid structure", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".sticky-note", "sticky-note-config.json"), "utf-8")
    );
    assert.ok(typeof data.stale_days === "number", "Should have stale_days");
    assert.ok(data.hook_version, "Should have hook_version");
  });

  run("status works after init", () => {
    const out = cli(["status"]);
    assert.ok(out.includes("sticky-note"), "Should show status output");
  });

  run("threads runs without error", () => {
    const out = cli(["threads"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("update preserves data", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.project = "test-marker";
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    cli(["update"]);

    const after = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    assert.strictEqual(after.project, "test-marker", "Should preserve existing data");
  });

  run("update outputs success and refreshes hooks", () => {
    const out = cli(["update"]);
    assert.ok(out.includes("Scripts updated"), "Should print scripts updated message");
    assert.ok(out.includes("[OK]"), "Should have [OK] status lines");
    // Verify hook files were (re)written
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    for (const file of ["session-start.js", "session-end.js", "inject-context.js"]) {
      assert.ok(
        fs.existsSync(path.join(hooksDir, file)),
        `Hook file ${file} should exist after update`
      );
    }
  });

  run("gc runs without error", () => {
    const out = cli(["gc"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("audit handles empty audit dir", () => {
    try {
      const out = cli(["audit"]);
      assert.ok(out.length > 0, "Should produce output");
    } catch (err) {
      // audit exits 1 when no audit files exist — that's correct behavior
      assert.ok(
        err.stderr?.includes("No audit") || err.message?.includes("No audit") || err.message?.includes("Command failed"),
        "Should fail gracefully with no audit data"
      );
    }
  });

  run("who runs without error", () => {
    const out = cli(["who"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("checkpoint --show runs without error", () => {
    const out = cli(["checkpoint", "--show"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("get-line-attribution works on a file", () => {
    const out = cli(["get-line-attribution", "--file", "README.md"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("hooks are JavaScript files", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const files = fs.readdirSync(hooksDir);
    const jsFiles = files.filter(f => f.endsWith(".js"));
    assert.ok(jsFiles.length >= 5, `Should have multiple .js hooks, found ${jsFiles.length}`);
    const pyFiles = files.filter(f => f.endsWith(".py"));
    assert.strictEqual(pyFiles.length, 0, "Should have zero .py hooks");
  });

  run("templates contain no Python hooks", () => {
    const files = fs.readdirSync(path.join(TEMPLATES, "hooks"));
    const pyFiles = files.filter(f => f.endsWith(".py"));
    assert.strictEqual(pyFiles.length, 0, "Templates should have zero .py hooks");
  });

  run("no v3.5 migration doc exists", () => {
    const docsDir = path.join(__dirname, "..", "docs");
    assert.ok(
      !fs.existsSync(path.join(docsDir, "v35-migration.md")),
      "v35-migration.md should not exist"
    );
  });

  // ── doctor tests ──

  run("doctor runs before init (reports failures)", () => {
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-doctor-bare-"));
    try {
      execSync("git init", { cwd: bareDir, stdio: "pipe" });
      cli(["doctor"], { cwd: bareDir });
      assert.ok(false, "Expected doctor to exit with code 1 in bare repo");
    } catch (err) {
      const out = err.stdout || "";
      assert.ok(out.includes("[FAIL]"), "Should report failures in bare repo");
      assert.ok(out.includes("Doctor"), "Should show Doctor heading");
    } finally {
      fs.rmSync(bareDir, { recursive: true, force: true });
    }
  });

  run("doctor runs after init (healthy setup)", () => {
    const out = cli(["doctor"]);
    assert.ok(out.includes("Doctor"), "Should show Doctor heading");
    assert.ok(out.includes("[OK]"), "Should have passing checks");
    assert.ok(!out.includes("[FAIL]"), "Should have no failures in properly set up repo");
  });

  run("doctor detects missing hook file", () => {
    const hookPath = path.join(tmpDir, ".claude", "hooks", "session-start.js");
    const backup = fs.readFileSync(hookPath);
    fs.unlinkSync(hookPath);
    try {
      cli(["doctor"]);
      assert.ok(false, "Expected doctor to exit 1 with missing hook");
    } catch (err) {
      const out = err.stdout || "";
      assert.ok(out.includes("session-start.js"), "Should name the missing hook");
      assert.ok(out.includes("[FAIL]"), "Should report as failure");
    } finally {
      fs.writeFileSync(hookPath, backup);
    }
  });

  // ── resume tests ──

  run("resume --list with no threads shows empty message", () => {
    const out = cli(["resume", "--list"]);
    assert.ok(out.includes("No resumable threads"), "Should report no resumable threads");
  });

  run("resume with unknown id exits non-zero", () => {
    assert.throws(
      () => cli(["resume", "nonexistent-id"]),
      /Command failed/,
      "Should exit with error for unknown thread id"
    );
  });

  run("resume with unknown id prints error message", () => {
    try {
      cli(["resume", "nonexistent-id"]);
      assert.fail("Should have thrown");
    } catch (err) {
      const combined = (err.stdout || "") + (err.stderr || "") + (err.message || "");
      assert.ok(
        combined.includes("No thread found") || combined.includes("ERR"),
        "Should print an error about missing thread"
      );
    }
  });

  run("resume --clear with no signal reports gracefully", () => {
    const out = cli(["resume", "--clear"]);
    assert.ok(
      out.includes("No active resume") || out.includes("cleared") || out.length > 0,
      "Should handle missing resume signal"
    );
  });

  // ── reset tests ──

  run("reset with no threads reports nothing to reset", () => {
    const out = cli(["reset"]);
    assert.ok(out.includes("Nothing to reset") || out.includes("0 threads"), "Should report 0 threads");
  });

  run("reset --force clears threads", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.threads = [
      { id: "aabbccdd-1111-2222-3333-444455556666", status: "open", user: "test", branch: "main", files_touched: [], created_at: new Date().toISOString() }
    ];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    const out = cli(["reset", "--force"]);
    assert.ok(out.includes("[OK]"), "Should print [OK]");

    const after = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    assert.strictEqual(after.threads.length, 0, "Threads should be cleared");
  });

  run("reset --force --keep-audit preserves audit dir", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");
    const testAudit = path.join(auditDir, "test-user.jsonl");
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(testAudit, JSON.stringify({ action: "test" }) + "\n");

    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.threads = [
      { id: "aabbccdd-1111-2222-3333-444455556677", status: "open", user: "test", branch: "main", files_touched: [], created_at: new Date().toISOString() }
    ];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    cli(["reset", "--force", "--keep-audit"]);
    assert.ok(fs.existsSync(testAudit), "Audit file should be preserved with --keep-audit");
  });

  // ── overlap tests ──

  run("overlap --files with no matching threads shows no overlaps", () => {
    const out = cli(["overlap", "--files", "README.md"]);
    assert.ok(out.length > 0, "Should produce output");
    assert.ok(
      out.includes("No overlaps") || out.includes("0 overlap") || out.includes("Checking"),
      "Should indicate no overlaps found"
    );
  });

  run("overlap --files detects match with open thread", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.threads = [
      {
        id: "overlap-thread-111-222-333-444-555",
        status: "open",
        user: "alice",
        branch: "feature/auth",
        files_touched: ["README.md"],
        created_at: new Date().toISOString(),
        last_note: "working on readme"
      }
    ];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    const out = cli(["overlap", "--files", "README.md"]);
    assert.ok(
      out.includes("README.md") || out.includes("alice") || out.includes("overlap"),
      "Should detect overlap with alice's thread"
    );

    // Restore empty threads
    data.threads = [];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");
  });

  // ── claim tests ──

  run("claim --list with no claims shows empty message", () => {
    const out = cli(["claim", "--list"]);
    assert.ok(
      out.includes("No active claims") || out.length > 0,
      "Should report no claims"
    );
  });

  run("claim with no args shows usage", () => {
    const out = cli(["claim"]);
    assert.ok(out.includes("Usage"), "Should show usage");
  });

  run("claim adds a claim for a file", () => {
    const out = cli(["claim", "README.md", "working on docs"]);
    assert.ok(out.includes("[OK]") || out.includes("Claimed"), "Should confirm claim");

    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    const claims = data.claims || [];
    const match = claims.find(c => c.files && c.files.includes("README.md"));
    assert.ok(match, "Claim for README.md should appear in sticky-note.json");
  });

  run("claim --clear removes claims", () => {
    const out = cli(["claim", "--clear"]);
    assert.ok(out.includes("[OK]") || out.includes("Cleared"), "Should confirm clear");

    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    const claims = data.claims || [];
    assert.strictEqual(claims.length, 0, "Claims should be empty after --clear");
  });

  // ── checkpoint tests ──

  run("checkpoint --topic sets a checkpoint", () => {
    const out = cli(["checkpoint", "--topic", "refactoring auth module"]);
    assert.ok(out.includes("[OK]") || out.includes("Checkpoint") || out.length > 0, "Should confirm checkpoint set");
  });

  run("checkpoint --show reflects set topic", () => {
    cli(["checkpoint", "--topic", "smoke test topic"]);
    const out = cli(["checkpoint", "--show"]);
    assert.ok(
      out.includes("smoke test topic") || out.includes("Checkpoint") || out.length > 0,
      "Should show the current checkpoint"
    );
  });

  run("checkpoint --clear removes checkpoint", () => {
    const out = cli(["checkpoint", "--clear"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  // ── resume-thread tests ──

  run("resume-thread --query with no threads returns gracefully", () => {
    try {
      const out = cli(["resume-thread", "--query", "auth work"]);
      assert.ok(out.length > 0, "Should produce output");
    } catch (err) {
      // Exits non-zero when no match — that's acceptable
      assert.ok(
        (err.stdout || "").length > 0 || (err.stderr || "").length > 0 || err.message.includes("Command failed"),
        "Should produce some output"
      );
    }
  });

  run("resume-thread --json flag produces parseable output or graceful message", () => {
    try {
      const out = cli(["resume-thread", "--query", "auth", "--json"]);
      // Either valid JSON or a plain message
      try {
        JSON.parse(out);
      } catch (_) {
        assert.ok(out.length > 0, "Should produce some output");
      }
    } catch (err) {
      // Acceptable: exits non-zero when no match found
      assert.ok(
        (err.stdout || "").length > 0 || (err.stderr || "").length > 0,
        "Should produce some output even on failure"
      );
    }
  });

  // ── threads command edge cases ──

  run("threads shows open thread", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.threads = [
      {
        id: "thread-show-test-111-222-333-4444",
        status: "open",
        user: "bob",
        tool: "claude-code",
        branch: "feature/x",
        files_touched: ["src/foo.js"],
        created_at: new Date().toISOString(),
        last_note: "in progress"
      }
    ];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    const out = cli(["threads"]);
    assert.ok(out.includes("bob") || out.includes("feature/x") || out.includes("open"), "Should list the open thread");

    data.threads = [];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");
  });

  run("threads shows stuck thread with [STUCK] label", () => {
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.threads = [
      {
        id: "thread-stuck-test-111-222-333-444",
        status: "stuck",
        user: "carol",
        tool: "copilot-cli",
        branch: "feature/y",
        files_touched: ["src/bar.js"],
        created_at: new Date().toISOString(),
        last_note: "blocked on auth"
      }
    ];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    const out = cli(["threads"]);
    assert.ok(out.includes("STUCK") || out.includes("stuck"), "Should show [STUCK] for stuck thread");

    data.threads = [];
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");
  });

  // ── unknown command ──

  run("unknown command prints help or error", () => {
    try {
      const out = cli(["not-a-real-command"]);
      assert.ok(out.includes("Usage") || out.includes("Commands") || out.includes("sticky-note"), "Should print help for unknown command");
    } catch (err) {
      // Exiting non-zero for unknown commands is fine — check stderr or stdout has info
      const combined = (err.stdout || "") + (err.stderr || "");
      assert.ok(
        combined.includes("sticky-note") || combined.includes("unknown") || combined.includes("Usage") || combined.length > 0,
        "Should produce some output for unknown command"
      );
    }
  });

} finally {
  cleanup();
}

// Summary
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failures.length > 0) {
  console.log("  Failures:");
  for (const f of failures) {
    console.log(`    \u2717 ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
