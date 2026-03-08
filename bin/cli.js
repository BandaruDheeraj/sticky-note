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

const VERSION = "2.5.0";

const HOOK_FILES = [
  "sticky-utils.js",
  "session-start.js",
  "session-end.js",
  "inject-context.js",
  "track-work.js",
  "on-stop.js",
  "on-error.js",
  "parse-transcript.js",
  "pre-tool-use.js",
  "sticky-git-notes.js",
  "sticky-attribution.js",
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

function parseIntOr(str, fallback) {
  const n = parseInt(str, 10);
  return Number.isNaN(n) ? fallback : n;
}

const SECTION_START = "<!-- sticky-note:start";
const SECTION_END = "<!-- sticky-note:end -->";

/**
 * Update the sticky-note section in a deployed instruction file.
 * If markers exist, replaces content between them.
 * If no markers but a known sticky-note heading exists, replaces from that heading onward.
 * If neither, appends the template content.
 * Returns true if the file was modified.
 */
function updateInstructionSection(destPath, templateContent, heading) {
  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, templateContent);
    return true;
  }

  const existing = fs.readFileSync(destPath, "utf-8");
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace between markers (inclusive)
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + SECTION_END.length);
    fs.writeFileSync(destPath, before + templateContent.trim() + after);
  } else if (heading && existing.includes(heading)) {
    // Migration: old file without markers — replace from known heading onward
    const headingIdx = existing.indexOf(heading);
    const before = existing.slice(0, headingIdx);
    fs.writeFileSync(destPath, before + templateContent);
  } else {
    // No markers, no known heading — append with a blank line separator
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(destPath, existing + sep + templateContent);
  }
  return true;
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
    print(`  [OK] Added ${s.name} to .mcp.json`);
  }

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
}

// ──────────────────────────────────────────────
// INIT command
// ──────────────────────────────────────────────

async function cmdInit() {
  printBanner();

  // Preflight checks
  print("  Preflight checks...");

  if (!isGitRepo()) {
    print("  [ERR] Not a git repository. Run `git init` first.");
    process.exit(1);
  }
  print("  [OK] Git repository detected");
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
  const injectTokenBudget = await ask(rl, "Inject context token budget", "1000");

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
  const staleDaysResolved = parseIntOr(staleDays, 14);
  const injectTokenBudgetResolved = parseIntOr(injectTokenBudget, 1000);

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
    print(`  [OK] .claude/hooks/${file}`);
  }

  // Create settings.json (Claude Code)
  const settingsTemplate = JSON.parse(readTemplate("settings.json"));
  const settingsDest = path.join(process.cwd(), ".claude", "settings.json");
  fs.writeFileSync(settingsDest, JSON.stringify(settingsTemplate, null, 2) + "\n");
  print("  [OK] .claude/settings.json");

  // Create hooks.json (Copilot CLI)
  const hooksTemplate = JSON.parse(readTemplate("hooks.json"));
  const hooksDest = path.join(githubHooksDir, "hooks.json");
  fs.writeFileSync(hooksDest, JSON.stringify(hooksTemplate, null, 2) + "\n");
  print("  [OK] .github/hooks/hooks.json");

  // Create sticky-note.json (V2 — no audit array)
  const memoryDest = path.join(stickyNoteDir, "sticky-note.json");
  if (!fs.existsSync(memoryDest)) {
    const memoryTemplate = JSON.parse(readTemplate("sticky-note.json"));
    fs.writeFileSync(memoryDest, JSON.stringify(memoryTemplate, null, 2) + "\n");
  }
  print("  [OK] .sticky-note/sticky-note.json (v2)");

  // Create per-user audit and presence directories
  const auditDir = path.join(stickyNoteDir, "audit");
  const presenceDir = path.join(stickyNoteDir, "presence");
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(presenceDir, { recursive: true });
  print("  [OK] .sticky-note/audit/ (per-user audit logs)");
  print("  [OK] .sticky-note/presence/ (per-user presence)");

  // Migrate legacy single-file audit/presence if they exist
  const legacyAuditPath = path.join(stickyNoteDir, "sticky-note-audit.jsonl");
  const legacyPresencePath = path.join(stickyNoteDir, ".sticky-presence.json");
  if (fs.existsSync(legacyAuditPath)) {
    const user = process.env.USER || process.env.USERNAME || "unknown";
    const dest = path.join(auditDir, user + ".jsonl");
    if (fs.existsSync(dest)) {
      fs.appendFileSync(dest, fs.readFileSync(legacyAuditPath, "utf-8"));
    } else {
      fs.renameSync(legacyAuditPath, dest);
    }
    try { if (fs.existsSync(legacyAuditPath)) fs.unlinkSync(legacyAuditPath); } catch (_) {}
    print("  [OK] Migrated legacy audit log to audit/" + (process.env.USER || process.env.USERNAME || "unknown") + ".jsonl");
  }
  if (fs.existsSync(legacyPresencePath)) {
    const data = readJsonSafe(legacyPresencePath, {});
    for (const [u, info] of Object.entries(data)) {
      const dest = path.join(presenceDir, u + ".json");
      fs.writeFileSync(dest, JSON.stringify(info, null, 2) + "\n");
    }
    fs.unlinkSync(legacyPresencePath);
    print("  [OK] Migrated legacy presence to per-user files");
  }

  // Create sticky-note-config.json
  const configDest = path.join(stickyNoteDir, "sticky-note-config.json");
  if (!fs.existsSync(configDest)) {
    const configTemplate = JSON.parse(readTemplate("sticky-note-config.json"));
    configTemplate.mcp_servers = mcpServers;
    configTemplate.skills = skills;
    configTemplate.conventions = conventions;
    configTemplate.stale_days = staleDaysResolved;
    configTemplate.inject_token_budget = injectTokenBudgetResolved;
    configTemplate.hook_version = VERSION;
    fs.writeFileSync(configDest, JSON.stringify(configTemplate, null, 2) + "\n");
  } else {
    // Update existing config with new settings
    const existing = readJsonSafe(configDest, {});
    existing.mcp_servers = mcpServers;
    existing.skills = skills;
    existing.conventions = conventions;
    existing.stale_days = staleDaysResolved;
    existing.inject_token_budget = injectTokenBudgetResolved;
    existing.hook_version = VERSION;
    fs.writeFileSync(configDest, JSON.stringify(existing, null, 2) + "\n");
  }
  print("  [OK] .sticky-note/sticky-note-config.json");

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
    print("  [OK] .gitignore updated");
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
    print("  [OK] .gitattributes updated (merge=union)");
  } else {
    print("  ⏭️  .gitattributes already configured");
  }

  // Add git aliases for safe branch switching
  try {
    const swAlias = '!f() { npx sticky-note switch "$@"; }; f';
    execSync(`git config alias.sw '${swAlias}'`, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    print("  [OK] git alias: git sw <branch> (safe switch with auto-stash)");
  } catch (_) {
    print("  ⏭️  Could not set git alias (non-fatal)");
  }

  // Deploy AI instruction files (CLAUDE.md + .github/copilot-instructions.md)
  const claudeMdDest = path.join(process.cwd(), "CLAUDE.md");
  if (!fs.existsSync(claudeMdDest)) {
    copyFile(path.join(TEMPLATES_DIR, "CLAUDE.md"), claudeMdDest);
    print("  [OK] CLAUDE.md (AI instructions for Claude Code)");
  } else {
    print("  ⏭️  CLAUDE.md already exists");
  }

  const copilotInstrDest = path.join(githubHooksDir, "..", "copilot-instructions.md");
  if (!fs.existsSync(copilotInstrDest)) {
    copyFile(path.join(TEMPLATES_DIR, "copilot-instructions.md"), copilotInstrDest);
    print("  [OK] .github/copilot-instructions.md (AI instructions for Copilot CLI)");
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
    print("  [OK] .claude/hooks/sticky-codex.sh");
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
    print("  [ERR] No .claude/hooks/ directory found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  print("  Updating hook scripts...\n");

  for (const file of HOOK_FILES) {
    const src = path.join(TEMPLATES_DIR, "hooks", file);
    const dest = path.join(claudeHooksDir, file);
    copyFile(src, dest);
    makeExecutable(dest);
    print(`  [OK] .claude/hooks/${file}`);
  }

  // Update settings.json hooks
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  if (fs.existsSync(settingsPath)) {
    const settingsTemplate = JSON.parse(readTemplate("settings.json"));
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    existing.hooks = settingsTemplate.hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n");
    print("  [OK] .claude/settings.json (hooks updated)");
  }

  // Update hooks.json
  const hooksPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  if (fs.existsSync(hooksPath)) {
    const hooksTemplate = JSON.parse(readTemplate("hooks.json"));
    fs.writeFileSync(hooksPath, JSON.stringify(hooksTemplate, null, 2) + "\n");
    print("  [OK] .github/hooks/hooks.json (updated)");
  }

  // Update hook_version in config
  const configPath = path.join(stickyDir, "sticky-note-config.json");
  if (fs.existsSync(configPath)) {
    const config = readJsonSafe(configPath, {});
    config.hook_version = VERSION;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }

  print(`\n  ✨ Scripts updated to v${VERSION}`);

  // Update instruction files (section-based: only replaces between markers)
  const claudeMdDest = path.join(process.cwd(), "CLAUDE.md");
  const claudeMdTemplate = readTemplate("CLAUDE.md");
  if (updateInstructionSection(claudeMdDest, claudeMdTemplate, "# Sticky Note")) {
    print("  [OK] CLAUDE.md (sticky-note section updated)");
  }

  const copilotInstrDest = path.join(process.cwd(), ".github", "copilot-instructions.md");
  const copilotTemplate = readTemplate("copilot-instructions.md");
  if (updateInstructionSection(copilotInstrDest, copilotTemplate, "# Sticky Note")) {
    print("  [OK] .github/copilot-instructions.md (sticky-note section updated)");
  }

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
        print(`    [OK] ${file}`);
      } else {
        print(`    [ERR] ${file} (missing)`);
      }
    }
  } else {
    print("    [ERR] .claude/hooks/ directory not found");
  }

  // Config files
  print("\n  Config Files:");
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  const hooksJsonPath = path.join(process.cwd(), ".github", "hooks", "hooks.json");
  print(
    `    ${fs.existsSync(settingsPath) ? "[OK]" : "[ERR]"} .claude/settings.json`
  );
  print(
    `    ${fs.existsSync(hooksJsonPath) ? "[OK]" : "[ERR]"} .github/hooks/hooks.json`
  );

  // Sticky Note data — V2 format
  const memoryPath = path.join(stickyDir, "sticky-note.json");
  const configPath = path.join(stickyDir, "sticky-note-config.json");

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

      print(`    [OK] sticky-note.json (schema v${schemaVersion})`);
      print(`    📝 Threads: ${threads.length} total`);
      print(`       open=${openThreads}  stuck=${stuckThreads}  stale=${staleThreads}  closed=${closedThreads}  expired=${expiredThreads}`);
    } catch {
      print("    [ERR] sticky-note.json (invalid JSON)");
    }
  } else {
    print("    [ERR] sticky-note.json not found");
  }

  // Config
  if (fs.existsSync(configPath)) {
    const config = readJsonSafe(configPath, {});
    print(`    [OK] sticky-note-config.json (v${config.hook_version || "?"})`);
    if (config.mcp_servers && config.mcp_servers.length > 0) {
      print(`    🔌 MCP servers: ${config.mcp_servers.length} configured`);
    }
    if (config.conventions && config.conventions.length > 0) {
      print(`    📋 Conventions: ${config.conventions.length} defined`);
    }
    print(`    Stale after: ${config.stale_days ?? "?"} days`);
    print(`    Inject token budget: ${config.inject_token_budget ?? 1000}`);
  } else {
    print("    [ERR] sticky-note-config.json not found");
  }

  // Audit (per-user)
  const auditDir = path.join(stickyDir, "audit");
  if (fs.existsSync(auditDir)) {
    const auditFiles = fs.readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    let totalEntries = 0;
    const perUser = [];
    for (const f of auditFiles) {
      const count = countJsonlLines(path.join(auditDir, f));
      totalEntries += count;
      perUser.push(`${path.basename(f, ".jsonl")}(${count})`);
    }
    if (totalEntries > 0) {
      print(`    [OK] audit/ (${totalEntries} entries across ${auditFiles.length} user(s))`);
      print(`         ${perUser.join(", ")}`);
    } else {
      print("    ⏭️  audit/ (empty)");
    }
  } else {
    // Check for legacy single file
    const legacyAuditPath = path.join(stickyDir, "sticky-note-audit.jsonl");
    const auditCount = countJsonlLines(legacyAuditPath);
    if (auditCount > 0) {
      print(`    ⚠️  sticky-note-audit.jsonl (${auditCount} entries, legacy — run init to migrate)`);
    } else {
      print("    ⏭️  No audit data (run init to set up per-user audit)");
    }
  }

  // Presence (per-user)
  const presenceDir = path.join(stickyDir, "presence");
  if (fs.existsSync(presenceDir)) {
    const presenceFiles = fs.readdirSync(presenceDir).filter((f) => f.endsWith(".json"));
    const now = Date.now();
    const activeUsers = [];
    for (const f of presenceFiles) {
      const info = readJsonSafe(path.join(presenceDir, f), {});
      const lastSeen = info.last_seen || "";
      if (lastSeen) {
        const ts = new Date(lastSeen).getTime();
        if (!isNaN(ts) && now - ts < 15 * 60 * 1000) {
          activeUsers.push(path.basename(f, ".json"));
        }
      }
    }
    print(`    👥 Presence: ${activeUsers.length > 0 ? activeUsers.join(", ") + " (active)" : "no active users"}`);
  } else {
    print("    ⏭️  No presence data (run init to set up per-user presence)");
  }

  print("\n  Environment:");

  print(
    `    ${isGitRepo() ? "[OK]" : "[ERR]"} Git repository`
  );

  // V2.5: Attribution engine health
  print("\n  Attribution Engine (V2.5):");
  const attrPath = path.join(process.cwd(), ".claude", "hooks", "sticky-attribution.js");
  const notesPath = path.join(process.cwd(), ".claude", "hooks", "sticky-git-notes.js");
  const preToolPath = path.join(process.cwd(), ".claude", "hooks", "pre-tool-use.js");
  print(`    ${fs.existsSync(attrPath) ? "[OK]" : "[--]"} sticky-attribution.js`);
  print(`    ${fs.existsSync(notesPath) ? "[OK]" : "[--]"} sticky-git-notes.js`);
  print(`    ${fs.existsSync(preToolPath) ? "[OK]" : "[--]"} pre-tool-use.js`);

  // Check Git Notes configuration
  let notesConfigured = false;
  try {
    const ref = execSync("git config --get notes.rewriteRef", { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    notesConfigured = ref.includes("sticky-note");
  } catch (_) { /* not configured */ }
  print(`    ${notesConfigured ? "[OK]" : "[--]"} Git Notes rewrite configured`);
  print(`    Injection mode: two-tier (eager stuck + lazy file via git blame)`);
  // Injected-this-session info
  const injectedPath = path.join(stickyDir, ".sticky-injected");
  if (fs.existsSync(injectedPath)) {
    const injData = readJsonSafe(injectedPath, {});
    const ids = injData.thread_ids || [];
    if (ids.length > 0) {
      print(`    Injected this session: ${ids.length} thread(s)`);
    }
  }

  print("");
}

// ──────────────────────────────────────────────
// Helpers (shared formatting)
// ──────────────────────────────────────────────

function statusIcon(status) {
  switch (status) {
    case "stuck": return "[STUCK]";
    case "open": return "[OPEN]";
    case "stale": return "[STALE]";
    default: return "[CLOSED]";
  }
}

// ──────────────────────────────────────────────
// THREADS command
// ──────────────────────────────────────────────

function cmdThreads() {
  const memoryPath = path.join(process.cwd(), ".sticky-note", "sticky-note.json");
  if (!fs.existsSync(memoryPath)) {
    print("  [ERR] No sticky-note.json found. Run `npx sticky-note init` first.");
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
    const icon = statusIcon(t.status);
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
    print("  [ERR] No sticky-note.json found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  // resume --clear: remove the resume signal
  if (args.includes("--clear")) {
    if (fs.existsSync(resumePath)) {
      fs.unlinkSync(resumePath);
      print("  [OK] Resume signal cleared.");
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
      const icon = statusIcon(t.status);
      const user = t.user || t.author || "?";
      const files = (t.files_touched || []).slice(0, 3).join(", ");
      const branch = t.branch ? ` (${t.branch})` : "";
      const note = t.last_note ? ` — ${t.last_note.slice(0, 60)}` : "";
      const shortId = t.id.slice(0, 8);

      print(`  ${icon} ${shortId} [${t.status}] ${user}${branch}: ${files}${note}`);
      const prompts = t.prompts || [];
      if (prompts.length > 0) {
        const preview = prompts.slice(0, 3).map((p, i) => `     ${i + 1}. ${p.slice(0, 60)}`).join("\n");
        print(preview);
        if (prompts.length > 3) print(`     ... and ${prompts.length - 3} more prompt(s)`);
      }
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
    print(`  [ERR] No thread found matching "${threadId}".`);
    print("  Run `npx sticky-note resume --list` to see available threads.");
    process.exit(1);
  }

  if (match.status === "expired") {
    print(`  [ERR] Thread ${match.id.slice(0, 8)} is expired and cannot be resumed.`);
    process.exit(1);
  }

  // Write the resume signal file
  fs.writeFileSync(resumePath, match.id + "\n");

  const icon = statusIcon(match.status);
  print(`\n  [OK] Resume signal set for thread ${match.id.slice(0, 8)}`);
  print(`  ${icon} [${match.status}] ${match.user || "?"} (${match.branch || "no branch"})`);
  if (match.last_note) {
    print(`     ${match.last_note.slice(0, 80)}`);
  }

  // Output full thread context so AI assistants can use it immediately
  print(`\n  ── Thread context ──────────────────────────────────`);
  print(`  ID:       ${match.id}`);
  print(`  Author:   ${match.user || match.author || "unknown"}`);
  print(`  Tool:     ${match.tool || "unknown"}`);
  print(`  Branch:   ${match.branch || "none"}`);
  print(`  Status:   ${match.status}`);
  print(`  Created:  ${match.created_at || "?"}`);

  if (match.work_type && match.work_type !== "general") {
    print(`  Type:     ${match.work_type}`);
  }

  const files = match.files_touched || [];
  if (files.length > 0) {
    print(`  Files:    ${files.join(", ")}`);
  }

  if (match.narrative) {
    print(`\n  📖 Narrative:`);
    print(`  ${match.narrative.slice(0, 500)}`);
  }

  if (match.handoff_summary && match.handoff_summary !== "Session stopped — no summary available") {
    print(`\n  🤝 Handoff:`);
    print(`  ${match.handoff_summary.slice(0, 300)}`);
  }

  const failed = match.failed_approaches || [];
  if (failed.length > 0) {
    print(`\n  ⚠️  Failed approaches (${failed.length}):`);
    for (const f of failed.slice(0, 5)) {
      const desc = typeof f === "string" ? f : f.description || JSON.stringify(f);
      print(`     • ${desc.slice(0, 120)}`);
    }
  }

  const prompts = match.prompts || [];
  if (prompts.length > 0) {
    print(`\n  💬 Conversation (${prompts.length} prompt(s)):`);
    for (const [i, p] of prompts.slice(0, 8).entries()) {
      print(`     ${i + 1}. ${p.slice(0, 120)}`);
    }
    if (prompts.length > 8) {
      print(`     ... and ${prompts.length - 8} more`);
    }
  }

  print(`  ────────────────────────────────────────────────────`);
  print(`\n  Your next prompt will pick up this thread's context automatically.`);
  print("  Run `npx sticky-note resume --clear` to cancel.\n");
}

// ──────────────────────────────────────────────
// AUDIT command
// ──────────────────────────────────────────────

function cmdReset() {
  const stickyDir = path.join(process.cwd(), ".sticky-note");
  const memoryPath = path.join(stickyDir, "sticky-note.json");

  if (!fs.existsSync(memoryPath)) {
    print("  [ERR] No sticky-note.json found. Run 'npx sticky-note init' first.");
    process.exit(1);
  }

  const args = process.argv.slice(3);
  const force = args.includes("--force");

  const memory = readJsonSafe(memoryPath, { version: "2", threads: [] });
  const threadCount = (memory.threads || []).length;

  if (threadCount === 0) {
    print("  Nothing to reset -- 0 threads.");
    return;
  }

  if (!force) {
    print(`  This will permanently delete ${threadCount} thread(s) from sticky-note.json.`);
    print("  Run with --force to confirm, or --keep-audit to preserve the audit log.");
    return;
  }

  const keepAudit = args.includes("--keep-audit");

  memory.threads = [];
  fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
  print(`  [OK] Cleared ${threadCount} thread(s) from sticky-note.json`);

  if (!keepAudit) {
    // Delete per-user audit directory
    const auditDir = path.join(stickyDir, "audit");
    if (fs.existsSync(auditDir)) {
      for (const f of fs.readdirSync(auditDir)) {
        fs.unlinkSync(path.join(auditDir, f));
      }
      print("  [OK] Deleted all per-user audit logs");
    }
    // Also clean legacy single file if present
    const legacyAudit = path.join(stickyDir, "sticky-note-audit.jsonl");
    if (fs.existsSync(legacyAudit)) {
      fs.unlinkSync(legacyAudit);
      print("  [OK] Deleted legacy audit log");
    }
  } else {
    print("  [OK] Audit logs preserved (--keep-audit)");
  }

  // Clean up presence directory
  const presenceDir = path.join(stickyDir, "presence");
  if (fs.existsSync(presenceDir)) {
    for (const f of fs.readdirSync(presenceDir)) {
      fs.unlinkSync(path.join(presenceDir, f));
    }
  }

  // Clean up signal files and legacy presence
  for (const f of [".sticky-resume", ".sticky-session", ".sticky-head", ".sticky-presence.json"]) {
    const p = path.join(stickyDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  print("  [OK] Cleared session signal files");
  print("");
  print("  Fresh start. Next session will create a new thread.");
}

function cmdAudit() {
  const args = process.argv.slice(3);
  const stickyDir = path.join(process.cwd(), ".sticky-note");
  const auditDir = path.join(stickyDir, "audit");

  // Collect all audit file paths (per-user + legacy)
  const auditPaths = [];
  if (fs.existsSync(auditDir)) {
    for (const f of fs.readdirSync(auditDir)) {
      if (f.endsWith(".jsonl")) auditPaths.push(path.join(auditDir, f));
    }
  }
  const legacyPath = path.join(stickyDir, "sticky-note-audit.jsonl");
  if (fs.existsSync(legacyPath)) auditPaths.push(legacyPath);

  if (auditPaths.length === 0) {
    print("  [ERR] No audit files found. Run 'npx sticky-note init' first.");
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
        if (i + 1 < args.length) filterFile = args[++i];
        break;
      case "--user":
        if (i + 1 < args.length) filterUser = args[++i];
        break;
      case "--since":
        if (i + 1 < args.length) filterSince = args[++i];
        break;
      case "--session":
        if (i + 1 < args.length) filterSession = args[++i];
        break;
      case "--limit":
        if (i + 1 < args.length) limit = parseIntOr(args[++i], 50);
        break;
    }
  }

  // Read and filter all JSONL files, merge entries
  const matches = [];

  for (const auditPath of auditPaths) {
    try {
      const content = fs.readFileSync(auditPath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
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
    } catch (_) {
      // skip unreadable files
    }
  }

  // Sort by timestamp, show most recent first
  matches.sort((a, b) => {
    const ta = a.ts || a.timestamp || "";
    const tb = b.ts || b.timestamp || "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });

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
// WHO command — show active users
// ──────────────────────────────────────────────

function cmdWho() {
  printBanner();

  const presenceDir = path.join(process.cwd(), ".sticky-note", "presence");

  if (!fs.existsSync(presenceDir)) {
    // Check legacy
    const legacyPath = path.join(process.cwd(), ".sticky-note", ".sticky-presence.json");
    if (fs.existsSync(legacyPath)) {
      print("  ⚠️  Legacy presence file found. Run 'npx sticky-note init' to migrate.\n");
      const data = readJsonSafe(legacyPath, {});
      const now = Date.now();
      for (const [user, info] of Object.entries(data)) {
        const lastSeen = info.last_seen || "";
        const ts = lastSeen ? new Date(lastSeen).getTime() : 0;
        const active = !isNaN(ts) && now - ts < 15 * 60 * 1000;
        const ago = lastSeen ? _relativeTime(lastSeen) : "unknown";
        const files = (info.active_files || []).slice(0, 5).join(", ");
        const marker = active ? "[ACTIVE]" : "[IDLE]";
        print(`  ${marker} ${user}  (${ago})`);
        if (files) print(`         files: ${files}`);
      }
    } else {
      print("  No presence data. Run 'npx sticky-note init' to set up.\n");
    }
    return;
  }

  const presenceFiles = fs.readdirSync(presenceDir).filter((f) => f.endsWith(".json"));
  if (presenceFiles.length === 0) {
    print("  No users tracked yet.\n");
    return;
  }

  const now = Date.now();
  const users = [];
  for (const f of presenceFiles) {
    const user = path.basename(f, ".json");
    const info = readJsonSafe(path.join(presenceDir, f), {});
    const lastSeen = info.last_seen || "";
    const ts = lastSeen ? new Date(lastSeen).getTime() : 0;
    const active = !isNaN(ts) && now - ts < 15 * 60 * 1000;
    users.push({ user, info, lastSeen, active });
  }

  // Sort: active first, then by last_seen descending
  users.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastSeen || "") > (a.lastSeen || "") ? 1 : -1;
  });

  print("  Team Activity:\n");
  for (const { user, info, lastSeen, active } of users) {
    const ago = lastSeen ? _relativeTime(lastSeen) : "unknown";
    const files = (info.active_files || []).slice(0, 5).join(", ");
    const marker = active ? "[ACTIVE]" : "[IDLE]";
    print(`  ${marker} ${user}  (${ago})`);
    if (files) print(`         files: ${files}`);
  }
  print("");
}

function _relativeTime(tsStr) {
  try {
    const ts = new Date(tsStr);
    if (isNaN(ts.getTime())) return "unknown";
    const now = new Date();
    const deltaMs = now - ts;
    const mins = Math.floor(deltaMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  } catch (_) {
    return "unknown";
  }
}

// ──────────────────────────────────────────────
// SWITCH command — safe branch switching
// ──────────────────────────────────────────────

function cmdSwitch() {
  const args = process.argv.slice(3);
  const branch = args.filter((a) => !a.startsWith("-"))[0];

  if (!branch) {
    print("  Usage: npx sticky-note switch <branch>");
    print("  Safely switches git branches by auto-stashing .sticky-note/ data.\n");
    process.exit(1);
  }

  const stickyDir = path.join(process.cwd(), ".sticky-note");
  if (!fs.existsSync(stickyDir)) {
    print("  No .sticky-note/ directory. Running plain git switch.");
    try {
      execSync(`git switch ${branch}`, { stdio: "inherit" });
    } catch (_) {
      process.exit(1);
    }
    return;
  }

  // Step 1: Stash .sticky-note/ changes
  let stashed = false;
  try {
    const result = execSync(
      'git stash push -m "sticky-note-auto" -- .sticky-note/',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    stashed = result.includes("Saved working directory");
    if (stashed) {
      print("  [OK] Stashed .sticky-note/ changes");
    }
  } catch (_) {
    // Nothing to stash, that's fine
  }

  // Step 2: Switch branch
  let switchOk = false;
  try {
    execSync(`git switch ${branch}`, { stdio: "inherit" });
    switchOk = true;
    print(`  [OK] Switched to ${branch}`);
  } catch (_) {
    print(`  [ERR] Failed to switch to ${branch}`);
    // Try to restore stash if we made one
    if (stashed) {
      try {
        execSync("git stash pop", { stdio: ["pipe", "pipe", "pipe"] });
        print("  [OK] Restored stashed .sticky-note/ changes");
      } catch (_2) {
        print("  [WARN] Stash exists but could not pop. Run 'git stash pop' manually.");
      }
    }
    process.exit(1);
  }

  // Step 3: Pop stash to restore .sticky-note/ data
  if (stashed) {
    try {
      execSync("git stash pop", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      print("  [OK] Restored .sticky-note/ data");
    } catch (_) {
      // Conflicts — force our version (sticky-note data is branch-independent)
      try {
        execSync("git checkout --theirs -- .sticky-note/", {
          stdio: ["pipe", "pipe", "pipe"],
        });
        execSync("git stash drop", { stdio: ["pipe", "pipe", "pipe"] });
        print("  [OK] Restored .sticky-note/ data (resolved conflicts)");
      } catch (_2) {
        print("  [WARN] Could not auto-resolve. Run 'git stash pop' and resolve manually.");
      }
    }
  }

  print("");
}

// ──────────────────────────────────────────────
// Resume Thread command (V2.5 — MCP-style)
// ──────────────────────────────────────────────

function cmdResumeThread() {
  const args = process.argv.slice(3);
  const stickyDir = path.join(process.cwd(), ".sticky-note");
  const memoryPath = path.join(stickyDir, "sticky-note.json");

  if (!fs.existsSync(memoryPath)) {
    print("  [ERR] No sticky-note.json found. Run `npx sticky-note init` first.");
    process.exit(1);
  }

  // Parse flags
  let query = null;
  let user = null;
  let file = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--query":
      case "-q":
        if (i + 1 < args.length) query = args[++i];
        break;
      case "--user":
      case "-u":
        if (i + 1 < args.length) user = args[++i];
        break;
      case "--file":
      case "-f":
        if (i + 1 < args.length) file = args[++i];
        break;
      case "--json":
        jsonOutput = true;
        break;
      default:
        // Positional argument is treated as query
        if (!args[i].startsWith("-") && !query) {
          query = args.slice(i).join(" ");
          i = args.length; // consume all remaining
        }
        break;
    }
  }

  if (!query && !user && !file) {
    print("  Usage: npx sticky-note resume-thread [--query <text>] [--user <name>] [--file <path>] [--json]");
    print("  Or:    npx sticky-note resume-thread \"pick up auth refresh work\"");
    process.exit(1);
  }

  const memory = readJsonSafe(memoryPath, { threads: [] });
  const threads = (memory.threads || []).filter((t) => t.status !== "expired");

  // Load attribution engine for search
  let attribution;
  try {
    attribution = require(path.join(__dirname, "..", "templates", "hooks", "sticky-attribution.js"));
  } catch (_) {
    try {
      attribution = require(path.join(process.cwd(), ".claude", "hooks", "sticky-attribution.js"));
    } catch (_) {
      attribution = null;
    }
  }

  let candidates;
  if (attribution) {
    candidates = attribution.findThreadToResume(threads, { query, user, file });
  } else {
    // Fallback: simple text matching without attribution engine
    candidates = simpleThreadSearch(threads, query, user);
  }

  if (candidates.length === 0) {
    const msg = "No matching threads found.";
    if (jsonOutput) {
      print(JSON.stringify({ error: msg, candidates: [] }));
    } else {
      print(`  [ERR] ${msg}`);
      if (query) print(`  Query: "${query}"`);
      if (user) print(`  User: "${user}"`);
    }
    process.exit(1);
  }

  // If top 2 are close in score, show both and let user choose
  const top = candidates[0];
  const showConfirmation = candidates.length > 1 &&
    (top.score - candidates[1].score) < 0.5 &&
    top.score > 0;

  if (jsonOutput) {
    const result = {
      best_match: formatThreadResult(top),
      alternatives: showConfirmation
        ? candidates.slice(1, 3).map(formatThreadResult)
        : [],
    };
    print(JSON.stringify(result, null, 2));
    // Set active resume
    setActiveResume(stickyDir, top.thread.id);
    return;
  }

  printBanner();

  if (showConfirmation) {
    print("  Found multiple close matches:\n");
    for (let i = 0; i < Math.min(candidates.length, 3); i++) {
      const c = candidates[i];
      const t = c.thread;
      const icon = statusIcon(t.status);
      const shortId = t.id.slice(0, 8);
      print(`  ${i + 1}. ${icon} ${shortId} [${t.status}] ${t.user || "?"} (${t.branch || "no branch"}) — score: ${c.score.toFixed(1)}`);
      if (t.narrative) print(`     ${t.narrative.slice(0, 100)}`);
      if (c.match_reasons && c.match_reasons.length) {
        print(`     Matched by: ${c.match_reasons.join(", ")}`);
      }
    }
    print("\n  Selecting best match (#1)...\n");
  }

  // Set active resume thread
  const match = top.thread;
  setActiveResume(stickyDir, match.id);

  const icon = statusIcon(match.status);
  print(`  [OK] Resuming thread ${match.id.slice(0, 8)}`);
  print(`  ${icon} [${match.status}] ${match.user || "?"} (${match.branch || "no branch"})`);
  if (match.narrative) print(`  📖 ${match.narrative.slice(0, 200)}`);
  if (match.handoff_summary) print(`  🤝 ${match.handoff_summary.slice(0, 200)}`);

  const contributors = match.contributors || [match.user || "unknown"];
  if (contributors.length > 1) {
    print(`  👥 Contributors: ${contributors.join(", ")}`);
  }

  const failed = match.failed_approaches || [];
  if (failed.length > 0) {
    print(`  ⚠️ ${failed.length} failed approach(es)`);
  }

  print(`\n  Thread context will be injected into your next AI session.`);
  print("");
}

function simpleThreadSearch(threads, query, user) {
  const results = [];

  for (const thread of threads) {
    let score = 0;

    if (user && (thread.user || "").toLowerCase() !== user.toLowerCase()) continue;
    if (user) score += 1;

    if (query) {
      const queryLower = query.toLowerCase();
      const fields = [
        thread.narrative || "",
        thread.last_note || "",
        thread.handoff_summary || "",
        (thread.files_touched || []).join(" "),
        (thread.failed_approaches || []).map((f) => f.description || "").join(" "),
      ].join(" ").toLowerCase();

      const words = queryLower.split(/\s+/).filter((w) => w.length >= 2);
      let matches = 0;
      for (const w of words) {
        if (fields.includes(w)) matches++;
      }
      score += words.length > 0 ? (matches / words.length) * 3 : 0;
    }

    if (score > 0 || (!query && user)) {
      results.push({ thread, score, match_reasons: [] });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function formatThreadResult(candidate) {
  const t = candidate.thread;
  return {
    id: t.id,
    user: t.user || "unknown",
    status: t.status,
    branch: t.branch || "",
    narrative: (t.narrative || "").substring(0, 300),
    files_touched: (t.files_touched || []).slice(0, 10),
    score: Math.round(candidate.score * 10) / 10,
    match_reasons: candidate.match_reasons || [],
    contributors: t.contributors || [t.user || "unknown"],
  };
}

function setActiveResume(stickyDir, threadId) {
  const resumePath = path.join(stickyDir, ".sticky-active-resume");
  const signalPath = path.join(stickyDir, ".sticky-resume");
  fs.writeFileSync(resumePath, threadId + "\n");
  fs.writeFileSync(signalPath, threadId + "\n");
}

// ──────────────────────────────────────────────
// Get Line Attribution command (V2.5)
// ──────────────────────────────────────────────

function cmdGetLineAttribution() {
  const args = process.argv.slice(3);

  // Parse flags
  let file = null;
  let lineRange = null;
  let since = null;
  let jsonOutput = true; // always JSON for this command

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--file":
      case "-f":
        if (i + 1 < args.length) file = args[++i];
        break;
      case "--line-range":
      case "--lines":
        if (i + 1 < args.length) {
          const parts = args[++i].split(/[-:,]/);
          if (parts.length === 2) {
            lineRange = [parseInt(parts[0], 10), parseInt(parts[1], 10)];
          }
        }
        break;
      case "--since":
        if (i + 1 < args.length) since = args[++i];
        break;
      default:
        if (!args[i].startsWith("-") && !file) file = args[i];
        break;
    }
  }

  if (!file) {
    print(JSON.stringify({ error: "Usage: npx sticky-note get-line-attribution --file <path> [--line-range start:end] [--since ISO-date]" }));
    process.exit(1);
  }

  // Load attribution engine
  let attribution;
  try {
    attribution = require(path.join(__dirname, "..", "templates", "hooks", "sticky-attribution.js"));
  } catch (_) {
    try {
      attribution = require(path.join(process.cwd(), ".claude", "hooks", "sticky-attribution.js"));
    } catch (_) {
      attribution = null;
    }
  }

  if (!attribution) {
    print(JSON.stringify({ error: "Attribution engine not found. Run npx sticky-note update." }));
    process.exit(1);
  }

  const options = {};
  if (lineRange) options.lineRange = lineRange;
  if (since) options.since = since;

  const result = attribution.getFileAttribution(file, options);

  const output = {
    file,
    threads: result.threads.map((t) => ({
      id: t.thread.id,
      user: t.thread.user,
      status: t.thread.status,
      branch: t.thread.branch,
      narrative: (t.thread.narrative || "").substring(0, 200),
      files_touched: (t.thread.files_touched || []).slice(0, 10),
      contributors: t.thread.contributors || [t.thread.user || "unknown"],
      lines: t.lines,
      line_ranges: t.line_ranges,
      tier: t.tier,
    })),
    line_map: result.line_map,
  };

  print(JSON.stringify(output, null, 2));
}

// ──────────────────────────────────────────────
// Checkpoint command (V2.5)
// ──────────────────────────────────────────────

function cmdCheckpoint() {
  const args = process.argv.slice(3);
  let topic = null;
  let clear = false;
  let show = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--topic" || args[i] === "-t") {
      topic = args[i + 1] || null;
      i++;
    } else if (args[i] === "--clear") {
      clear = true;
    } else if (args[i] === "--show") {
      show = true;
    } else if (!args[i].startsWith("-")) {
      // Positional argument = topic
      topic = args.slice(i).join(" ");
      break;
    }
  }

  // Load git-notes module
  let gitNotes;
  try {
    gitNotes = require(path.join(__dirname, "..", "templates", "hooks", "sticky-git-notes.js"));
  } catch (_) {
    try {
      gitNotes = require(path.join(process.cwd(), ".claude", "hooks", "sticky-git-notes.js"));
    } catch (_) {
      print("[ERR] Git notes module not found. Run npx sticky-note update.");
      process.exit(1);
    }
  }

  if (clear) {
    gitNotes.clearCheckpoint();
    print("  Checkpoint cleared.");
    return;
  }

  if (show) {
    const cp = gitNotes.getCurrentCheckpoint();
    if (cp) {
      print(`  Current checkpoint: ${cp.topic}`);
      print(`  Set at: ${cp.ts}`);
      if (cp.session_id) print(`  Session: ${cp.session_id}`);
    } else {
      print("  No active checkpoint.");
    }
    return;
  }

  if (!topic) {
    print("Usage: npx sticky-note checkpoint <topic>");
    print("       npx sticky-note checkpoint --topic \"fixing auth token expiry\"");
    print("       npx sticky-note checkpoint --show");
    print("       npx sticky-note checkpoint --clear");
    process.exit(1);
  }

  // Load utils for session/user info
  let utils;
  try {
    utils = require(path.join(__dirname, "..", "templates", "hooks", "sticky-utils.js"));
  } catch (_) {
    try {
      utils = require(path.join(process.cwd(), ".claude", "hooks", "sticky-utils.js"));
    } catch (_) {
      utils = null;
    }
  }

  const user = utils ? utils.getUser() : (process.env.USER || process.env.USERNAME || "unknown");
  const sessionId = utils ? utils.readSessionIdFromFile() : null;
  const now = new Date().toISOString();

  const checkpoint = {
    topic,
    user,
    ts: now,
    session_id: sessionId || null,
  };
  gitNotes.saveCheckpoint(checkpoint);

  // Also write to audit
  if (utils) {
    utils.appendAuditLine({
      type: "checkpoint",
      user,
      ts: now,
      session_id: sessionId,
      topic,
    });
  }

  print(`  ✓ Checkpoint set: "${topic}"`);
  print(`  Subsequent AI edits will be tagged with this topic.`);
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
    print("  [ERR] No sticky-note.json found.");
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

      // Replace thread data with minimal tombstone
      const tombstone = { id, status: "expired", user, closed_at: closedAt };
      const keys = Object.keys(thread);
      for (const k of keys) delete thread[k];
      Object.assign(thread, tombstone);
      tombstoned++;
    }
  }

  if (tombstoned > 0) {
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2) + "\n");
    print(`  🗑️  Tombstoned ${tombstoned} closed thread(s) older than ${staleDays} days.`);
  } else {
    print(`  [OK] No threads to tombstone (stale_days=${staleDays}).`);
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
    case "who":
      cmdWho();
      break;
    case "switch":
      cmdSwitch();
      break;
    case "gc":
      cmdGc();
      break;
    case "reset":
      cmdReset();
      break;
    case "resume-thread":
      cmdResumeThread();
      break;
    case "get-line-attribution":
      cmdGetLineAttribution();
      break;
    case "checkpoint":
      cmdCheckpoint();
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
      print("    init               Interactive setup — creates V2.5 hooks and config");
      print("    update             Update hook scripts (preserves data)");
      print("    status             Diagnostic report: threads, audit, attribution health");
      print("    threads            List open/stuck threads");
      print("    resume             Resume a previous thread (--list, --clear, <id>)");
      print("    resume-thread      Smart thread resume (--query, --user, --file, --json)");
      print("    audit              Query audit trail (--file, --user, --since, --session)");
      print("    who                Show active and recent team members");
      print("    switch             Safe branch switching (auto-stashes .sticky-note/)");
      print("    gc                 Manual tombstone sweep for expired threads");
      print("    reset              Wipe all threads and start fresh (--force, --keep-audit)");
      print("    get-line-attribution  File→thread attribution with line ranges (--file, --lines)");
      print("    checkpoint         Set work-topic checkpoint for attribution (--topic, --show, --clear)");
      print("");
      print("  Options:");
      print("    --version  Show version");
      print("    --help     Show this help");
      print("");
      break;
    default:
      print(`  [ERR] Unknown command: ${command}`);
      print(`  Run 'npx sticky-note --help' for usage.`);
      process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`Fatal error: ${err.message}\n`);
  process.exit(1);
});
