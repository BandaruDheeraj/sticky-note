#!/usr/bin/env node

/**
 * sticky-note CLI
 *
 * Commands:
 *   npx sticky-note init      Interactive setup, creates all hook files
 *   npx sticky-note update    Update scripts only, never touches data
 *   npx sticky-note status    Diagnostic: threads, audit count, hook health
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execSync } = require("child_process");

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const VERSION = "1.0.0";

const HOOK_FILES = [
  "session-start.py",
  "session-end.py",
  "inject-context.py",
  "track-work.py",
  "on-stop.py",
  "on-error.py",
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
  print("  📌 sticky-note v" + VERSION);
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

// ──────────────────────────────────────────────
// Auto-detection
// ──────────────────────────────────────────────

function detectMcpServers() {
  const servers = new Map();

  // 1. Check .mcp.json (standard MCP config)
  const mcpJsonPath = path.join(process.cwd(), ".mcp.json");
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      const mcpServers = mcpJson.mcpServers || {};
      for (const [name, config] of Object.entries(mcpServers)) {
        servers.set(name, {
          name,
          type: config.type || config.transport || "unknown",
          url: config.url || "",
          source: ".mcp.json",
        });
      }
    } catch { /* skip */ }
  }

  // 2. Check .claude/settings.local.json for mcp__ permissions
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

  // Check .claude/settings.local.json for Skill() permissions
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
  const staleDays = await ask(rl, "Stale thread age in days", "3");

  rl.close();

  // Build MCP server list: prefer detected objects, fall back to names
  const mcpNames = mcpServersRaw
    ? mcpServersRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const mcpServers = mcpNames.map((name) => {
    const detected = detectedMcp.find((d) => d.name === name);
    return detected || { name, source: "manual" };
  });

  // Build skills list: merge detected + any extras from conventions
  const skills = [...detectedSkills];

  const conventions = conventionsRaw
    ? conventionsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const staleDaysNum = parseInt(staleDays, 10) || 3;

  print("\n  📁 Creating files...\n");

  // Create directories
  const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
  const githubHooksDir = path.join(process.cwd(), ".github", "hooks");
  mkdirSafe(claudeHooksDir);
  mkdirSafe(githubHooksDir);

  // Copy hook scripts
  for (const file of HOOK_FILES) {
    const src = path.join(TEMPLATES_DIR, "hooks", file);
    const dest = path.join(claudeHooksDir, file);
    copyFile(src, dest);
    makeExecutable(dest);
    print(`  ✅ .claude/hooks/${file}`);
  }

  // Create settings.json (Claude Code)
  const settingsTemplate = JSON.parse(readTemplate("settings.json"));
  // Update python command if python3 is the available command
  if (python.cmd === "python3") {
    for (const [, hookArr] of Object.entries(settingsTemplate.hooks)) {
      for (const hookEntry of hookArr) {
        for (const h of hookEntry.hooks) {
          h.command = h.command.replace("python ", "python3 ");
        }
      }
    }
  }
  const settingsDest = path.join(process.cwd(), ".claude", "settings.json");
  fs.writeFileSync(settingsDest, JSON.stringify(settingsTemplate, null, 2) + "\n");
  print("  ✅ .claude/settings.json");

  // Create hooks.json (Copilot CLI)
  const hooksTemplate = JSON.parse(readTemplate("hooks.json"));
  if (python.cmd === "python3") {
    for (const [, hookArr] of Object.entries(hooksTemplate.hooks)) {
      for (const hookEntry of hookArr) {
        for (const h of hookEntry.hooks) {
          h.command = h.command.replace("python ", "python3 ");
        }
      }
    }
  }
  const hooksDest = path.join(githubHooksDir, "hooks.json");
  fs.writeFileSync(hooksDest, JSON.stringify(hooksTemplate, null, 2) + "\n");
  print("  ✅ .github/hooks/hooks.json");

  // Create sticky-note.json
  const memoryTemplate = JSON.parse(readTemplate("sticky-note.json"));
  memoryTemplate.config.mcp_servers = mcpServers;
  memoryTemplate.config.skills = skills;
  memoryTemplate.config.conventions = conventions;
  memoryTemplate.config.stale_days = staleDaysNum;
  memoryTemplate.config.hook_version = VERSION;

  const memoryDest = path.join(process.cwd(), ".claude", "sticky-note.json");
  fs.writeFileSync(memoryDest, JSON.stringify(memoryTemplate, null, 2) + "\n");
  print("  ✅ .claude/sticky-note.json");

  // Update .gitignore
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  const ignoreEntry = ".claude/settings.local.json";
  let gitignoreContent = "";
  if (fs.existsSync(gitignorePath)) {
    gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
  }
  if (!gitignoreContent.includes(ignoreEntry)) {
    const addition = gitignoreContent.endsWith("\n") || gitignoreContent === ""
      ? `\n# Sticky Note - local overrides\n${ignoreEntry}\n`
      : `\n\n# Sticky Note - local overrides\n${ignoreEntry}\n`;
    fs.appendFileSync(gitignorePath, addition);
    print("  ✅ .gitignore updated");
  } else {
    print("  ⏭️  .gitignore already configured");
  }

  // Add .gitattributes merge strategy for sticky-note.json
  const gitattrsPath = path.join(process.cwd(), ".gitattributes");
  const mergeRule = ".claude/sticky-note.json merge=union";
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

  // Done!
  print("\n  ✨ Sticky Note initialized!\n");
  print("  Next steps:");
  print("  ┌──────────────────────────────────────────────────────────┐");
  print("  │  git add .claude .github .gitignore .gitattributes      │");
  print("  │  git commit -m \"feat: add sticky-note hooks\"             │");
  print("  │  git push                                                │");
  print("  └──────────────────────────────────────────────────────────┘");
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

  // Update settings.json hooks (preserve any custom settings)
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settingsTemplate = JSON.parse(readTemplate("settings.json"));
    if (python.cmd === "python3") {
      for (const [, hookArr] of Object.entries(settingsTemplate.hooks)) {
        for (const hookEntry of hookArr) {
          for (const h of hookEntry.hooks) {
            h.command = h.command.replace("python ", "python3 ");
          }
        }
      }
    }
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    existing.hooks = settingsTemplate.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
    print("  ✅ .claude/settings.json (hooks updated)");
  }

  // Update hooks.json
  const hooksPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  if (fs.existsSync(hooksPath)) {
    const hooksTemplate = JSON.parse(readTemplate("hooks.json"));
    if (python.cmd === "python3") {
      for (const [, hookArr] of Object.entries(hooksTemplate.hooks)) {
        for (const hookEntry of hookArr) {
          for (const h of hookEntry.hooks) {
            h.command = h.command.replace("python ", "python3 ");
          }
        }
      }
    }
    fs.writeFileSync(hooksPath, JSON.stringify(hooksTemplate, null, 2) + "\n");
    print("  ✅ .github/hooks/hooks.json (updated)");
  }

  // Update hook_version in sticky-note.json
  const memoryPath = path.join(process.cwd(), ".claude", "sticky-note.json");
  if (fs.existsSync(memoryPath)) {
    const memory = JSON.parse(fs.readFileSync(memoryPath, "utf-8"));
    memory.config = memory.config || {};
    memory.config.hook_version = VERSION;
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2) + "\n");
  }

  print("\n  ✨ Scripts updated to v" + VERSION);
  print("  ⚠️  Data in sticky-note.json was NOT modified.\n");
}

// ──────────────────────────────────────────────
// STATUS command
// ──────────────────────────────────────────────

function cmdStatus() {
  printBanner();

  // Check hooks directory
  const claudeHooksDir = path.join(process.cwd(), ".claude", "hooks");
  const hooksExist = fs.existsSync(claudeHooksDir);

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

  // Settings files
  print("\n  Config Files:");
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const hooksJsonPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  print(
    `    ${fs.existsSync(settingsPath) ? "✅" : "❌"} .claude/settings.json`
  );
  print(
    `    ${fs.existsSync(hooksJsonPath) ? "✅" : "❌"} .github/hooks/hooks.json`
  );

  // Sticky Note data
  const memoryPath = path.join(process.cwd(), ".claude", "sticky-note.json");
  print("\n  Sticky Note Data:");
  if (fs.existsSync(memoryPath)) {
    try {
      const memory = JSON.parse(fs.readFileSync(memoryPath, "utf-8"));
      const threads = memory.threads || [];
      const audit = memory.audit || [];
      const config = memory.config || {};

      const openThreads = threads.filter((t) => t.status === "open").length;
      const stuckThreads = threads.filter((t) => t.status === "stuck").length;
      const staleThreads = threads.filter((t) => t.status === "stale").length;
      const closedThreads = threads.filter((t) => t.status === "closed").length;

      print(`    ✅ sticky-note.json (v${config.hook_version || "?"})`);
      print(`    📝 Threads: ${threads.length} total`);
      print(`       open=${openThreads}  stuck=${stuckThreads}  stale=${staleThreads}  closed=${closedThreads}`);
      print(`    📋 Audit entries: ${audit.length} / 500`);

      if (config.mcp_servers && config.mcp_servers.length > 0) {
        print(`    🔌 MCP servers: ${config.mcp_servers.length} configured`);
      }
      if (config.conventions && config.conventions.length > 0) {
        print(`    📋 Conventions: ${config.conventions.length} defined`);
      }
      print(`    ⏰ Stale after: ${config.stale_days || "?"} days`);
    } catch {
      print("    ❌ sticky-note.json (invalid JSON)");
    }
  } else {
    print("    ❌ sticky-note.json not found");
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
// Main
// ──────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      cmdInit();
      break;
    case "update":
      cmdUpdate();
      break;
    case "status":
      cmdStatus();
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
      print("    init      Interactive setup — creates hooks and config");
      print("    update    Update hook scripts only (preserves data)");
      print("    status    Diagnostic report: threads, audit, health");
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

main();
