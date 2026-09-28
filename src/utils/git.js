const { execFileSync } = require("child_process");

function isGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getGitUserName() {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return name || null;
  } catch {
    return null;
  }
}

module.exports = {
  isGitRepo,
  getGitUserName,
};
