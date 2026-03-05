#!/usr/bin/env python3
"""session-start.py — Teammate Thread Injection (F2)

Hook: SessionStart (Claude Code) / sessionStart (Copilot CLI)
Loads open+stuck threads, ages stale threads, injects context.
"""

import json
import os
import sys
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


def age_stale_threads(memory):
    stale_days = memory.get("config", {}).get("stale_days", 3)
    now = datetime.now(timezone.utc)
    changed = False

    for thread in memory.get("threads", []):
        if thread.get("status") not in ("open", "stuck"):
            continue
        updated = thread.get("updated_at", thread.get("created_at", ""))
        if not updated:
            continue
        try:
            updated_dt = datetime.fromisoformat(updated.replace("Z", "+00:00"))
            delta = (now - updated_dt).days
            if delta >= stale_days and thread["status"] == "open":
                thread["status"] = "stale"
                thread["updated_at"] = now.isoformat()
                changed = True
        except (ValueError, TypeError):
            continue

    return changed


def format_threads_for_injection(threads, max_threads=10, max_tokens=500):
    active = [t for t in threads if t.get("status") in ("open", "stuck")]
    active.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
    active = active[:max_threads]

    if not active:
        return ""

    lines = ["## 📌 Teammate Threads (Sticky Note)\n"]
    token_estimate = 10

    for t in active:
        status_label = "[STUCK] " if t.get("status") == "stuck" else ""
        work_type = t.get("work_type", "")
        type_label = f"[{work_type}] " if work_type and work_type != "general" else ""
        author = t.get("author", "unknown")
        files = ", ".join(t.get("files_touched", [])[:5])
        note = t.get("last_note", "")[:100]
        activities = t.get("activities", [])

        line = f"- {status_label}{type_label}**{author}**: {files}"
        if note:
            line += f" — _{note}_"
        if activities:
            line += f"\n  Activities: {', '.join(activities[:4])}"

        # Rough token estimate: ~1 token per 4 chars
        token_estimate += len(line) // 4
        if token_estimate > max_tokens:
            lines.append(f"- ... and {len(active) - len(lines) + 1} more threads")
            break
        lines.append(line)

    return "\n".join(lines)


def format_config_for_injection(config):
    lines = []

    conventions = config.get("conventions", [])
    if conventions:
        lines.append("\n## 📋 Team Conventions")
        for c in conventions[:10]:
            lines.append(f"- {c}")

    mcp_servers = config.get("mcp_servers", [])
    if mcp_servers:
        lines.append("\n## 🔌 MCP Servers")
        for s in mcp_servers[:5]:
            if isinstance(s, dict):
                lines.append(f"- {s.get('name', 'unnamed')}: {s.get('url', '')}")
            else:
                lines.append(f"- {s}")

    return "\n".join(lines) if lines else ""


def append_audit(memory, session_id):
    entry = {
        "type": "session_start",
        "user": get_user(),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
    }
    audit = memory.setdefault("audit", [])
    audit.append(entry)
    # Rolling cap
    if len(audit) > 500:
        memory["audit"] = audit[-500:]


def main():
    # Read hook input from stdin
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))

    memory_path = get_memory_path()
    memory = load_memory(memory_path)

    # Age stale threads
    age_stale_threads(memory)

    # Build injection context
    thread_context = format_threads_for_injection(memory.get("threads", []))
    config_context = format_config_for_injection(memory.get("config", {}))

    # Append audit entry
    append_audit(memory, session_id)

    # Save updated memory
    save_memory(memory_path, memory)

    # Output injection context
    output = ""
    if thread_context:
        output += thread_context
    if config_context:
        output += "\n" + config_context

    if output:
        result = {"output": output.strip()}
    else:
        result = {"output": ""}

    print(json.dumps(result))


if __name__ == "__main__":
    main()
