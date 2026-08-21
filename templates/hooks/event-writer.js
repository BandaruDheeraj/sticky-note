#!/usr/bin/env node
"use strict";
/**
 * event-writer.js — Shared Event Schema and Builder (V4)
 *
 * Provides event type constants, a builder for structured events,
 * and sanitizers for tool args and results.
 * Imported by track-work.js, on-error.js, inject-context.js,
 * session-start.js, and session-end.js.
 */

const crypto = require("crypto");

const MAX_RESULT_BYTES = 10 * 1024;        // 10 KB cap on tool results
const MAX_ARG_INLINE_BYTES = 1 * 1024;    // 1 KB: keep verbatim below this

const EVENT_TYPES = {
  SESSION_OPEN:         "session_open",
  USER_PROMPT:          "user_prompt",
  AI_THINKING:          "ai_thinking",
  AI_RESPONSE:          "ai_response",
  TOOL_CALL:            "tool_call",
  TOOL_RESULT:          "tool_result",
  TOOL_ERROR:           "tool_error",
  TOOL_DENIED:          "tool_denied",
  CONTEXT_COMPRESSED:   "context_compressed",
  GIT_COMMIT:           "git_commit",
  SUBAGENT_SPAWN:       "subagent_spawn",
  SUBAGENT_RESULT:      "subagent_result",
  CHECKPOINT:           "checkpoint",
  SESSION_CLOSE:        "session_close",
};

const WRITE_TOOLS = new Set([
  "Edit", "edit", "Write", "write", "MultiEdit", "multi_edit",
]);

/**
 * Build a structured event object.
 * @param {string} type - One of EVENT_TYPES values
 * @param {object} data - Event-specific payload
 * @param {string} sessionId - Session ID for correlation
 * @returns {{ ts: string, type: string, session_id: string, data: object }}
 */
function buildEvent(type, data, sessionId) {
  return {
    ts: new Date().toISOString(),
    type,
    session_id: sessionId || null,
    data: data || {},
  };
}

function _sha256hex(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

function _refOf(str) {
  return { _hash: _sha256hex(str), _len: str.length };
}

/**
 * Sanitize tool call args before storing.
 * - Non-write tools: returned unchanged.
 * - Write tools: large string fields (old_string, new_string, content) are
 *   replaced with a { _hash, _len } reference if they exceed MAX_ARG_INLINE_BYTES.
 *   Short strings are kept verbatim.
 */
function sanitizeToolArgs(toolName, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  if (!WRITE_TOOLS.has(toolName)) return args;

  const out = { ...args };

  for (const field of ["old_string", "new_string"]) {
    if (typeof out[field] === "string" &&
        Buffer.byteLength(out[field], "utf-8") > MAX_ARG_INLINE_BYTES) {
      out[field + "_ref"] = _refOf(out[field]);
      delete out[field];
    }
  }

  if (typeof out.content === "string" &&
      Buffer.byteLength(out.content, "utf-8") > MAX_ARG_INLINE_BYTES) {
    out.content_ref = _refOf(out.content);
    delete out.content;
  }

  return out;
}

/**
 * Cap a tool result string to MAX_RESULT_BYTES.
 * Non-string values are returned unchanged.
 */
function capResult(result) {
  if (typeof result !== "string") return result;
  const bytes = Buffer.byteLength(result, "utf-8");
  if (bytes <= MAX_RESULT_BYTES) return result;
  const cutoff = Math.floor(MAX_RESULT_BYTES * 0.95);
  return result.slice(0, cutoff) + `...[truncated, ${bytes} bytes total]`;
}

module.exports = { EVENT_TYPES, buildEvent, sanitizeToolArgs, capResult, MAX_RESULT_BYTES, MAX_ARG_INLINE_BYTES };
