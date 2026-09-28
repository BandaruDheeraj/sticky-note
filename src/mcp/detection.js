const fs = require("fs");
const path = require("path");
const os = require("os");
const { getCopilotCliMcpConfigPath } = require("./config");
const { debugLog } = require("../utils/ui");

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
    } catch (err) { debugLog("detectMcpServers .mcp.json: " + (err.message || err)); }
  }

  const copilotMcpPath = getCopilotCliMcpConfigPath();
  if (copilotMcpPath && fs.existsSync(copilotMcpPath)) {
    try {
      const copilotMcp = JSON.parse(fs.readFileSync(copilotMcpPath, "utf-8"));
      const mcpServers = copilotMcp.mcpServers || {};
      for (const [name, config] of Object.entries(mcpServers)) {
        if (servers.has(name)) continue;
        const entry = {
          name,
          type: config.type || config.transport || "unknown",
          source: "~/.copilot/mcp-config.json",
        };
        if (config.command) entry.command = config.command;
        if (config.args) entry.args = config.args;
        if (config.env) entry.env = config.env;
        if (config.url) entry.url = config.url;
        servers.set(name, entry);
      }
    } catch (err) { debugLog("detectMcpServers copilot mcp-config: " + (err.message || err)); }
  }

  const globalClaudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(globalClaudeSettingsPath)) {
    try {
      const globalSettings = JSON.parse(fs.readFileSync(globalClaudeSettingsPath, "utf-8"));
      const globalMcp = globalSettings.mcpServers || {};
      for (const [name, config] of Object.entries(globalMcp)) {
        if (servers.has(name)) continue;
        if (config.type === "permission-detected") continue;
        const entry = {
          name,
          type: config.type || config.transport || "stdio",
          source: "~/.claude/settings.json",
        };
        if (config.command) entry.command = config.command;
        if (config.args) entry.args = config.args;
        if (config.env) entry.env = config.env;
        if (config.url) entry.url = config.url;
        servers.set(name, entry);
      }
    } catch (err) { debugLog("detectMcpServers global settings: " + (err.message || err)); }
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
              type: "account-mcp",
              source: "settings.local.json",
            });
          }
        }
      }
    } catch (err) { debugLog("detectMcpServers settings.local.json: " + (err.message || err)); }
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
    } catch (err) { debugLog("detectSkills: " + (err.message || err)); }
  }

  return Array.from(skills);
}

module.exports = {
  detectMcpServers,
  detectSkills,
};
