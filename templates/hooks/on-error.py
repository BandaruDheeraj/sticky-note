#!/usr/bin/env python3
"""on-error.py — Stuck Thread (F1b, Copilot CLI only)

Hook: errorOccurred (Copilot CLI)
Writes a thread with status="stuck" and captures the error message.
"""

import json
import os
import sys
import uuid
from datetime import datetime, timezone


def get_memory_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "sticky-note.json")


def load_memory(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"config": {}, "threads": [], "audit": []}


def save_memory(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def get_user():
    return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


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
    memory = load_memory(memory_path)

    # Find existing thread for this session or create a new one
    threads = memory.setdefault("threads", [])
    existing = None
    for thread in threads:
        if thread.get("session_id") == session_id:
            existing = thread
            break

    if existing:
        existing["status"] = "stuck"
        existing["last_note"] = error_msg
        existing["updated_at"] = now
    else:
        thread = {
            "id": str(uuid.uuid4()),
            "author": user,
            "tool": tool_name,
            "session_id": session_id,
            "files_touched": [],
            "status": "stuck",
            "last_note": error_msg,
            "created_at": now,
            "updated_at": now,
        }
        threads.append(thread)

    # Append audit entry
    audit = memory.setdefault("audit", [])
    audit.append({
        "type": "error",
        "user": user,
        "timestamp": now,
        "session_id": session_id,
        "error": error_msg,
        "tool": tool_name,
    })
    if len(audit) > 500:
        memory["audit"] = audit[-500:]

    save_memory(memory_path, memory)

    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
