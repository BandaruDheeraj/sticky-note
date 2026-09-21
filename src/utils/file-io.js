const fs = require("fs");
const path = require("path");

function mkdirSafe(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

function readTemplate(name, templatesDir) {
  return fs.readFileSync(path.join(templatesDir, name), "utf-8");
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    return fallback;
  }
}

function readEnvSticky(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".env.sticky"), "utf-8");
    let url = "", key = "";
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("STICKY_URL=")) url = t.slice("STICKY_URL=".length).trim();
      else if (t.startsWith("STICKY_API_KEY=")) key = t.slice("STICKY_API_KEY=".length).trim();
    }
    return { url, key };
  } catch (_) {
    return { url: "", key: "" };
  }
}

function makeExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Windows doesn't support chmod
  }
}

const SECTION_START = "<!-- sticky-note:start";
const SECTION_END = "<!-- sticky-note:end -->";

function updateInstructionSection(destPath, templateContent, heading) {
  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, templateContent);
    return true;
  }

  const existing = fs.readFileSync(destPath, "utf-8");
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = existing.slice(0, startIdx);
    const after = existing.slice(endIdx + SECTION_END.length);
    fs.writeFileSync(destPath, before + templateContent.trim() + after);
  } else if (heading && existing.includes(heading)) {
    const headingIdx = existing.indexOf(heading);
    const before = existing.slice(0, headingIdx);
    fs.writeFileSync(destPath, before + templateContent);
  } else {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    fs.writeFileSync(destPath, existing + sep + templateContent);
  }
  return true;
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split(/\r?\n/).filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

module.exports = {
  mkdirSafe,
  copyFile,
  readTemplate,
  readJsonSafe,
  readEnvSticky,
  makeExecutable,
  updateInstructionSection,
  countJsonlLines,
};
