#!/usr/bin/env python3
"""on-error.py — Stuck Thread (V2)

Hook: errorOccurred (Copilot CLI)
Writes a thread with status="stuck" and captures the error message.
Appends JSONL audit line.
"""

import json
import os
import sys
import uuid
from datetime import datetime, timezone


# ── Paths ──────────────────────────────────────────────────

def _sticky_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "..", ".sticky-note")


def get_memory_path():
    return os.path.join(_sticky_dir(), "sticky-note.json")


def get_config_path():
    return os.path.join(_sticky_dir(), "sticky-note-config.json")


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


# ── Main───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
    tool_name = hook_input.get("tool_name", os.environ.get("TOOL_NAME", "unknown"))
    error_msg = hook_input.get("error", hook_input.get("message", "Unknown error"))[:200]
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()

    memory_path = get_memory_path()
    memory = load_json(memory_path, {"version": "2", "project": "", "threads": []})

    # Find existing threadfor this session or create a new one
    threads = memory.setdefault("threads", [])
    existing = None
    for thread in threads:
        if thread.get("session_id") == session_id:
            existing = thread
            break

    if existing:
        existing["status"] = "stuck"
        existing["last_note"] = error_msg
        existing["last_activity_at"] = now
        # Track as a failed approach
        failed = existing.setdefault("failed_approaches", [])
        failed.append({"description": error_msg[:150], "error": error_msg[:100]})
        failed[:] = failed[-5:]  # cap at 5
    else:
        thread = {
            "id": str(uuid.uuid4()),
            "user": user,
            "project": memory.get("project", ""),
            "status": "stuck",
            "branch": "",
            "created_at": now,
            "closed_at": None,
            "last_activity_at": now,
            "files_touched": [],
            "last_note": error_msg,
            "narrative": "",
            "failed_approaches": [{"description": error_msg[:150], "error": error_msg[:100]}],
            "handoff_summary": "",
            "related_session_ids": [],
            "tool": tool_name,
            "session_id": session_id,
        }
        threads.append(thread)

    # Append JSONL audit line
    append_audit_line({
        "type": "error",
        "user": user,
        "ts": now,
        "session_id": session_id,
        "error": error_msg,
        "tool": tool_name,
    })

    save_json(memory_path, memory)
    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
