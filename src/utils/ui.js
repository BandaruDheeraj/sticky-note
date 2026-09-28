const fs = require("fs");
const path = require("path");

const VERSION = require("../../package.json").version;

function print(msg) {
  process.stdout.write(msg + "\n");
}

function debugLog(msg) {
  if (process.env.STICKY_DEBUG) {
    process.stderr.write(`[sticky-note] ${msg}\n`);
  }
}

function printBanner() {
  print("");
  print(`  📌 sticky-note v${VERSION}`);
  print("  Human-to-human handoff for AI coding assistants");
  print("");
}

function ask(rl, question, defaultVal) {
  return new Promise((resolve) => {
    const suffix = defaultVal !== undefined ? ` (${defaultVal})` : "";
    rl.question(`  ${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || (defaultVal !== undefined ? String(defaultVal) : ""));
    });
  });
}

module.exports = {
  print,
  debugLog,
  printBanner,
  ask,
  VERSION,
};
