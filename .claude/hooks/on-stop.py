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
import uuid
from datetime import datetime, timezone

from sticky_utils import get_memory_path, load_json, save_json, append_audit_line, get_user, get_branch


# ── Handoff summary────────────────────────────────────────

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
    except Exception:
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()
    reason = hook_input.get("reason", "")

    memory_path = get_memory_path()
    memory = load_json(memory_path, {"version": "2", "project": "", "threads": []})

    # Find the current session's thread and generate handoff summary
    threads = memory.get("threads", [])
    found = False
    for thread in threads:
        if thread.get("session_id") == session_id and thread.get("status") in ("open", "stuck"):
            thread["last_activity_at"] = now
            thread["handoff_summary"] = build_handoff_summary(thread, reason)
            if reason:
                thread["last_note"] = reason[:200]
            found = True
            break

    if not found and session_id != "unknown":
        thread = {
            "id": str(uuid.uuid4()),
            "user": user,
            "project": memory.get("project", ""),
            "status": "closed",
            "branch": get_branch(),
            "created_at": now,
            "closed_at": now,
            "last_activity_at": now,
            "files_touched": [],
            "last_note": reason[:200] if reason else "Session stopped",
            "narrative": "",
            "failed_approaches": [],
            "handoff_summary": build_handoff_summary({}, reason),
            "related_session_ids": [],
            "tool": "unknown",
            "session_id": session_id,
        }
        threads.append(thread)

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
