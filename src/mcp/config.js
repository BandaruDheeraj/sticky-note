const fs = require("fs");
const path = require("path");

function getCopilotCliConfigDir() {
  if (process.env.COPILOT_HOME) return process.env.COPILOT_HOME;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  return path.join(home, ".copilot");
}

function getCopilotCliMcpConfigPath() {
  const dir = getCopilotCliConfigDir();
  return dir ? path.join(dir, "mcp-config.json") : null;
}

function ensureMcpInCopilotCliConfig(serverName, serverConfig) {
  try {
    const configDir = getCopilotCliConfigDir();
    if (!configDir || !fs.existsSync(configDir)) return false;

    const configPath = path.join(configDir, "mcp-config.json");
    let config = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch (_) {
        config = {};
      }
    }

    config.mcpServers = config.mcpServers || {};
    const existing = config.mcpServers[serverName];
    if (existing) {
      if (!existing.tools) {
        existing.tools = ["*"];
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        return true;
      }
      return false;
    }

    if (!serverConfig.tools) serverConfig.tools = ["*"];
    config.mcpServers[serverName] = serverConfig;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  getCopilotCliConfigDir,
  getCopilotCliMcpConfigPath,
  ensureMcpInCopilotCliConfig,
};
