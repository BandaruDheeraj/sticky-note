#!/usr/bin/env python3
"""session-start.py — Session Start Hook (V2)

Hook: SessionStart (Claude Code) / sessionStart (Copilot CLI)
Loads open+stuck threads, ages stale threads, injects context.
Reads presence file if recent. Writes audit line to JSONL.
"""

import json
import os
import sys
from datetime import datetime, timezone, timedelta

from sticky_utils import (
    get_memory_path, get_config_path, get_presence_path,
    load_json, save_json, append_audit_line, get_user, get_session_id,
    get_resume_thread_id, find_thread_by_id,
)


# ── Thread logic───────────────────────────────────────────

def age_stale_threads(memory, stale_days):
    now = datetime.now(timezone.utc)
    changed = False

    for thread in memory.get("threads", []):
        if thread.get("status") not in ("open", "stuck"):
            continue
        ts_field = (
            thread.get("last_activity_at")
            or thread.get("updated_at")
            or thread.get("created_at", "")
        )
        if not ts_field:
            continue
        try:
            ts = datetime.fromisoformat(ts_field.replace("Z", "+00:00"))
            if (now - ts).days >= stale_days and thread["status"] == "open":
                thread["status"] = "stale"
                thread["last_activity_at"] = now.isoformat()
                changed = True
        except (ValueError, TypeError):
            continue

    return changed


def format_threads_for_injection(threads, max_threads=10, max_tokens=500):
    active = [t for t in threads if t.get("status") in ("open", "stuck")]
    active.sort(key=lambda t: t.get("last_activity_at") or t.get("updated_at", ""), reverse=True)
    active = active[:max_threads]

    if not active:
        return ""

    lines = ["## 📌 Teammate Threads (Sticky Note)\n"]
    token_estimate = 10

    for t in active:
        status_label = "[STUCK] " if t.get("status") == "stuck" else ""
        work_type = t.get("work_type", "")
        type_label = f"[{work_type}] " if work_type and work_type != "general" else ""
        author = t.get("user") or t.get("author", "unknown")
        files = ", ".join(t.get("files_touched", [])[:5])
        note = t.get("last_note", "")[:100]
        narrative = t.get("narrative", "")
        branch = t.get("branch", "")

        line = f"- {status_label}{type_label}**{author}**"
        if branch:
            line += f" ({branch})"
        line += f": {files}"
        if narrative:
            line += f" — _{narrative[:100]}_"
        elif note:
            line += f" — _{note}_"

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


def format_presence(presence_data):
    now = datetime.now(timezone.utc)
    active = []
    for user, info in presence_data.items():
        last_seen = info.get("last_seen", "")
        if not last_seen:
            continue
        try:
            ts = datetime.fromisoformat(last_seen.replace("Z", "+00:00"))
            if (now - ts) < timedelta(minutes=15):
                files = ", ".join(info.get("active_files", [])[:3])
                active.append(f"- **{user}** active on: {files}")
        except (ValueError, TypeError):
            continue

    if not active:
        return ""
    return "\n## 👥 Active Now\n" + "\n".join(active)


# ── Main ───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = get_session_id(hook_input)

    memory_path = get_memory_path()
    memory = load_json(memory_path, {"version": "2", "project": "", "threads": []})

    config = load_json(get_config_path(), {"stale_days": 14})
    stale_days = config.get("stale_days", 14)

    # Age stale threads
    age_stale_threads(memory, stale_days)

    # Check for thread resume signal
    resume_thread_id = get_resume_thread_id()
    resumed_thread = None
    if resume_thread_id:
        threads = memory.get("threads", [])
        resumed_thread = find_thread_by_id(threads, resume_thread_id)
        if resumed_thread:
            resumed_thread["status"] = "open"
            resumed_thread.setdefault("related_session_ids", []).append(session_id)
            resumed_thread["last_activity_at"] = datetime.now(timezone.utc).isoformat()
            save_json(memory_path, memory)

    # Build injection context
    thread_context = format_threads_for_injection(memory.get("threads", []))
    config_context = format_config_for_injection(config)

    # Read presence
    presence_data = load_json(get_presence_path(), {})
    presence_context = format_presence(presence_data)

    # Append audit line (JSONL)
    append_audit_line({
        "type": "session_start",
        "user": get_user(),
        "ts": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
    })

    # Save updated memory
    save_json(memory_path, memory)

    # Output injection context
    parts = []

    # Resumed thread gets top billing
    if resumed_thread:
        resume_lines = [f"## 🔄 Resumed Thread — {resumed_thread.get('id', '')[:8]}\n"]
        files = ", ".join(resumed_thread.get("files_touched", [])[:10])
        if files:
            resume_lines.append(f"**Files:** {files}")
        if resumed_thread.get("branch"):
            resume_lines.append(f"**Branch:** {resumed_thread['branch']}")
        work_type = resumed_thread.get("work_type", "")
        if work_type and work_type != "general":
            resume_lines.append(f"**Work type:** {work_type}")
        activities = resumed_thread.get("activities", [])
        if activities:
            resume_lines.append(f"**Activities:** {', '.join(activities[:6])}")
        if resumed_thread.get("narrative"):
            resume_lines.append(f"**Context:** {resumed_thread['narrative']}")
        elif resumed_thread.get("last_note"):
            resume_lines.append(f"**Context:** {resumed_thread['last_note']}")
        failed = resumed_thread.get("failed_approaches", [])
        if failed:
            resume_lines.append(f"**⚠️ {len(failed)} failed approach(es):**")
            for fa in failed[:3]:
                desc = fa.get("description", "")[:100]
                resume_lines.append(f"  - {desc}")
        if resumed_thread.get("handoff_summary"):
            resume_lines.append(f"**Handoff:** {resumed_thread['handoff_summary']}")
        related = resumed_thread.get("related_session_ids", [])
        if len(related) > 1:
            resume_lines.append(f"**Sessions:** this is session #{len(related)} on this thread")
        resume_lines.append("")
        resume_lines.append(
            "**→ Start by giving the user a brief recap of what happened in "
            "the previous session(s) on this thread — what was worked on, "
            "what was accomplished, what problems were hit, and what's left to do. "
            "Then ask how they'd like to proceed.**"
        )
        parts.append("\n".join(resume_lines))

    parts.extend([p for p in [thread_context, config_context, presence_context] if p])
    output = "\n".join(parts).strip()
    print(json.dumps({"output": output}, ensure_ascii=False))


if __name__ == "__main__":
    main()
