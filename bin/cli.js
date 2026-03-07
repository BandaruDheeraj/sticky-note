#!/usr/bin/env node

/**
 * sticky-note CLI — V2
 *
 * Commands:
 *   npx sticky-note init      Interactive setup, creates V2 hook files
 *   npx sticky-note update    Update scripts only
 *   npx sticky-note status    Diagnostic: threads, audit, hook health
 *   npx sticky-note threads   List open/stuck threads
 *   npx sticky-note audit     Query audit trail (JSONL)
 *   npx sticky-note gc        Manual tombstone sweep
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const VERSION = "2.0.0";

const HOOK_FILES = [
  "sticky_utils.py",
  "session-start.py",
  "session-end.py",
  "inject-context.py",
  "track-work.py",
  "on-stop.py",
  "on-error.py",
  "parse-transcript.py",
];

const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function print(msg) {
  process.stdout.write(msg + "\n");
}

function printBanner() {
  print("");
  print(`  📌 sticky-note v${VERSION}`);
  print("  Human-to-human handoff for AI coding assistants");
  print("");
}

function isGitRepo() {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasPython() {
  const cmds = ["python3", "python"];
  for (const cmd of cmds) {
    try {
      const version = execSync(`${cmd} --version`, { stdio: "pipe" })
        .toString()
        .trim();
      const match = version.match(/Python (\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major >= 3 && minor >= 10) {
          return { cmd, version };
        }
      }
    } catch {
      // try next
    }
  }
  return null;
}

function mkdirSafe(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf-8");
}

function makeExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Windows doesn't support chmod — that's fine
  }
}

function ask(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal !== undefined ? ` (${defaultVal})` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || (defaultVal !== undefined ? String(defaultVal) : ""));
    });
  });
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

// ──────────────────────────────────────────────
// Auto-detection
// ──────────────────────────────────────────────

function detectMcpServers() {
  const servers = new Map();

  const mcpJsonPath = path.join(process.cwd(), ".mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      const mcpServers = mcpJson.mcpServers || {};
      for (const [name, config] of Object.entries(mcpServers)) {
        const entry = {
          name,
          type: config.type || config.transport || "unknown",
          source: ".mcp.json",
        };
        if (config.command) entry.command = config.command;
        if (config.args) entry.args = config.args;
        if (config.env) entry.env = config.env;
        if (config.url) entry.url = config.url;
        servers.set(name, entry);
      }
    } catch { /* skip */ }
  }

  const localSettingsPath = path.join(process.cwd(), ".claude", "settings.local.json");
  if (fs.existsSync(localSettingsPath)) {
    try {
      const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, "utf-8"));
      const permissions = [
        ...(localSettings.allow || []),
        ...(localSettings.permissions?.allow || []),
      ];
      for (const perm of permissions) {
        if (typeof perm === "string" && perm.startsWith("mcp__")) {
          const serverName = perm.split("__")[1];
          if (serverName && !servers.has(serverName)) {
            servers.set(serverName, {
              name: serverName,
              type: "permission-detected",
              source: "settings.local.json",
            });
          }
        }
      }
    } catch { /* skip */ }
  }

  return Array.from(servers.values());
}

function detectSkills() {
  const skills = new Set();

  const localSettingsPath = path.join(process.cwd(), ".claude", "settings.local.json");
  if (fs.existsSync(localSettingsPath)) {
    try {
      const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, "utf-8"));
      const permissions = [
        ...(localSettings.allow || []),
        ...(localSettings.permissions?.allow || []),
      ];
      for (const perm of permissions) {
        if (typeof perm === "string") {
          const match = perm.match(/^Skill\(([^)]+)\)/);
          if (match) {
            skills.add(match[1]);
          }
        }
      }
    } catch { /* skip */ }
  }

  return Array.from(skills);
}

// ──────────────────────────────────────────────
// MCP Sync from Sticky Note
// ──────────────────────────────────────────────

async function syncMcpFromStickyNote(rl) {
  // V2: config is in a separate file
  const configPath = path.join(process.cwd(), ".sticky-note", "sticky-note-config.json");
  let config;
  if (fs.existsSync(configPath)) {
    config = readJsonSafe(configPath, {});
  } else {
    return;
  }

  const teamServers = config.mcp_servers || [];
  const provisionable = teamServers.filter(
    (s) => typeof s === "object" && (s.command || s.url)
  );
  if (provisionable.length === 0) return;

  const mcpJsonPath = path.join(process.cwd(), ".mcp.json");
  let existingServers = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      existingServers = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8")).mcpServers || {};
    } catch { /* skip */ }
  }

  const missing = provisionable.filter((s) => !existingServers[s.name]);
  if (missing.length === 0) return;

  print(`\n  🔄 Teammate MCP servers found in sticky-note:`);
  for (const s of missing) {
    const detail = s.command ? `${s.command} ${(s.args || []).join(" ")}` : s.url;
    print(`     • ${s.name} (${detail})`);
  }

  const answer = await ask(rl, "Add these to your .mcp.json?", "yes");
  if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
    print("  ⏭️  Skipped MCP sync");
    return;
  }

  let mcpJson = { mcpServers: {} };
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      mcpJson.mcpServers = mcpJson.mcpServers || {};
    } catch { /* start fresh */ }
  }

  for (const s of missing) {
    const config = { type: s.type || "stdio" };
    if (s.command) config.command = s.command;
    if (s.args) config.args = s.args;
    if (s.env) config.env = s.env;
    if (s.url) config.url = s.url;
    mcpJson.mcpServers[s.name] = config;
    print(`  ✅ Added ${s.name} to .mcp.json`);
  }

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
}

// ──────────────────────────────────────────────
// Python command helper for hook templates
// ──────────────────────────────────────────────

function patchPythonCmd(template, pythonCmd) {
  if (pythonCmd === "python3") {
    for (const [, hookArr] of Object.entries(template.hooks)) {
      for (const hookEntry of hookArr) {
        // Claude Code format: nested matcher/hooks with "command" key
        if (hookEntry.hooks) {
          for (const h of hookEntry.hooks) {
            if (h.command) h.command = h.command.replace("python ", "python3 ");
          }
        }
        // Copilot CLI format: flat objects with "bash"/"powershell" keys
        if (hookEntry.bash) hookEntry.bash = hookEntry.bash.replace("python ", "python3 ");
        if (hookEntry.powershell) hookEntry.powershell = hookEntry.powershell.replace("python ", "python3 ");
      }
    }
  }
  return template;
}

// ──────────────────────────────────────────────
// INIT command
// ──────────────────────────────────────────────

async function cmdInit() {
  printBanner();

  // Preflight checks
  print("  Preflight checks...");

  if (!isGitRepo()) {
    print("  ❌ Not a git repository. Run `git init` first.");
    process.exit(1);
  }
  print("  ✅ Git repository detected");

  const python = hasPython();
  if (!python) {
    print("  ❌ Python 3.10+ not found. Install Python and try again.");
    process.exit(1);
  }
  print(`  ✅ ${python.version} (${python.cmd})`);
  print("");

  // Auto-detect MCP servers and skills
  print("  🔍 Scanning for existing configuration...");
  const detectedMcp = detectMcpServers();
  const detectedSkills = detectSkills();

  if (detectedMcp.length > 0) {
    print(`  📡 Found ${detectedMcp.length} MCP server(s):`);
    for (const s of detectedMcp) {
      print(`     • ${s.name} (${s.source})`);
    }
  }
  if (detectedSkills.length > 0) {
    print(`  🧩 Found ${detectedSkills.length} skill(s):`);
    for (const s of detectedSkills) {
      print(`     • ${s}`);
    }
  }
  if (detectedMcp.length === 0 && detectedSkills.length === 0) {
    print("  ⏭️  No existing MCP servers or skills detected");
  }
  print("");

  // Interactive prompts
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  print("  📋 Team Configuration");
  print("  (Press Enter to accept detected defaults)\n");

  const mcpDefault = detectedMcp.map((s) => s.name).join(", ");
  const mcpServersRaw = await ask(
    rl,
    "MCP servers (comma-separated)",
    mcpDefault || ""
  );
  const conventionsRaw = await ask(
    rl,
    "Team conventions (comma-separated)",
    ""
  );
  const staleDays = await ask(rl, "Stale thread age in days", "14");

  // Sync MCP servers from teammate's sticky-note config
  await syncMcpFromStickyNote(rl);

  rl.close();

  // Build MCP server list: prefer detected objects, fall back to names
  const mcpNames = mcpServersRaw
    ? mcpServersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const mcpServers = mcpNames.map((name) => {
    const detected = detectedMcp.find((d) => d.name === name);
    return detected || { name, source: "manual" };
  });

  const skills = [...detectedSkills];

  const conventions = conventionsRaw
    ? conventionsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const staleDaysNum = parseInt(staleDays, 10) || 14;

  print("\n  📁 Creating files...\n");

  // Create directories
  const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
  const githubHooksDir = path.join(process.cwd(), ".github", "hooks");
  const stickyNoteDir = path.join(process.cwd(), ".sticky-note");
  mkdirSafe(claudeHooksDir);
  mkdirSafe(githubHooksDir);
  mkdirSafe(stickyNoteDir);

  // Copy hook scripts
  for (const file of HOOK_FILES) {
    const src = path.join(TEMPLATES_DIR, "hooks", file);
    const dest = path.join(claudeHooksDir, file);
    copyFile(src, dest);
    makeExecutable(dest);
    print(`  ✅ .claude/hooks/${file}`);
  }

  // Create settings.json (Claude Code)
  const settingsTemplate = patchPythonCmd(
    JSON.parse(readTemplate("settings.json")),
    python.cmd
  );
  const settingsDest = path.join(process.cwd(), ".claude", "settings.json");
  fs.writeFileSync(settingsDest, JSON.stringify(settingsTemplate, null, 2) + "\n");
  print("  ✅ .claude/settings.json");

  // Create hooks.json (Copilot CLI)
  const hooksTemplate = patchPythonCmd(
    JSON.parse(readTemplate("hooks.json")),
    python.cmd
  );
  const hooksDest = path.join(githubHooksDir, "hooks.json");
  fs.writeFileSync(hooksDest, JSON.stringify(hooksTemplate, null, 2) + "\n");
  print("  ✅ .github/hooks/hooks.json");

  // Create sticky-note.json (V2 — no audit array)
  const memoryDest = path.join(stickyNoteDir, "sticky-note.json");
  if (!fs.existsSync(memoryDest)) {
    const memoryTemplate = JSON.parse(readTemplate("sticky-note.json"));
    fs.writeFileSync(memoryDest, JSON.stringify(memoryTemplate, null, 2) + "\n");
  }
  print("  ✅ .sticky-note/sticky-note.json (v2)");

  // Create sticky-note-config.json
  const configDest = path.join(stickyNoteDir, "sticky-note-config.json");
  if (!fs.existsSync(configDest)) {
    const configTemplate = JSON.parse(readTemplate("sticky-note-config.json"));
    configTemplate.mcp_servers = mcpServers;
    configTemplate.skills = skills;
    configTemplate.conventions = conventions;
    configTemplate.stale_days = staleDaysNum;
    configTemplate.hook_version = VERSION;
    fs.writeFileSync(configDest, JSON.stringify(configTemplate, null, 2) + "\n");
  } else {
    // Update existing config with new settings
    const existing = readJsonSafe(configDest, {});
    existing.mcp_servers = mcpServers;
    existing.skills = skills;
    existing.conventions = conventions;
    existing.stale_days = staleDaysNum;
    existing.hook_version = VERSION;
    fs.writeFileSync(configDest, JSON.stringify(existing, null, 2) + "\n");
  }
  print("  ✅ .sticky-note/sticky-note-config.json");

  // Update .gitignore
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  const ignoreAdditions = fs
    .readFileSync(path.join(TEMPLATES_DIR, "gitignore-additions.txt"), "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"));

  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  }

  const missingEntries = ignoreAdditions.filter((e) => !gitignoreContent.includes(e.trim()));
  if (missingEntries.length > 0) {
    const block = "\n# Sticky Note\n" + missingEntries.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, block);
    print("  ✅ .gitignore updated");
  } else {
    print("  ⏭️  .gitignore already configured");
  }

  // Add .gitattributes merge strategy
  const gitattrsPath = path.join(process.cwd(), ".gitattributes");
  const mergeRule = ".sticky-note/sticky-note.json merge=union";
  let gitattrsContent = "";
  if (fs.existsSync(gitattrsPath)) {
    gitattrsContent = fs.readFileSync(gitattrsPath, "utf-8");
  }
  if (!gitattrsContent.includes(mergeRule)) {
    const addition = gitattrsContent.endsWith("\n") || gitattrsContent === ""
      ? `\n# Sticky Note - auto-merge threads from both sides\n${mergeRule}\n`
      : `\n\n# Sticky Note - auto-merge threads from both sides\n${mergeRule}\n`;
    fs.appendFileSync(gitattrsPath, addition);
    print("  ✅ .gitattributes updated (merge=union)");
  } else {
    print("  ⏭️  .gitattributes already configured");
  }

  // Deploy AI instruction files (CLAUDE.md + .github/copilot-instructions.md)
  const claudeMdDest = path.join(process.cwd(), "CLAUDE.md");
  if (!fs.existsSync(claudeMdDest)) {
    copyFile(path.join(TEMPLATES_DIR, "CLAUDE.md"), claudeMdDest);
    print("  ✅ CLAUDE.md (AI instructions for Claude Code)");
  } else {
    print("  ⏭️  CLAUDE.md already exists");
  }

  const copilotInstrDest = path.join(githubHooksDir, "..", "copilot-instructions.md");
  if (!fs.existsSync(copilotInstrDest)) {
    copyFile(path.join(TEMPLATES_DIR, "copilot-instructions.md"), copilotInstrDest);
    print("  ✅ .github/copilot-instructions.md (AI instructions for Copilot CLI)");
  } else {
    print("  ⏭️  .github/copilot-instructions.md already exists");
  }

  // Install Codex wrapper if --codex flag
  const wantCodex = process.argv.includes("--codex");
  if (wantCodex) {
    const codexSrc = path.join(TEMPLATES_DIR, "hooks", "sticky-codex.sh");
    const codexDest = path.join(claudeHooksDir, "sticky-codex.sh");
    copyFile(codexSrc, codexDest);
    makeExecutable(codexDest);
    print("  ✅ .claude/hooks/sticky-codex.sh");
    print(`\n  🔧 Codex wrapper installed!`);
    print(`  Add this alias to your shell profile:`);
    print(`    alias sticky-codex="${codexDest}"`);
    print("");
  }

  // Done!
  print("\n  ✨ Sticky Note V2 initialized!\n");
  print("  Next steps:");
  print("  ┌──────────────────────────────────────────────────────────────┐");
  print("  │  git add .claude .github .sticky-note .gitignore .gitattributes CLAUDE.md  │");
  print("  │  git commit -m \"feat: add sticky-note v2 hooks\"                  │");
  print("  │  git push                                                        │");
  print("  └──────────────────────────────────────────────────────────────┘");
  print("");
  print("  Teammates just need to `git pull` — no extra setup.");
  print("");
}

// ──────────────────────────────────────────────
// UPDATE command
// ──────────────────────────────────────────────

function cmdUpdate() {
  printBanner();

  const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
  const stickyDir = path.join(process.cwd(), ".sticky-note");
  if (!fs.existsSync(claudeHooksDir)) {
    print("  ❌ No .claude/hooks/ directory found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  const python = hasPython();
  if (!python) {
    print("  ❌ Python 3.10+ not found.");
    process.exit(1);
  }

  print("  Updating hook scripts...\n");

  for (const file of HOOK_FILES) {
    const src = path.join(TEMPLATES_DIR, "hooks", file);
    const dest = path.join(claudeHooksDir, file);
    copyFile(src, dest);
    makeExecutable(dest);
    print(`  ✅ .claude/hooks/${file}`);
  }

  // Update settings.json hooks
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settingsTemplate = patchPythonCmd(
      JSON.parse(readTemplate("settings.json")),
      python.cmd
    );
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    existing.hooks = settingsTemplate.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
    print("  ✅ .claude/settings.json (hooks updated)");
  }

  // Update hooks.json
  const hooksPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  if (fs.existsSync(hooksPath)) {
    const hooksTemplate = patchPythonCmd(
      JSON.parse(readTemplate("hooks.json")),
      python.cmd
    );
    fs.writeFileSync(hooksPath, JSON.stringify(hooksTemplate, null, 2) + "\n");
    print("  ✅ .github/hooks/hooks.json (updated)");
  }

  // Update hook_version in config
  const configPath = path.join(stickyDir, "sticky-note-config.json");
  if (fs.existsSync(configPath)) {
    const config = readJsonSafe(configPath, {});
    config.hook_version = VERSION;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  print(`\n  ✨ Scripts updated to v${VERSION}`);
  print("  ⚠️  Thread data was NOT modified.\n");
}

// ──────────────────────────────────────────────
// STATUS command
// ──────────────────────────────────────────────

function cmdStatus() {
  printBanner();

  const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
  const hooksExist = fs.existsSync(claudeHooksDir);
  const stickyDir = path.join(process.cwd(), ".sticky-note");

  print("  📊 Diagnostic Report\n");

  // Hook health
  print("  Hook Scripts:");
  if (hooksExist) {
    for (const file of HOOK_FILES) {
      const filePath = path.join(claudeHooksDir, file);
      if (fs.existsSync(filePath)) {
        print(`    ✅ ${file}`);
      } else {
        print(`    ❌ ${file} (missing)`);
      }
    }
  } else {
    print("    ❌ .claude/hooks/ directory not found");
  }

  // Config files
  print("\n  Config Files:");
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const hooksJsonPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  print(
    `    ${fs.existsSync(settingsPath) ? "✅" : "❌"} .claude/settings.json`
  );
  print(
    `    ${fs.existsSync(hooksJsonPath) ? "✅" : "❌"} .github/hooks/hooks.json`
  );

  // Sticky Note data — V2 format
  const memoryPath = path.join(stickyDir, "sticky-note.json");
  const configPath = path.join(stickyDir, "sticky-note-config.json");
  const auditPath = path.join(stickyDir, "sticky-note-audit.jsonl");
  const presencePath = path.join(stickyDir, ".sticky-presence.json");

  print("\n  Sticky Note Data:");
  if (fs.existsSync(memoryPath)) {
    try {
      const memory = JSON.parse(fs.readFileSync(memoryPath, "utf-8"));
      const threads = memory.threads || [];
      const schemaVersion = memory.version || "2";

      const openThreads = threads.filter((t) => t.status === "open").length;
      const stuckThreads = threads.filter((t) => t.status === "stuck").length;
      const staleThreads = threads.filter((t) => t.status === "stale").length;
      const closedThreads = threads.filter((t) => t.status === "closed").length;
      const expiredThreads = threads.filter((t) => t.status === "expired").length;

      print(`    ✅ sticky-note.json (schema v${schemaVersion})`);
      print(`    📝 Threads: ${threads.length} total`);
      print(`       open=${openThreads}  stuck=${stuckThreads}  stale=${staleThreads}  closed=${closedThreads}  expired=${expiredThreads}`);
    } catch {
      print("    ❌ sticky-note.json (invalid JSON)");
    }
  } else {
    print("    ❌ sticky-note.json not found");
  }

  // Config
  if (fs.existsSync(configPath)) {
    const config = readJsonSafe(configPath, {});
    print(`    ✅ sticky-note-config.json (v${config.hook_version || "?"})`);
    if (config.mcp_servers && config.mcp_servers.length > 0) {
      print(`    🔌 MCP servers: ${config.mcp_servers.length} configured`);
    }
    if (config.conventions && config.conventions.length > 0) {
      print(`    📋 Conventions: ${config.conventions.length} defined`);
    }
    print(`    ⏰ Stale after: ${config.stale_days ?? "?"} days`);
  } else {
    print("    ❌ sticky-note-config.json not found");
  }

  // Audit
  const auditCount = countJsonlLines(auditPath);
  if (auditCount > 0) {
    print(`    ✅ sticky-note-audit.jsonl (${auditCount} entries)`);
  } else {
    print(`    ⏭️  sticky-note-audit.jsonl (empty or missing)`);
  }

  // Presence
  if (fs.existsSync(presencePath)) {
    const presence = readJsonSafe(presencePath, {});
    const users = Object.keys(presence);
    print(`    👥 Presence: ${users.length > 0 ? users.join(", ") : "no active users"}`);
  }

  // Python check
  print("\n  Environment:");
  const python = hasPython();
  if (python) {
    print(`    ✅ ${python.version} (${python.cmd})`);
  } else {
    print("    ❌ Python 3.10+ not found");
  }

  print(
    `    ${isGitRepo() ? "✅" : "❌"} Git repository`
  );

  print("");
}

// ──────────────────────────────────────────────
// THREADS command
// ──────────────────────────────────────────────

function cmdThreads() {
  const memoryPath = path.join(process.cwd(), ".sticky-note", "sticky-note.json");
  if (!fs.existsSync(memoryPath)) {
    print("  ❌ No sticky-note.json found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  const memory = readJsonSafe(memoryPath, { threads: [] });
  const threads = memory.threads || [];

  // Filter: show open, stuck, closed (not expired)
  const live = threads.filter((t) => ["open", "stuck", "closed", "stale"].includes(t.status));

  if (live.length === 0) {
    print("  No active threads.");
    return;
  }

  print("");
  for (const t of live) {
    const icon = t.status === "stuck" ? "🔴" : t.status === "open" ? "🟢" : t.status === "stale" ? "🟡" : "⚪";
    const user = t.user || t.author || "?";
    const files = (t.files_touched || []).slice(0, 3).join(", ");
    const branch = t.branch ? ` (${t.branch})` : "";
    const note = t.last_note ? ` — ${t.last_note.slice(0, 60)}` : "";

    print(`  ${icon} [${t.status}] ${user}${branch}: ${files}${note}`);
    if (t.narrative) {
      print(`     📖 ${t.narrative.slice(0, 100)}`);
    }
    if (t.failed_approaches && t.failed_approaches.length > 0) {
      print(`     ⚠️  ${t.failed_approaches.length} failed approach(es)`);
    }
  }
  print("");
}

// ──────────────────────────────────────────────
// RESUME command
// ──────────────────────────────────────────────

function cmdResume() {
  const args = process.argv.slice(3);
  const stickyDir = path.join(process.cwd(), ".sticky-note");
  const memoryPath = path.join(stickyDir, "sticky-note.json");
  const resumePath = path.join(stickyDir, ".sticky-resume");

  if (!fs.existsSync(memoryPath)) {
    print("  ❌ No sticky-note.json found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  // resume --clear: remove the resume signal
  if (args.includes("--clear")) {
    if (fs.existsSync(resumePath)) {
      fs.unlinkSync(resumePath);
      print("  ✅ Resume signal cleared.");
    } else {
      print("  ℹ️  No active resume signal.");
    }
    return;
  }

  // resume --list: show resumable threads
  if (args.includes("--list") || args.length === 0) {
    const memory = readJsonSafe(memoryPath, { threads: [] });
    const threads = memory.threads || [];
    const resumable = threads.filter((t) =>
      ["closed", "stuck", "open", "stale"].includes(t.status)
    );

    if (resumable.length === 0) {
      print("  No resumable threads.");
      return;
    }

    // Show current resume signal if active
    if (fs.existsSync(resumePath)) {
      const activeId = fs.readFileSync(resumePath, "utf-8").trim();
      print(`\n  🔄 Active resume: ${activeId}\n`);
    }

    print("\n  Resumable threads:\n");
    for (const t of resumable) {
      const icon = t.status === "stuck" ? "🔴" : t.status === "open" ? "🟢" : t.status === "stale" ? "🟡" : "⚪";
      const user = t.user || t.author || "?";
      const files = (t.files_touched || []).slice(0, 3).join(", ");
      const branch = t.branch ? ` (${t.branch})` : "";
      const note = t.last_note ? ` — ${t.last_note.slice(0, 60)}` : "";
      const shortId = t.id.slice(0, 8);

      print(`  ${icon} ${shortId} [${t.status}] ${user}${branch}: ${files}${note}`);
    }
    print(`\n  Usage: npx sticky-note resume <thread-id>`);
    print("  You can use the first 8 characters of the ID.\n");
    return;
  }

  // resume <thread-id>: set the resume signal
  const threadId = args[0];
  const memory = readJsonSafe(memoryPath, { threads: [] });
  const threads = memory.threads || [];

  // Support partial ID matching (first 8 chars)
  const match = threads.find((t) =>
    t.id === threadId || t.id.startsWith(threadId)
  );

  if (!match) {
    print(`  ❌ No thread found matching "${threadId}".`);
    print("  Run `npx sticky-note resume --list` to see available threads.");
    process.exit(1);
  }

  if (match.status === "expired") {
    print(`  ❌ Thread ${match.id.slice(0, 8)} is expired and cannot be resumed.`);
    process.exit(1);
  }

  // Write the resume signal file
  fs.writeFileSync(resumePath, match.id + "\n");

  const icon = match.status === "stuck" ? "🔴" : match.status === "open" ? "🟢" : "⚪";
  print(`\n  ✅ Resume signal set for thread ${match.id.slice(0, 8)}`);
  print(`  ${icon} [${match.status}] ${match.user || "?"} (${match.branch || "no branch"})`);
  if (match.last_note) {
    print(`     ${match.last_note.slice(0, 80)}`);
  }
  print(`\n  Next AI session will pick up this thread automatically.`);
  print("  Run `npx sticky-note resume --clear` to cancel.\n");
}

// ──────────────────────────────────────────────
// AUDIT command
// ──────────────────────────────────────────────

function cmdAudit() {
  const args = process.argv.slice(3);
  const auditPath = path.join(process.cwd(), ".sticky-note", "sticky-note-audit.jsonl");

  if (!fs.existsSync(auditPath)) {
    print("  ❌ No sticky-note-audit.jsonl found.");
    process.exit(1);
  }

  // Parse flags
  let filterFile = null;
  let filterUser = null;
  let filterSince = null;
  let filterSession = null;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--file":
        filterFile = args[++i];
        break;
      case "--user":
        filterUser = args[++i];
        break;
      case "--since":
        filterSince = args[++i];
        break;
      case "--session":
        filterSession = args[++i];
        break;
      case "--limit":
        limit = parseInt(args[++i], 10) || 50;
        break;
    }
  }

  // Read and filter JSONL line by line
  const content = fs.readFileSync(auditPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const matches = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (filterFile && !(entry.file || "").includes(filterFile)) continue;
    if (filterUser && entry.user !== filterUser) continue;
    if (filterSession && entry.session_id !== filterSession) continue;
    if (filterSince) {
      const ts = entry.ts || entry.timestamp || "";
      if (ts < filterSince) continue;
    }

    matches.push(entry);
  }

  // Show most recent first, capped
  const display = matches.slice(-limit).reverse();

  if (display.length === 0) {
    print("  No matching audit entries.");
    return;
  }

  print(`\n  ${display.length} matching entries (of ${matches.length} total):\n`);
  for (const e of display) {
    const ts = (e.ts || e.timestamp || "").slice(0, 16);
    const user = e.user || "?";
    const type = e.type || "?";
    const file = e.file ? ` ${e.file}` : "";
    const tool = e.tool ? ` [${e.tool}]` : "";
    print(`  ${ts}  ${user}  ${type}${tool}${file}`);
  }
  print("");
}

// ──────────────────────────────────────────────
// GC command (manual tombstone sweep)
// ──────────────────────────────────────────────

function cmdGc() {
  printBanner();

  const stickyDir = path.join(process.cwd(), ".sticky-note");
  const memoryPath = path.join(stickyDir, "sticky-note.json");
  const configPath = path.join(stickyDir, "sticky-note-config.json");

  if (!fs.existsSync(memoryPath)) {
    print("  ❌ No sticky-note.json found.");
    process.exit(1);
  }

  const memory = readJsonSafe(memoryPath, { version: "2", threads: [] });
  const config = readJsonSafe(configPath, { stale_days: 14 });
  const staleDays = config.stale_days ?? 14;
  const threads = memory.threads || [];
  const now = new Date();

  let tombstoned = 0;
  for (const thread of threads) {
    if (thread.status !== "closed") continue;

    const tsField = thread.last_activity_at || thread.closed_at || thread.updated_at || "";
    if (!tsField) continue;

    const ts = new Date(tsField);
    const daysAgo = (now - ts) / (1000 * 60 * 60 * 24);

    if (daysAgo >= staleDays) {
      const id = thread.id;
      const user = thread.user || thread.author || "unknown";
      const closedAt = thread.closed_at || tsField;

      // Strip payload
      const keys = Object.keys(thread);
      for (const k of keys) delete thread[k];
      thread.id = id;
      thread.status = "expired";
      thread.user = user;
      thread.closed_at = closedAt;
      tombstoned++;
    }
  }

  if (tombstoned > 0) {
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2) + "\n");
    print(`  🗑️  Tombstoned ${tombstoned} closed thread(s) older than ${staleDays} days.`);
  } else {
    print(`  ✅ No threads to tombstone (stale_days=${staleDays}).`);
  }
  print("");
}

// ──────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      await cmdInit();
      break;
    case "update":
      cmdUpdate();
      break;
    case "status":
      cmdStatus();
      break;
    case "threads":
      cmdThreads();
      break;
    case "resume":
      cmdResume();
      break;
    case "audit":
      cmdAudit();
      break;
    case "gc":
      cmdGc();
      break;
    case "--version":
    case "-v":
      print(`sticky-note v${VERSION}`);
      break;
    case "--help":
    case "-h":
    case undefined:
      printBanner();
      print("  Usage: npx sticky-note <command>\n");
      print("  Commands:");
      print("    init      Interactive setup — creates V2 hooks and config");
      print("    update    Update hook scripts (preserves data)");
      print("    status    Diagnostic report: threads, audit, health");
      print("    threads   List open/stuck threads");
      print("    resume    Resume a previous thread (--list, --clear, <id>)");
      print("    audit     Query audit trail (--file, --user, --since, --session)");
      print("    gc        Manual tombstone sweep for expired threads");
      print("");
      print("  Options:");
      print("    --version  Show version");
      print("    --help     Show this help");
      print("");
      break;
    default:
      print(`  ❌ Unknown command: ${command}`);
      print(`  Run 'npx sticky-note --help' for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
