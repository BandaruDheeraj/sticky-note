const fs = require("fs");
const path = require("path");

function resolveHookPaths(_obj, _rootDir) {
  return;
}

function findStaleHookPaths(settings) {
  const stale = [];
  const hooks = (settings && settings.hooks) || {};
  for (const entries of Object.values(hooks)) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of entry.hooks || []) {
        const cmd = h && h.command;
        if (typeof cmd !== "string") continue;
        if (
          /["'][A-Za-z]:[\\/]/.test(cmd) ||
          /["']\/(?:Users|home|root|tmp)\//.test(cmd) ||
          cmd.includes("$(git rev-parse")
        ) {
          stale.push(cmd);
        }
        if (/^npx\s+sticky-note\s+run-hook\s+\S+/.test(cmd)) {
          stale.push(cmd);
        }
        if (/^node\s+"?\.claude\/hooks\//.test(cmd)) {
          stale.push(cmd);
        }
      }
    }
  }
  return stale;
}

function installGitHook(hookName, templatesDir) {
  try {
    const gitDir = path.join(process.cwd(), ".git");
    if (!fs.existsSync(gitDir)) return false;
    const hooksDir = path.join(gitDir, "hooks");

    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const src = path.join(templatesDir, "hooks", hookName + ".js");
    if (!fs.existsSync(src)) return false;

    if (process.platform === "win32") {
      const shimContent =
        `@echo off\r\nnode "%~dp0..\\..\\templates\\hooks\\${hookName}.js" %*\r\n`;
      const dest = path.join(hooksDir, hookName);
      fs.writeFileSync(dest, shimContent, "utf-8");
    } else {
      const shimContent =
        `#!/bin/sh\nnode "$(dirname "$0")/../../templates/hooks/${hookName}.js" "$@"\n`;
      const dest = path.join(hooksDir, hookName);
      fs.writeFileSync(dest, shimContent, "utf-8");
      try {
        fs.chmodSync(dest, 0o755);
      } catch {
        // Windows doesn't support chmod
      }
    }
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  resolveHookPaths,
  findStaleHookPaths,
  installGitHook,
};
