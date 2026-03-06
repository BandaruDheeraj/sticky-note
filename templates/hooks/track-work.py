#!/usr/bin/env python3
"""track-work.py — Audit Trail (V2)

Hook: PostToolUse (Claude Code) / postToolUse (Copilot CLI)
Appends one JSONL line per tool call. Updates presence heartbeat.
"""

import json
import os
import sys
from datetime import datetime, timezone

from sticky_utils import (
    get_config_path, get_presence_path,
    load_json, save_json, append_audit_line, get_user,
)


# ── File extraction────────────────────────────────────────

def extract_file_path(hook_input):
    cwd = hook_input.get("cwd", "")
    raw_path = None

    for container_key in ("tool_input", "input", "toolInput", "params"):
        container = hook_input.get(container_key, {})
        if isinstance(container, dict):
            for key in ("file_path", "filePath", "path", "filename", "file"):
                if key in container:
                    raw_path = container[key]
                    break
        if raw_path:
            break

    if not raw_path:
        for key in ("file_path", "filePath", "path", "file"):
            if key in hook_input:
                raw_path = hook_input[key]
                break

    if not raw_path:
        return None

    if cwd and os.path.isabs(raw_path):
        try:
            return os.path.relpath(raw_path, cwd)
        except ValueError:
            pass
    return raw_path


# ── Presence heartbeat ─────────────────────────────────────

def update_presence(user, file_path):
    path = get_presence_path()
    try:
        data = load_json(path, {})
        entry = data.get(user, {"active_files": [], "last_seen": ""})

        if file_path:
            active = entry.get("active_files", [])
            if file_path not in active:
                active.append(file_path)
            entry["active_files"] = active[-10:]  # cap at 10

        entry["last_seen"] = datetime.now(timezone.utc).isoformat()
        data[user] = entry
        save_json(path, data)
    except Exception:
        pass


# ── MCP auto-detect ────────────────────────────────────────

def auto_detect_mcp(tool_name):
    """If tool_name is mcp__serverName__toolName, return server info."""
    if not tool_name or not tool_name.startswith("mcp__"):
        return None
    parts = tool_name.split("__")
    if len(parts) >= 2:
        return parts[1]
    return None


# ── Main ───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
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

    # Append JSONL audit line
    entry = {
        "type": "tool_use",
        "user": user,
        "ts": now,
        "tool": tool_name,
        "session_id": session_id,
    }
    if file_path:
        entry["file"] = file_path
    append_audit_line(entry)

    # Update presence heartbeat
    update_presence(user, file_path)

    # Auto-detect MCP servers → save to config
    server_name = auto_detect_mcp(tool_name)
    if server_name:
        config_path = get_config_path()
        config = load_json(config_path, {"stale_days": 14, "mcp_servers": []})
        mcp_servers = config.setdefault("mcp_servers", [])
        known_names = {
            s.get("name") if isinstance(s, dict) else s for s in mcp_servers
        }
        if server_name not in known_names:
            mcp_servers.append({"name": server_name, "source": "auto-detected"})
            save_json(config_path, config)

    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
