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


def _safe_exit():
    """Output valid JSON and exit cleanly — used when imports fail."""
    try:
        print(json.dumps({"output": ""}))
    except Exception:
        print('{"output": ""}')
    sys.exit(0)


try:
    from sticky_utils import get_memory_path, load_json, save_json, append_audit_line, get_user, detect_tool, get_session_id
except Exception:
    if __name__ == "__main__":
        _safe_exit()


# ── Main───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except Exception:
        hook_input = {}

    session_id = get_session_id(hook_input)
    tool_name = hook_input.get("tool_name", os.environ.get("TOOL_NAME", "unknown"))
    if tool_name == "unknown":
        tool_name = detect_tool(hook_input)
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
    try:
        main()
    except BaseException:
        _safe_exit()
