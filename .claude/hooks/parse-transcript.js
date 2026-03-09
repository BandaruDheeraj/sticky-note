#!/usr/bin/env node
"use strict";
/**
 * parse-transcript.js — Standalone Transcript Parser (V2)
 *
 * Extracts narrative + failed_approaches from a session transcript file.
 * Used by sticky-codex.sh to process Codex stdout/stderr logs.
 * Also usable standalone: node parse-transcript.js <transcript_path>
 *
 * Outputs JSON to stdout: {"narrative": "...", "failed_approaches": [...]}
 */

const fs = require("fs");
const {
  parseJsonlFile,
  extractNarrativeFromEntries,
  extractNarrativeFromText,
  extractFailedFromEntries,
  extractFailedFromText,
} = require("./sticky-utils.js");

function parsePlaintextTranscript(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  } catch (_) {
    return [];
  }
}

function parseTranscript(filePath) {
  const entries = parseJsonlFile(filePath);
  if (entries.length) {
    return {
      narrative: extractNarrativeFromEntries(entries),
      failed_approaches: extractFailedFromEntries(entries),
    };
  }

  const lines = parsePlaintextTranscript(filePath);
  if (lines.length) {
    return {
      narrative: extractNarrativeFromText(lines),
      failed_approaches: extractFailedFromText(lines),
    };
  }

  return { narrative: "", failed_approaches: [] };
}

function main() {
  if (process.argv.length < 3) {
    process.stderr.write("Usage: parse-transcript.js <transcript_path>\n");
    process.exit(1);
  }

  const transcriptPath = process.argv[2];
  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(`Warning: transcript file not found: ${transcriptPath}\n`);
    console.log(JSON.stringify({ narrative: "", failed_approaches: [] }));
    return;
  }

  const result = parseTranscript(transcriptPath);
  console.log(JSON.stringify(result));
}

main();
