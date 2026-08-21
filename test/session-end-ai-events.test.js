// test/session-end-ai-events.test.js
"use strict";
/**
 * Tests that session-end.js extracts ai_thinking, ai_response, and
 * context_compressed events from the Claude Code transcript JSONL
 * and writes them to the audit trail.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const TEMPLATES = path.join(__dirname, "..", "templates");
let tmpDir;
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  \u2713 " + name);
    passed++;
  } catch (err) {
    console.error("  \u2717 " + name + ": " + (err.message || err));
    failed++;
  }
}

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sticky-note-ai-events-"));
  execSync("git init", { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: "pipe" });
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# test\n");
  execSync("git add . && git commit -m init", { cwd: tmpDir, stdio: "pipe" });

  // Set up .sticky-note config
  const stickyDir = path.join(tmpDir, ".sticky-note");
  const hooksDir = path.join(tmpDir, ".claude", "hooks");
  fs.mkdirSync(path.join(stickyDir, "audit"), { recursive: true });
  fs.mkdirSync(path.join(stickyDir, "presence"), { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  fs.writeFileSync(
    path.join(stickyDir, "sticky-note.json"),
    JSON.stringify({ version: "2", project: "", threads: [] }, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(stickyDir, "sticky-note-config.json"),
    JSON.stringify({
      stale_days: 14,
      inject_token_budget: 1000,
      mcp_servers: [],
      skills: [],
      conventions: [],
      hook_version: "2.5.0",
    }, null, 2) + "\n"
  );

  // Copy hook files from templates
  const hookFiles = fs.readdirSync(path.join(TEMPLATES, "hooks")).filter(f => f.endsWith(".js"));
  for (const file of hookFiles) {
    fs.copyFileSync(
      path.join(TEMPLATES, "hooks", file),
      path.join(hooksDir, file)
    );
  }
}

function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* best effort */ }
}

function runSessionEnd(hooksDir, hookInput) {
  execFileSync("node", [path.join(hooksDir, "session-end.js")], {
    input: JSON.stringify(hookInput),
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: tmpDir,
  });
}

function readAuditLines(auditDir) {
  const files = fs.readdirSync(auditDir).filter(f => f.endsWith(".jsonl"));
  const lines = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(auditDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (line.trim()) {
        try { lines.push(JSON.parse(line)); } catch (_) {}
      }
    }
  }
  return lines;
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

console.log("\n  session-end AI event extraction tests\n");

setup();

try {
  test("session-end.js extracts ai_thinking events from transcript", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");
    fs.mkdirSync(auditDir, { recursive: true });

    // Write a fake transcript with a thinking block
    const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript-thinking.jsonl");
    const thinkingEntry = {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should look at the auth module first." },
          { type: "text", text: "Let me check the auth logic." },
        ],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(thinkingEntry) + "\n");

    const hookInput = {
      session_id: "sess-ai-thinking-test",
      transcript_path: transcriptPath,
    };

    runSessionEnd(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const thinkingEvent = lines.find(l => l.type === "ai_thinking" && l.session_id === "sess-ai-thinking-test");
    assert.ok(thinkingEvent, "ai_thinking event should be extracted and written");
    assert.ok(
      thinkingEvent.data.content.includes("auth module"),
      "thinking content should match transcript"
    );

    const responseEvent = lines.find(l => l.type === "ai_response" && l.session_id === "sess-ai-thinking-test");
    assert.ok(responseEvent, "ai_response event should be extracted and written");
    assert.ok(responseEvent.data.content.includes("auth logic"), "response content should match transcript");
  });

  test("session-end.js extracts ai_response events without thinking block", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    // Transcript with only a text block (no thinking)
    const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript-response.jsonl");
    const entry = {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here is the solution to the problem." },
        ],
      },
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(entry) + "\n");

    const hookInput = {
      session_id: "sess-ai-response-only",
      transcript_path: transcriptPath,
    };

    runSessionEnd(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const responseEvent = lines.find(l => l.type === "ai_response" && l.session_id === "sess-ai-response-only");
    assert.ok(responseEvent, "ai_response event should be written without thinking block");
    assert.ok(responseEvent.data.content.includes("solution"), "response content should be captured");

    // No thinking event expected
    const thinkingEvent = lines.find(l => l.type === "ai_thinking" && l.session_id === "sess-ai-response-only");
    assert.ok(!thinkingEvent, "ai_thinking should NOT be emitted when no thinking block present");
  });

  test("session-end.js extracts context_compressed events from transcript", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    // Transcript with a context compression summary entry
    const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript-compressed.jsonl");
    const entry = {
      type: "summary",
      summary: "The session so far: we reviewed auth code and fixed the login bug.",
      tokens_before: 50000,
      tokens_after: 5000,
    };
    fs.writeFileSync(transcriptPath, JSON.stringify(entry) + "\n");

    const hookInput = {
      session_id: "sess-context-compressed",
      transcript_path: transcriptPath,
    };

    runSessionEnd(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    const compressedEvent = lines.find(l => l.type === "context_compressed" && l.session_id === "sess-context-compressed");
    assert.ok(compressedEvent, "context_compressed event should be extracted");
    assert.ok(compressedEvent.data.summary.includes("auth code"), "summary should be captured");
    assert.strictEqual(compressedEvent.data.tokens_before, 50000, "tokens_before should be captured");
    assert.strictEqual(compressedEvent.data.tokens_after, 5000, "tokens_after should be captured");
  });

  test("session-end.js handles missing transcript file gracefully", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");

    const hookInput = {
      session_id: "sess-no-transcript",
      transcript_path: path.join(tmpDir, ".sticky-note", "nonexistent-transcript.jsonl"),
    };

    // Should not throw
    assert.doesNotThrow(() => {
      runSessionEnd(hooksDir, hookInput);
    }, "session-end should not throw when transcript file is missing");
  });

  test("session-end.js handles malformed JSONL lines in transcript gracefully", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    // Transcript with some valid and some invalid lines
    const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript-malformed.jsonl");
    const validEntry = {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Valid response after malformed line." }],
      },
    };
    fs.writeFileSync(
      transcriptPath,
      "not valid json\n" +
      JSON.stringify(validEntry) + "\n" +
      "{broken\n"
    );

    const hookInput = {
      session_id: "sess-malformed",
      transcript_path: transcriptPath,
    };

    // Should not throw
    assert.doesNotThrow(() => {
      runSessionEnd(hooksDir, hookInput);
    }, "session-end should not throw on malformed JSONL");

    // Should still extract events from valid lines
    const lines = readAuditLines(auditDir);
    const responseEvent = lines.find(l => l.type === "ai_response" && l.session_id === "sess-malformed");
    assert.ok(responseEvent, "ai_response should still be extracted from valid lines");
    assert.ok(responseEvent.data.content.includes("Valid response"), "valid entry content should be captured");
  });

  test("session-end.js skips non-assistant entries for AI events", () => {
    const hooksDir = path.join(tmpDir, ".claude", "hooks");
    const auditDir = path.join(tmpDir, ".sticky-note", "audit");

    const transcriptPath = path.join(tmpDir, ".sticky-note", "test-transcript-user.jsonl");
    const userEntry = {
      message: {
        role: "user",
        content: [{ type: "text", text: "Please help me fix the bug." }],
      },
    };
    const assistantEntry = {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I will fix it now." }],
      },
    };
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify(userEntry) + "\n" + JSON.stringify(assistantEntry) + "\n"
    );

    const hookInput = {
      session_id: "sess-user-filter",
      transcript_path: transcriptPath,
    };

    runSessionEnd(hooksDir, hookInput);

    const lines = readAuditLines(auditDir);
    // Should have ai_response for the assistant entry
    const responseEvent = lines.find(l => l.type === "ai_response" && l.session_id === "sess-user-filter");
    assert.ok(responseEvent, "ai_response should be extracted for assistant entry");
    // The user entry content should not appear as an ai_response or ai_thinking
    const allAiEvents = lines.filter(l =>
      (l.type === "ai_response" || l.type === "ai_thinking") && l.session_id === "sess-user-filter"
    );
    for (const ev of allAiEvents) {
      assert.ok(
        !ev.data.content.includes("Please help me fix the bug"),
        "user message content should not appear in AI events"
      );
    }
  });

  test("extractAiEventsFromTranscript is exported as a function", () => {
    const sessionEndPath = path.join(tmpDir, ".claude", "hooks", "session-end.js");
    // Read source and check for the function definition
    const source = fs.readFileSync(sessionEndPath, "utf-8");
    assert.ok(
      source.includes("function extractAiEventsFromTranscript"),
      "session-end.js should define extractAiEventsFromTranscript"
    );
    assert.ok(
      source.includes("collectSessionEvents"),
      "session-end.js should define collectSessionEvents"
    );
  });

} finally {
  cleanup();
}

// Summary
if (failed > 0) {
  console.error(`\n  ${failed} test(s) failed, ${passed} passed\n`);
  process.exit(1);
} else {
  console.log(`\n  ${passed} test(s) passed\n`);
}
