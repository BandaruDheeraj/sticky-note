const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function getActiveStickyDir(cwd) {
  const root = cwd || process.cwd();
  try {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"], cwd: root,
    }).trim();
    const dataBranchDir = path.join(gitDir, "sticky-note");
    if (fs.existsSync(path.join(dataBranchDir, "sticky-note.json"))) {
      return dataBranchDir;
    }
  } catch (_) {
    // not a git repo or git unavailable
  }
  return path.join(root, ".sticky-note");
}

module.exports = {
  getActiveStickyDir,
};
