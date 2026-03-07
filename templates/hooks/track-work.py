#!/usr/bin/env python3
"""track-work.py — Audit Trail (V2)

Hook: PostToolUse (Claude Code) / postToolUse (Copilot CLI)
Appends one JSONL line per tool call. Updates presence heartbeat.
"""

import json
import os
import sys
from datetime import datetime, timezone


def _safe_exit():
    """Output valid JSON and exit cleanly — used when imports fail."""
    try:
        print(json.dumps({"output": ""}))
    except Exception:
        print('{"output": ""}')
    sys.exit(0)


try:
    from sticky_utils import (
        get_config_path, get_presence_path,
        load_json, save_json, append_audit_line, get_user,
        detect_tool, get_session_id, _sticky_dir,
    )
except Exception:
    if __name__ == "__main__":
        _safe_exit()


WRITE_TOOLS = {"edit", "Edit", "create", "Create", "Write", "write", "MultiEdit", "multi_edit"}


def _log_debug(tool_name, hook_input):
    """Log raw hook_input when file extraction fails for a write tool."""
    if tool_name not in WRITE_TOOLS:
        return
    try:
        debug_path = os.path.join(_sticky_dir(), ".sticky-debug.jsonl")
        entry = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "tool": tool_name,
            "hook_input_keys": sorted(hook_input.keys()),
            "hook_input": {k: v for k, v in hook_input.items()
                          if k not in ("output", "result", "stdout", "stderr")},
        }
        with open(debug_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, default=str) + "\n")
    except (OSError, IOError, TypeError):
        pass


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
    except (OSError, IOError, json.JSONDecodeError):
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

    session_id = get_session_id(hook_input)
    tool_name = hook_input.get("tool_name", "unknown")
    if tool_name == "unknown":
        tool_obj = hook_input.get("tool", "unknown")
        if isinstance(tool_obj, dict):
            tool_name = tool_obj.get("name", "unknown")
        elif isinstance(tool_obj, str):
            tool_name = tool_obj
    if tool_name == "unknown":
        for key in ("toolName", "name"):
            val = hook_input.get(key)
            if val and isinstance(val, str):
                tool_name = val
                break

    file_path = extract_file_path(hook_input)
    if not file_path:
        _log_debug(tool_name, hook_input)
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
    try:
        main()
    except BaseException:
        _safe_exit()
