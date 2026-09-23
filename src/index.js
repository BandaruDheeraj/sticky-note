const ui = require("./utils/ui");
const fileIo = require("./utils/file-io");
const semver = require("./utils/semver");
const git = require("./utils/git");
const hook = require("./utils/hook");
const pkg = require("./utils/package");
const mcpConfig = require("./mcp/config");
const mcpDetection = require("./mcp/detection");
const stickyDir = require("./core/sticky-dir");

module.exports = {
  ui: {
    print: ui.print,
    debugLog: ui.debugLog,
    printBanner: ui.printBanner,
    ask: ui.ask,
    VERSION: ui.VERSION,
  },
  fileIo: {
    mkdirSafe: fileIo.mkdirSafe,
    copyFile: fileIo.copyFile,
    readTemplate: fileIo.readTemplate,
    readJsonSafe: fileIo.readJsonSafe,
    readEnvSticky: fileIo.readEnvSticky,
    makeExecutable: fileIo.makeExecutable,
    updateInstructionSection: fileIo.updateInstructionSection,
    countJsonlLines: fileIo.countJsonlLines,
  },
  semver: {
    parseSemver: semver.parseSemver,
    compareSemver: semver.compareSemver,
    bumpMinVersion: semver.bumpMinVersion,
    parseIntOr: semver.parseIntOr,
  },
  git: {
    isGitRepo: git.isGitRepo,
    getGitUserName: git.getGitUserName,
  },
  hook: {
    resolveHookPaths: hook.resolveHookPaths,
    findStaleHookPaths: hook.findStaleHookPaths,
    installGitHook: hook.installGitHook,
  },
  pkg: {
    pinCliInPackageJson: pkg.pinCliInPackageJson,
  },
  mcp: {
    getCopilotCliConfigDir: mcpConfig.getCopilotCliConfigDir,
    getCopilotCliMcpConfigPath: mcpConfig.getCopilotCliMcpConfigPath,
    ensureMcpInCopilotCliConfig: mcpConfig.ensureMcpInCopilotCliConfig,
    detectMcpServers: mcpDetection.detectMcpServers,
    detectSkills: mcpDetection.detectSkills,
  },
  core: {
    getActiveStickyDir: stickyDir.getActiveStickyDir,
  },
};
