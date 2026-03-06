#!/usr/bin/env python3
"""on-stop.py — Handoff Summary Generation (V2)

Hook: Stop (Claude Code)
Generates a structured handoff_summary on the current thread:
what was done / what failed / current theory / suggested next step.
Appends JSONL audit line.
"""

import json
import os
import sys
from datetime import datetime, timezone


# ── Paths ──────────────────────────────────────────────────

def _sticky_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "..", ".sticky-note")


def get_memory_path():
    return os.path.join(_sticky_dir(), "sticky-note.json")


def get_audit_path():
    return os.path.join(_sticky_dir(), "sticky-note-audit.jsonl")


# ── I/O ────────────────────────────────────────────────────

def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def append_audit_line(entry):
    path = get_audit_path()
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def get_user():
    return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


# ── V1 compat ──────────────────────────────────────────────

def is_v1(memory):
    return "audit" in memory and memory.get("version") != "2"


def migrate_v1_inline(memory):
    audit_entries = memory.pop("audit", [])
    config_block = memory.pop("config", {})

    if audit_entries:
        path = get_audit_path()
        with open(path, "a", encoding="utf-8") as f:
            for entry in audit_entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    config_path = os.path.join(_sticky_dir(), "sticky-note-config.json")
    if not os.path.exists(config_path) and config_block:
        save_json(config_path, config_block)

    memory["version"] = "2"
    memory.setdefault("project", "")
    memory.setdefault("threads", [])
    return memory


# ── Handoff summary ────────────────────────────────────────

def build_handoff_summary(thread, reason=""):
    """Build a structured handoff summary from available thread data."""
    parts = []

    # What was done
    files = thread.get("files_touched", [])
    work_type = thread.get("work_type", "general")
    note = thread.get("last_note", "")
    if files:
        parts.append(f"What done: {work_type} on {', '.join(files[:5])}")
    elif note:
        parts.append(f"What done: {note}")

    # What failed
    failed = thread.get("failed_approaches", [])
    if failed:
        descs = [a.get("description", "")[:60] for a in failed[:3]]
        parts.append(f"What failed: {'; '.join(descs)}")

    # Current theory / status
    narrative = thread.get("narrative", "")
    if narrative:
        parts.append(f"Status: {narrative[:150]}")

    # Suggested next step
    if reason:
        parts.append(f"Next: {reason[:100]}")

    return " | ".join(parts) if parts else "Session stopped — no summary available"


# ── Main ───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()
    reason = hook_input.get("reason", "")

    memory_path = get_memory_path()
    memory = load_json(memory_path, {"version": "2", "project": "", "threads": []})

    # Auto-migrate V1
    if is_v1(memory):
        memory = migrate_v1_inline(memory)

    # Find the current session's thread and generate handoff summary
    for thread in memory.get("threads", []):
        if thread.get("session_id") == session_id and thread.get("status") in ("open", "stuck"):
            thread["last_activity_at"] = now
            thread["handoff_summary"] = build_handoff_summary(thread, reason)
            if reason:
                thread["last_note"] = reason[:200]
            break

    # Append JSONL audit line
    append_audit_line({
        "type": "stop",
        "user": user,
        "ts": now,
        "session_id": session_id,
        "reason": reason[:200] if reason else "stop_checkpoint",
    })

    save_json(memory_path, memory)
    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
