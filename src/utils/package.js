const fs = require("fs");
const path = require("path");
const { compareSemver } = require("./semver");
const { print } = require("./ui");
const { VERSION } = require("./ui");

function pinCliInPackageJson() {
  const pkgPath = path.join(process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) {
    print("  ⏭️  No package.json found — skipping devDependency pin");
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    print(`  ⏭️  Could not parse package.json: ${err.message}`);
    return;
  }
  pkg.devDependencies = pkg.devDependencies || {};
  const existing = pkg.devDependencies["sticky-note-cli"];
  const desired = `^${VERSION}`;
  if (existing) {
    const existingClean = String(existing).replace(/^[\^~]/, "");
    if (compareSemver(existingClean, VERSION) >= 0) {
      print(`  ⏭️  package.json devDependencies already pin sticky-note-cli ${existing}`);
      return;
    }
  }
  pkg.devDependencies["sticky-note-cli"] = desired;
  pkg.devDependencies = Object.fromEntries(
    Object.entries(pkg.devDependencies).sort(([a], [b]) => a.localeCompare(b))
  );
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  print(`  [OK] package.json devDependencies: sticky-note-cli ${desired}`);
  print("       Run `npm install` to lock the version for your team.");
}

module.exports = {
  pinCliInPackageJson,
};
