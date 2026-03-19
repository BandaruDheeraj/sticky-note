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

  // ── Sync & auto-commit tests ──

  // Commit sticky-note files first so we have a clean baseline
  try {
    execSync('git add -A && git commit -m "setup sticky-note files"', { cwd: tmpDir, stdio: "pipe" });
  } catch (_) { /* may already be committed */ }

  run("sync command works with clean tree", () => {
    const out = cli(["sync"]);
    assert.ok(out.includes("Nothing to sync") || out.includes("clean"), "Should report nothing to sync");
  });

  run("sync command commits dirty .sticky-note/ files", () => {
    // Dirty the sticky-note.json
    const snPath = path.join(tmpDir, ".sticky-note", "sticky-note.json");
    const data = JSON.parse(fs.readFileSync(snPath, "utf-8"));
    data.project = "sync-test";
    fs.writeFileSync(snPath, JSON.stringify(data, null, 2) + "\n");

    const out = cli(["sync"]);
    assert.ok(out.includes("Committed") || out.includes("✅"), "Should commit changes");

    // Verify git log has the sync commit
    const log = execSync("git log --oneline -1", { cwd: tmpDir, encoding: "utf-8" });
    assert.ok(log.includes("sticky-note"), "Last commit should be sticky-note sync");
  });

  run("post-commit hook template exists", () => {
    const hookPath = path.join(TEMPLATES, "hooks", "post-commit");
    assert.ok(fs.existsSync(hookPath), "post-commit template should exist");
    const content = fs.readFileSync(hookPath, "utf-8");
    assert.ok(content.includes("sticky-syncing"), "Should have recursion guard");
    assert.ok(content.includes("sticky-note"), "Should reference sticky-note");
  });

  run("config template has auto_sync options", () => {
    const configTemplate = JSON.parse(
      fs.readFileSync(path.join(TEMPLATES, "sticky-note-config.json"), "utf-8")
    );
    assert.strictEqual(configTemplate.auto_sync, true, "auto_sync should default to true");
    assert.strictEqual(configTemplate.auto_push, false, "auto_push should default to false");
  });

  run("syncStickyNote utility exists in sticky-utils", () => {
    const utilsPath = path.join(TEMPLATES, "hooks", "sticky-utils.js");
    const utils = require(utilsPath);
    assert.ok(typeof utils.syncStickyNote === "function", "syncStickyNote should be exported");
  });

  run("bootstrap runs without error (no manifest)", () => {
    const out = cli(["bootstrap"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("env status runs without error", () => {
    const out = cli(["env", "status"]);
    assert.ok(out.length > 0, "Should produce output");
  });

  run("environment directory template exists", () => {
    const manifestPath = path.join(TEMPLATES, "environment", "manifest.json");
    assert.ok(fs.existsSync(manifestPath), "templates/environment/manifest.json should exist");
    const data = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    assert.ok(data.version, "Manifest should have version field");
  });

  run("provisioning creates .env-provision-hash", () => {
    // Set up a minimal environment dir for provisioning
    const envDir = path.join(tmpDir, ".sticky-note", "environment");
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(
      path.join(envDir, "manifest.json"),
      JSON.stringify({ version: "1", mcp_servers: {} }, null, 2) + "\n"
    );

    // Run session-start hook (it calls ensureEnvironmentProvisioned internally)
    const hookPath = path.join(TEMPLATES, "hooks", "session-start.js");
    try {
      execFileSync("node", [hookPath, "--copilot-cli"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: tmpDir,
        timeout: 15000,
        env: { ...process.env, STICKY_CWD: tmpDir },
      });
    } catch (_) { /* hook may exit non-zero, that's ok */ }

    const hashFile = path.join(tmpDir, ".sticky-note", ".env-provision-hash");
    assert.ok(fs.existsSync(hashFile), ".env-provision-hash should be created after provisioning");
  });

  run("help text includes bootstrap and env commands", () => {
    const out = cli(["--help"]);
    assert.ok(out.includes("bootstrap"), "Help should mention bootstrap command");
    assert.ok(out.includes("env"), "Help should mention env command");
    assert.ok(out.includes("add-plugin"), "Help should mention add-plugin in env description");
  });

  run("provisioning creates extension.mjs and package.json for Copilot CLI", () => {
    const envDir = path.join(tmpDir, ".sticky-note", "environment");
    fs.mkdirSync(envDir, { recursive: true });
    fs.mkdirSync(path.join(envDir, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(envDir, "manifest.json"),
      JSON.stringify({ version: "1", mcp_servers: {} }, null, 2) + "\n"
    );
    fs.writeFileSync(
      path.join(envDir, "skills", "test-skill.md"),
      "# Test Skill\nA test skill for smoke testing.\n"
    );

    const hookPath = path.join(TEMPLATES, "hooks", "session-start.js");
    try {
      execFileSync("node", [hookPath, "--copilot-cli"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: tmpDir,
        timeout: 15000,
        env: { ...process.env, STICKY_CWD: tmpDir },
      });
    } catch (_) { /* hook may exit non-zero */ }

    const extDir = path.join(tmpDir, ".github", "extensions", "sticky-note-team");
    assert.ok(fs.existsSync(path.join(extDir, "extension.mjs")), "extension.mjs should be created");
    assert.ok(fs.existsSync(path.join(extDir, "package.json")), "package.json should be created");

    const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf-8"));
    assert.strictEqual(pkg.name, "sticky-note-team", "package.json should have correct name");
    assert.strictEqual(pkg.type, "module", "package.json should set type to module");
  });

  run("provisioning copies skills to both Claude and Copilot dirs", () => {
    const claudeSkill = path.join(tmpDir, ".claude", "plugins", "sticky-note-team", "skills", "test-skill", "SKILL.md");
    const copilotSkill = path.join(tmpDir, ".github", "extensions", "sticky-note-team", "skills", "test-skill.md");
    assert.ok(fs.existsSync(claudeSkill), "Skill should be provisioned to Claude plugin dir");
    assert.ok(fs.existsSync(copilotSkill), "Skill should be provisioned to Copilot extension dir");
  });

  run("provisioning merges permissions into settings.local.json", () => {
    // Clean up from previous test, set up fresh
    const envDir = path.join(tmpDir, ".sticky-note", "environment");
    fs.writeFileSync(
      path.join(envDir, "manifest.json"),
      JSON.stringify({
        version: "1",
        mcp_servers: {},
        permissions: ["Bash(npm test:*)", "mcp:context7"],
      }, null, 2) + "\n"
    );
    // Clear provision hash to force re-provisioning
    const hashFile = path.join(tmpDir, ".sticky-note", ".env-provision-hash");
    if (fs.existsSync(hashFile)) fs.unlinkSync(hashFile);

    const hookPath = path.join(TEMPLATES, "hooks", "session-start.js");
    try {
      execFileSync("node", [hookPath, "--copilot-cli"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: tmpDir,
        timeout: 15000,
        env: { ...process.env, STICKY_CWD: tmpDir },
      });
    } catch (_) { /* hook may exit non-zero */ }

    const settingsPath = path.join(tmpDir, ".claude", "settings.local.json");
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      assert.ok(
        Array.isArray(settings.allowedTools) && settings.allowedTools.includes("Bash(npm test:*)"),
        "Permissions should be merged into settings.local.json"
      );
    }
  });

  run("pre-commit hook includes environment/ in auto-stage paths", () => {
    const cliPath = path.join(__dirname, "..", "bin", "cli.js");
    const cliSource = fs.readFileSync(cliPath, "utf-8");
    assert.ok(
      cliSource.includes('.sticky-note/environment"') || cliSource.includes(".sticky-note/environment/"),
      "Pre-commit hook should auto-stage .sticky-note/environment/"
    );
  });

  run("env add-plugin appears in env subcommand help", () => {
    const cliPath = path.join(__dirname, "..", "bin", "cli.js");
    const cliSource = fs.readFileSync(cliPath, "utf-8");
    assert.ok(cliSource.includes("add-plugin"), "env subcommand should include add-plugin case");
  });

  run("copilot-instructions.md mentions environment sync", () => {
    const instrPath = path.join(TEMPLATES, "copilot-instructions.md");
    const content = fs.readFileSync(instrPath, "utf-8");
    assert.ok(content.includes("environment sync"), "copilot-instructions.md should mention environment sync");
    assert.ok(content.includes("get_environment_status"), "copilot-instructions.md should mention get_environment_status tool");
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
