#!/usr/bin/env python3
"""on-stop.py — Checkpoint Thread (Claude Code only)

Hook: Stop (Claude Code)
Checkpoints the current thread by updating its status and timestamp.
"""

import json
import os
import sys
from datetime import datetime, timezone


def get_memory_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "..", ".sticky-note", "sticky-note.json")


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
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()

    memory_path = get_memory_path()
    memory = load_memory(memory_path)

    # Find the current session's thread and checkpoint it
    for thread in memory.get("threads", []):
        if thread.get("session_id") == session_id and thread.get("status") == "open":
            thread["updated_at"] = now
            thread["last_note"] = (
                hook_input.get("reason", "Session stopped — checkpoint")
            )[:200]
            break

    # Append audit entry
    audit = memory.setdefault("audit", [])
    audit.append({
        "type": "session_end",
        "user": user,
        "timestamp": now,
        "session_id": session_id,
        "reason": "stop_checkpoint",
    })
    if len(audit) > 500:
        memory["audit"] = audit[-500:]

    save_memory(memory_path, memory)

    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
