#!/usr/bin/env python3
"""session-end.py — Session Thread Capture (V2)

Hook: SessionEnd (Claude Code) / sessionEnd (Copilot CLI)
Parses session for files modified, writes richer thread record,
appends JSONL audit line, runs lazy tombstone sweep, clears presence.
"""

import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone, timedelta

from sticky_utils import (
    get_memory_path, get_config_path, get_audit_path, get_presence_path,
    load_json, save_json, append_audit_line, get_user, get_branch,
    detect_tool, get_session_id,
    get_resume_thread_id, find_thread_by_id, clear_resume_signal,
    parse_jsonl_file, extract_narrative_from_entries, extract_failed_from_entries,
    ERROR_PATTERNS, RETRY_PATTERNS,
    extract_session_from_audit,
    clear_session_file,
    read_head_sha, clear_head_file,
)


# ── Transcript parsing─────────────────────────────────────

WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "write", "edit", "multi_edit"}


def _get_content_blocks(entry):
    message = entry.get("message", {})
    if isinstance(message, dict) and "content" in message:
        return message.get("content", [])
    return entry.get("content", [])


def _normalize_path(file_path, cwd=""):
    if not file_path:
        return file_path
    if cwd and os.path.isabs(file_path):
        try:
            return os.path.relpath(file_path, cwd)
        except ValueError:
            pass
    return file_path


def _extract_files_from_entry(entry, files, cwd=""):
    if isinstance(entry, dict):
        for content in _get_content_blocks(entry):
            if not isinstance(content, dict):
                continue
            if content.get("type") == "tool_use":
                tool_name = content.get("name", "")
                if tool_name not in WRITE_TOOLS:
                    continue
                tool_input = content.get("input", {})
                if isinstance(tool_input, dict):
                    for key in ("file_path", "filePath", "path", "file"):
                        if key in tool_input:
                            files.add(_normalize_path(tool_input[key], cwd))
                            break
                    for edit in tool_input.get("edits", []):
                        if isinstance(edit, dict):
                            for key in ("file_path", "path"):
                                if key in edit:
                                    files.add(_normalize_path(edit[key], cwd))
                                    break

        hook_tool = entry.get("tool_name", "")
        if hook_tool in WRITE_TOOLS:
            tool_input = entry.get("tool_input", {})
            if isinstance(tool_input, dict):
                for key in ("file_path", "filePath", "path", "file"):
                    if key in tool_input:
                        files.add(_normalize_path(tool_input[key], cwd))
                        break


def extract_files_touched(hook_input):
    files = set()
    cwd = hook_input.get("cwd", "")

    if "files_touched" in hook_input:
        files.update(hook_input["files_touched"])

    transcript_path = hook_input.get("transcript_path", "")
    if transcript_path and os.path.exists(transcript_path):
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    _extract_files_from_entry(entry, files, cwd)
        except (OSError, IOError):
            pass

    # Fall back to JSONL audit for this session
    if "session_id" in hook_input:
        session_id = hook_input["session_id"]
        audit_path = get_audit_path()
        if os.path.exists(audit_path):
            try:
                with open(audit_path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if (entry.get("session_id") == session_id
                                and entry.get("type") == "tool_use"
                                and entry.get("file")):
                            files.add(entry["file"])
            except (OSError, IOError):
                pass

    return list(files)


STICKY_FILES = {".sticky-note/sticky-note.json", ".sticky-note/sticky-note-audit.jsonl",
                ".sticky-note/.sticky-session", ".sticky-note/.sticky-head",
                ".sticky-note/.sticky-resume", ".sticky-note/.sticky-debug.jsonl",
                ".sticky-note/sticky-note-config.json", ".sticky-note/presence.json"}


def get_git_files_touched():
    """Use git to detect files changed since session start (tool-agnostic fallback)."""
    files = set()
    saved_sha = read_head_sha()

    try:
        # Files changed between session-start HEAD and current HEAD (committed during session)
        if saved_sha:
            result = subprocess.run(
                ["git", "diff", "--name-only", saved_sha, "HEAD"],
                capture_output=True, text=True, timeout=5,
            )
            if result.returncode == 0:
                for f in result.stdout.strip().splitlines():
                    f = f.strip()
                    if f:
                        files.add(f)

        # Uncommitted changes in working tree
        result = subprocess.run(
            ["git", "diff", "--name-only"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            for f in result.stdout.strip().splitlines():
                f = f.strip()
                if f:
                    files.add(f)

        # Staged but not yet committed
        result = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            for f in result.stdout.strip().splitlines():
                f = f.strip()
                if f:
                    files.add(f)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Filter out sticky-note internal files — normalize to forward slash for comparison
    return [f for f in files if f.replace("\\", "/") not in STICKY_FILES
            and not f.replace("\\", "/").startswith(".sticky-note/.sticky-")]


def _extract_user_prompt(hook_input):
    transcript_path = hook_input.get("transcript_path", "")
    if not transcript_path or not os.path.exists(transcript_path):
        return None

    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                message = entry.get("message", {})
                if not isinstance(message, dict):
                    continue
                role = message.get("role", entry.get("role", ""))
                if role != "user":
                    continue

                content_blocks = _get_content_blocks(entry)
                if not content_blocks:
                    continue

                if all(isinstance(c, str) and len(c) <= 1 for c in content_blocks):
                    text = "".join(content_blocks).strip()
                    if text:
                        return text[:200]
                    continue

                for content in content_blocks:
                    if isinstance(content, dict) and content.get("type") == "text":
                        text = content["text"].strip()
                        if text:
                            return text[:200]
                    elif isinstance(content, str) and len(content) > 1:
                        return content.strip()[:200]
    except (OSError, IOError):
        pass

    return None


def extract_narrative(hook_input):
    """Extract a narrative summary from the last assistant messages."""
    transcript_path = hook_input.get("transcript_path", "")
    if transcript_path and os.path.exists(transcript_path):
        entries = parse_jsonl_file(transcript_path)
        narrative = extract_narrative_from_entries(entries)
        if narrative:
            return narrative

    # Fallback: build narrative from audit trail user prompts
    session_id = get_session_id(hook_input)
    audit_data = extract_session_from_audit(session_id)
    prompts = audit_data.get("prompts", [])
    if prompts:
        # Combine first and last prompt for context
        if len(prompts) == 1:
            return prompts[0][:300].strip()
        summary = f"{prompts[0][:150].strip()}"
        if len(prompts) > 2:
            summary += f" … ({len(prompts)} prompts total) … {prompts[-1][:100].strip()}"
        else:
            summary += f" → {prompts[-1][:100].strip()}"
        return summary[:300]

    return ""


def extract_failed_approaches(hook_input):
    """Extract failed approaches from transcript retry/error patterns."""
    transcript_path = hook_input.get("transcript_path", "")
    if not transcript_path or not os.path.exists(transcript_path):
        return []

    entries = parse_jsonl_file(transcript_path)
    return extract_failed_from_entries(entries)


def extract_last_note(hook_input, narrative="", session_analysis=None, audit_data=None):
    # Best: explicit summary from hook input (e.g. Claude Code stop reason)
    for key in ("summary", "last_message", "description"):
        note = hook_input.get(key, "")
        if note and isinstance(note, str):
            return note[:200]

    work_type = ""
    activities = []
    if session_analysis:
        work_type = session_analysis.get("work_type", "")
        activities = session_analysis.get("activities", [])

    # Good: narrative from last assistant message combined with work type
    if narrative and narrative not in ("Session completed", ""):
        prefix = f"[{work_type}] " if work_type and work_type != "general" else ""
        return f"{prefix}{narrative}"[:200]

    # OK: synthesize from work type + activities + files
    if work_type and work_type != "general" and activities:
        return f"[{work_type}] {', '.join(activities[:4])}"[:200]

    if activities:
        return ", ".join(activities[:4])[:200]

    reason = hook_input.get("reason", "")
    reason_labels = {
        "prompt_input_exit": "User exited session",
        "stop": "Session stopped",
        "error": "Session ended with error",
    }
    if reason in reason_labels:
        label = reason_labels[reason]
        if work_type and work_type != "general":
            return f"[{work_type}] {label}"[:200]
        return label

    files = extract_files_touched(hook_input)
    if files:
        prefix = f"[{work_type}] " if work_type and work_type != "general" else ""
        return f"{prefix}Worked on {', '.join(files[:3])}{'...' if len(files) > 3 else ''}"[:200]

    # Fallback: first user prompt from audit trail
    if audit_data is None:
        session_id = get_session_id(hook_input)
        audit_data = extract_session_from_audit(session_id)
    first_prompt = audit_data.get("first_prompt", "")
    if first_prompt:
        return first_prompt[:200]

    return "Session completed"


# ── Activity analysis ──────────────────────────────────────

def analyze_session_activities(hook_input, audit_data=None):
    activities = []
    work_type = "general"
    tool_counts = {}
    errors_seen = []
    commands_run = []

    transcript_path = hook_input.get("transcript_path", "")
    has_transcript = transcript_path and os.path.exists(transcript_path)

    if has_transcript:
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    _analyze_entry(entry, tool_counts, errors_seen, commands_run)
        except (OSError, IOError):
            has_transcript = False

    # Fallback: use audit trail for tool counts and files
    if not has_transcript:
        if audit_data is None:
            session_id = get_session_id(hook_input)
            audit_data = extract_session_from_audit(session_id)
        audit_tools = audit_data.get("tools", {})
        audit_files = audit_data.get("files", [])
        if audit_tools or audit_files:
            tool_counts = audit_tools
            if audit_files:
                edit_like = {"edit", "create", "write", "Edit", "Write", "MultiEdit",
                             "multi_edit", "editedExistingFile", "createdNewFile"}
                audit_edit_count = sum(
                    c for t, c in audit_tools.items() if t in edit_like
                )
                if audit_edit_count > 0:
                    activities.append(f"edited {audit_edit_count} file(s)")
                activities.append(f"touched {len(audit_files)} file(s)")
            num_prompts = len(audit_data.get("prompts", []))
            if num_prompts > 0:
                activities.append(f"{num_prompts} prompt(s)")
            # If we have tool usage but no specific activities yet, summarize tool count
            if not activities and audit_tools:
                total_calls = sum(audit_tools.values())
                activities.append(f"used {total_calls} tool(s)")
            return {"work_type": work_type, "activities": activities[:8]}

    if not tool_counts and not has_transcript:
        return {"work_type": work_type, "activities": activities}

    has_edits = any(t in tool_counts for t in ("Write", "Edit", "MultiEdit"))
    has_errors = len(errors_seen) > 0
    has_test_runs = any(_is_test_command(cmd) for cmd in commands_run)
    has_log_inspection = any(_is_debug_command(cmd) for cmd in commands_run)
    has_git = any("git" in cmd.lower() for cmd in commands_run)
    has_install = any(_is_install_command(cmd) for cmd in commands_run)
    read_count = tool_counts.get("Read", 0)
    edit_count = sum(tool_counts.get(t, 0) for t in ("Write", "Edit", "MultiEdit"))

    files_touched = set()
    for entry_data in _collect_edited_files(hook_input):
        files_touched.add(entry_data)
    is_docs = files_touched and all(
        f.endswith((".md", ".txt", ".rst", ".adoc")) for f in files_touched
    )

    if has_errors and (has_log_inspection or has_test_runs):
        work_type = "debugging"
    elif has_errors and has_edits:
        work_type = "bug-fix"
    elif has_test_runs and not has_edits:
        work_type = "testing"
    elif has_test_runs and has_edits:
        work_type = "test-writing"
    elif is_docs and has_edits:
        work_type = "documentation"
    elif has_edits and not has_errors:
        work_type = "feature-development"
    elif has_install:
        work_type = "setup"
    elif read_count > 0 and not has_edits:
        work_type = "code-review"
    elif has_git and not has_edits:
        work_type = "investigation"
    elif not has_edits and (has_log_inspection or has_test_runs):
        work_type = "investigation"

    if has_errors:
        unique_errors = list(dict.fromkeys(errors_seen))[:3]
        for err in unique_errors:
            activities.append(f"error: {err}")
    if has_test_runs:
        activities.append("ran tests")
    if has_log_inspection:
        activities.append("inspected logs/output")
    if has_git:
        git_cmds = [cmd for cmd in commands_run if "git" in cmd.lower()]
        if any("log" in c for c in git_cmds):
            activities.append("reviewed git history")
        if any("diff" in c for c in git_cmds):
            activities.append("reviewed diffs")
        if any("checkout" in c or "branch" in c for c in git_cmds):
            activities.append("switched branches")
    if has_install:
        activities.append("installed dependencies")
    if edit_count > 0:
        activities.append(f"edited {edit_count} file(s)")

    return {"work_type": work_type, "activities": activities[:8]}


def _analyze_entry(entry, tool_counts, errors_seen, commands_run):
    if not isinstance(entry, dict):
        return
    for content in _get_content_blocks(entry):
        if not isinstance(content, dict):
            continue
        if content.get("type") == "tool_use":
            name = content.get("name", "")
            tool_counts[name] = tool_counts.get(name, 0) + 1
            tool_input = content.get("input", {})
            if isinstance(tool_input, dict) and "command" in tool_input:
                commands_run.append(tool_input["command"])
        if content.get("type") == "tool_result" and content.get("is_error"):
            text = ""
            result_content = content.get("content", "")
            if isinstance(result_content, str):
                text = result_content
            elif isinstance(result_content, list):
                text = " ".join(
                    c.get("text", "") for c in result_content if isinstance(c, dict)
                )
            summary = _summarize_error(text)
            if summary:
                errors_seen.append(summary)

    if "tool_name" in entry:
        name = entry["tool_name"]
        tool_counts[name] = tool_counts.get(name, 0) + 1
        tool_input = entry.get("tool_input", {})
        if isinstance(tool_input, dict) and "command" in tool_input:
            commands_run.append(tool_input["command"])
        resp = entry.get("tool_response", {})
        if isinstance(resp, dict):
            stderr = resp.get("stderr", "")
            if stderr and _looks_like_error(stderr):
                errors_seen.append(_summarize_error(stderr))


def _looks_like_error(text):
    if not text or len(text) < 10:
        return False
    return bool(ERROR_PATTERNS.search(text))


def _summarize_error(text):
    if not text:
        return ""
    for line in text.split("\n"):
        line = line.strip()
        if line and ERROR_PATTERNS.search(line):
            return line[:100]
    return text.strip().split("\n")[0][:100]


def _is_test_command(cmd):
    patterns = ("test", "jest", "pytest", "mocha", "vitest", "rspec", "cargo test",
                "go test", "npm test", "yarn test", "pnpm test")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _is_debug_command(cmd):
    patterns = ("log", "cat ", "tail ", "head ", "grep ", "less ", "journalctl",
                "docker logs", "kubectl logs", "console", "debug", "strace",
                "ltrace", "dmesg")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _is_install_command(cmd):
    patterns = ("npm install", "npm i ", "yarn add", "pip install", "cargo add",
                "go get", "brew install", "apt install", "pnpm add")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _collect_edited_files(hook_input):
    files = set()
    transcript_path = hook_input.get("transcript_path", "")
    if not transcript_path or not os.path.exists(transcript_path):
        return files
    try:
        with open(transcript_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for content in _get_content_blocks(entry):
                    if not isinstance(content, dict):
                        continue
                    if content.get("type") == "tool_use" and content.get("name") in WRITE_TOOLS:
                        inp = content.get("input", {})
                        if isinstance(inp, dict):
                            for key in ("file_path", "path", "file"):
                                if key in inp:
                                    files.add(os.path.basename(inp[key]))
                                    break
    except (OSError, IOError):
        pass
    return files


# ── Tombstone expiry ───────────────────────────────────────

def tombstone_sweep(threads, stale_days):
    """Tombstone closed threads past stale_days. Returns count of tombstoned."""
    now = datetime.now(timezone.utc)
    count = 0
    for thread in threads:
        if thread.get("status") != "closed":
            continue
        ts_field = thread.get("last_activity_at") or thread.get("closed_at") or thread.get("updated_at", "")
        if not ts_field:
            continue
        try:
            ts = datetime.fromisoformat(ts_field.replace("Z", "+00:00"))
            if (now - ts).days >= stale_days:
                # Strip payload, keep ID for audit references
                closed_at = thread.get("closed_at") or ts_field
                user = thread.get("user") or thread.get("author", "unknown")
                thread_id = thread.get("id", "")
                thread.clear()
                thread["id"] = thread_id
                thread["status"] = "expired"
                thread["user"] = user
                thread["closed_at"] = closed_at
                count += 1
        except (ValueError, TypeError):
            continue
    return count


# ── Presence ───────────────────────────────────────────────

def clear_presence(user):
    path = get_presence_path()
    try:
        data = load_json(path, {})
        if user in data:
            del data[user]
            save_json(path, data)
    except Exception:
        pass


# ── AI tool detection ──────────────────────────────────────

def detect_ai_tool(hook_input):
    return detect_tool(hook_input)


# ── Main ───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = get_session_id(hook_input)
    ai_tool = detect_ai_tool(hook_input)
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()
    branch = get_branch()

    memory_path = get_memory_path()
    memory = load_json(memory_path, {"version": "2", "project": "", "threads": []})

    config = load_json(get_config_path(), {"stale_days": 14})
    stale_days = config.get("stale_days", 14)

    files_touched = extract_files_touched(hook_input)

    # Pre-fetch audit data once so we don't read the file multiple times
    audit_data = extract_session_from_audit(session_id)

    session_analysis = analyze_session_activities(hook_input, audit_data=audit_data)
    narrative = extract_narrative(hook_input)
    failed = extract_failed_approaches(hook_input)
    last_note = extract_last_note(
        hook_input, narrative=narrative,
        session_analysis=session_analysis, audit_data=audit_data,
    )

    # Merge audit trail files into files_touched
    audit_files = audit_data.get("files", [])
    if audit_files:
        files_touched = list(set(files_touched + audit_files))

    # Git-based fallback: detect files changed since session start
    git_files = get_git_files_touched()
    if git_files:
        files_touched = list(set(files_touched + git_files))

    # Find or create thread — resume signal takes priority over session_id match
    threads = memory.setdefault("threads", [])
    existing = None

    resume_thread_id = get_resume_thread_id()
    if resume_thread_id:
        existing = find_thread_by_id(threads, resume_thread_id)
        if existing:
            # Link this session to the resumed thread
            related = existing.setdefault("related_session_ids", [])
            if session_id not in related:
                related.append(session_id)
        clear_resume_signal()

    if not existing:
        for thread in threads:
            if thread.get("session_id") == session_id:
                existing = thread
                break

    # Store conversation prompts in the thread for cross-tool resume
    prompts = audit_data.get("prompts", [])
    if prompts:
        # Truncate each prompt and cap the list for reasonable JSON size
        stored_prompts = [p[:300] for p in prompts[:20]]
    else:
        stored_prompts = []

    if existing:
        existing["files_touched"] = list(set(existing.get("files_touched", []) + files_touched))
        existing["last_note"] = last_note
        existing["tool"] = ai_tool
        existing["work_type"] = session_analysis["work_type"]
        existing["activities"] = session_analysis["activities"]
        existing["last_activity_at"] = now
        existing["status"] = "closed"
        existing["closed_at"] = now
        existing["branch"] = branch or existing.get("branch", "")
        if narrative:
            existing["narrative"] = narrative
        if failed:
            existing["failed_approaches"] = failed
        if stored_prompts:
            prev = existing.get("prompts", [])
            existing["prompts"] = (prev + stored_prompts)[-20:]
    else:
        thread = {
            "id": str(uuid.uuid4()),
            "user": user,
            "project": memory.get("project", ""),
            "status": "closed",
            "branch": branch,
            "created_at": now,
            "closed_at": now,
            "last_activity_at": now,
            "files_touched": files_touched,
            "last_note": last_note,
            "narrative": narrative,
            "failed_approaches": failed,
            "handoff_summary": "",
            "related_session_ids": [],
            "tool": ai_tool,
            "session_id": session_id,
            "work_type": session_analysis["work_type"],
            "activities": session_analysis["activities"],
            "prompts": stored_prompts,
        }
        threads.append(thread)

    # Lazy tombstone sweep
    tombstone_sweep(threads, stale_days)

    # Append JSONL audit line
    append_audit_line({
        "type": "session_end",
        "user": user,
        "ts": now,
        "session_id": session_id,
        "status": "closed",
        "files_touched": files_touched,
        "work_type": session_analysis["work_type"],
    })

    # Clear presence, session file, and HEAD snapshot
    clear_presence(user)
    clear_session_file()
    clear_head_file()

    save_json(memory_path, memory)
    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"output": ""}))
