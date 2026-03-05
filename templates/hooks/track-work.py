#!/usr/bin/env python3
"""track-work.py — Audit Trail (F4)

Hook: PostToolUse (Claude Code) / postToolUse (Copilot CLI)
Appends an audit entry per tool call with user, timestamp, tool, file, session_id.
Rolling cap of 500 entries.
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


def extract_file_path(hook_input):
    """Extract the file path from tool use data, normalized to relative."""
    cwd = hook_input.get("cwd", "")
    raw_path = None

    # Try all known input container field names (varies by tool)
    for container_key in ("tool_input", "input", "toolInput", "params"):
        container = hook_input.get(container_key, {})
        if isinstance(container, dict):
            for key in ("file_path", "filePath", "path", "filename", "file"):
                if key in container:
                    raw_path = container[key]
                    break
        if raw_path:
            break

    # Try top-level fields
    if not raw_path:
        for key in ("file_path", "filePath", "path", "file"):
            if key in hook_input:
                raw_path = hook_input[key]
                break

    if not raw_path:
        return None

    # Normalize to relative path
    if cwd and os.path.isabs(raw_path):
        try:
            return os.path.relpath(raw_path, cwd)
        except ValueError:
            pass
    return raw_path


def dump_debug(hook_input):
    """Write raw hook input to a debug file for format discovery."""
    debug_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", ".sticky-note", "hook-debug.log"
    )
    try:
        with open(debug_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(hook_input, default=str) + "\n")
    except Exception:
        pass


def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    # Dump raw input for debugging (remove after format is confirmed)
    dump_debug(hook_input)

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
    # Tool name may be a string field or nested in a tool object
    tool_name = hook_input.get("tool_name", "unknown")
    if tool_name == "unknown":
        tool_obj = hook_input.get("tool", "unknown")
        if isinstance(tool_obj, dict):
            tool_name = tool_obj.get("name", "unknown")
        elif isinstance(tool_obj, str):
            tool_name = tool_obj
    file_path = extract_file_path(hook_input)
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()

    memory_path = get_memory_path()
    memory = load_memory(memory_path)

    # Append audit entry
    entry = {
        "type": "tool_use",
        "user": user,
        "timestamp": now,
        "session_id": session_id,
        "tool": tool_name,
    }
    if file_path:
        entry["file"] = file_path

    audit = memory.setdefault("audit", [])
    audit.append(entry)

    # Auto-detect MCP servers from tool name pattern (mcp__serverName__toolName)
    if tool_name.startswith("mcp__"):
        parts = tool_name.split("__")
        if len(parts) >= 2:
            server_name = parts[1]
            config = memory.setdefault("config", {})
            mcp_servers = config.setdefault("mcp_servers", [])
            known_names = {
                s.get("name") if isinstance(s, dict) else s
                for s in mcp_servers
            }
            if server_name not in known_names:
                mcp_servers.append({
                    "name": server_name,
                    "source": "auto-detected",
                })

    # Rolling cap
    if len(audit) > 500:
        memory["audit"] = audit[-500:]

    save_memory(memory_path, memory)

    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
