#!/usr/bin/env python3
"""session-end.py — Session Thread Capture (F1)

Hook: SessionEnd (Claude Code) / sessionEnd (Copilot CLI)
Parses session for files modified, writes thread record, appends audit.
"""

import json
import os
import re
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


def dump_debug(hook_input, label="session-end"):
    """Write raw hook input to a debug file for format discovery."""
    debug_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "hook-debug.log"
    )
    try:
        with open(debug_path, "a", encoding="utf-8") as f:
            f.write(f"[{label}] {json.dumps(hook_input, default=str)}\n")
    except Exception:
        pass


def extract_files_touched(hook_input):
    """Extract files touched from the hook input data."""
    files = set()
    cwd = hook_input.get("cwd", "")

    # Try to get files from the hook input directly
    if "files_touched" in hook_input:
        files.update(hook_input["files_touched"])

    # Parse the transcript JSONL file (Claude Code provides this)
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

                    # Look for tool_input with file paths in assistant messages
                    _extract_files_from_entry(entry, files, cwd)
        except (OSError, IOError):
            pass

    # Fall back to audit entries for this session
    if "session_id" in hook_input:
        session_id = hook_input["session_id"]
        memory_path = get_memory_path()
        try:
            with open(memory_path, "r", encoding="utf-8") as f:
                memory = json.load(f)
            for entry in memory.get("audit", []):
                if (entry.get("session_id") == session_id
                        and entry.get("type") == "tool_use"
                        and entry.get("file")):
                    files.add(entry["file"])
        except (FileNotFoundError, json.JSONDecodeError):
            pass

    return list(files)


# Tools that modify files (reads excluded intentionally)
WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "write", "edit", "multi_edit"}


def _get_content_blocks(entry):
    """Get content blocks from a transcript entry (handles nested message format)."""
    # Claude Code transcript format: entry.message.content[]
    message = entry.get("message", {})
    if isinstance(message, dict) and "content" in message:
        return message.get("content", [])
    # Fallback: direct content field
    return entry.get("content", [])


def _extract_files_from_entry(entry, files, cwd=""):
    """Extract file paths from write/edit tool uses in a transcript entry."""
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

                    # MultiEdit has a list of edits with file paths
                    for edit in tool_input.get("edits", []):
                        if isinstance(edit, dict):
                            for key in ("file_path", "path"):
                                if key in edit:
                                    files.add(_normalize_path(edit[key], cwd))
                                    break

        # Also check top-level tool_input (PostToolUse hook format)
        hook_tool = entry.get("tool_name", "")
        if hook_tool in WRITE_TOOLS:
            tool_input = entry.get("tool_input", {})
            if isinstance(tool_input, dict):
                for key in ("file_path", "filePath", "path", "file"):
                    if key in tool_input:
                        files.add(_normalize_path(tool_input[key], cwd))
                        break


def _normalize_path(file_path, cwd=""):
    """Make path relative to cwd if it's absolute."""
    if not file_path:
        return file_path
    if cwd and os.path.isabs(file_path):
        try:
            return os.path.relpath(file_path, cwd)
        except ValueError:
            pass
    return file_path


def _extract_user_prompt(hook_input):
    """Extract the first user prompt from the transcript."""
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
                # Claude Code format: entry.message.role
                message = entry.get("message", {})
                if not isinstance(message, dict):
                    continue
                role = message.get("role", entry.get("role", ""))
                if role != "user":
                    continue

                content_blocks = _get_content_blocks(entry)
                if not content_blocks:
                    continue

                # Handle character-array format: ["u", "p", "d", "a", "t", "e", ...]
                if all(isinstance(c, str) and len(c) <= 1 for c in content_blocks):
                    text = "".join(content_blocks).strip()
                    if text:
                        return text[:200]
                    continue

                # Handle normal format: [{"type": "text", "text": "..."}]
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


def extract_last_note(hook_input):
    """Extract a summary note from the session."""
    # Try explicit summary fields
    for key in ("summary", "last_message", "description"):
        note = hook_input.get(key, "")
        if note and isinstance(note, str):
            return note[:200]

    # Try to extract the first user prompt from the transcript
    prompt = _extract_user_prompt(hook_input)
    if prompt:
        return prompt

    # Use exit reason if available
    reason = hook_input.get("reason", "")
    reason_labels = {
        "prompt_input_exit": "User exited session",
        "stop": "Session stopped",
        "error": "Session ended with error",
    }
    if reason in reason_labels:
        return reason_labels[reason]

    # Try to build a note from files touched
    files = extract_files_touched(hook_input)
    if files:
        return f"Worked on {', '.join(files[:3])}{'...' if len(files) > 3 else ''}"[:200]

    return "Session completed"


def analyze_session_activities(hook_input):
    """Analyze the transcript to classify work type and key activities."""
    activities = []
    work_type = "general"
    tool_counts = {}
    errors_seen = []
    commands_run = []

    transcript_path = hook_input.get("transcript_path", "")
    if not transcript_path or not os.path.exists(transcript_path):
        return {"work_type": work_type, "activities": activities}

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
        return {"work_type": work_type, "activities": activities}

    # Classify work type from patterns
    has_edits = any(t in tool_counts for t in ("Write", "Edit", "MultiEdit"))
    has_errors = len(errors_seen) > 0
    has_test_runs = any(
        _is_test_command(cmd) for cmd in commands_run
    )
    has_log_inspection = any(
        _is_debug_command(cmd) for cmd in commands_run
    )
    has_git = any("git" in cmd.lower() for cmd in commands_run)
    has_install = any(
        _is_install_command(cmd) for cmd in commands_run
    )
    read_count = tool_counts.get("Read", 0)
    edit_count = sum(tool_counts.get(t, 0) for t in ("Write", "Edit", "MultiEdit"))

    # Check for documentation-focused work
    files_touched = set()
    for entry_data in _collect_edited_files(hook_input):
        files_touched.add(entry_data)
    is_docs = files_touched and all(
        f.endswith((".md", ".txt", ".rst", ".adoc")) for f in files_touched
    )

    # Determine primary work type
    # Order matters — most specific first
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

    # Build activity summary
    if has_errors:
        # Deduplicate and cap error summaries
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

    return {
        "work_type": work_type,
        "activities": activities[:8],
    }


def _analyze_entry(entry, tool_counts, errors_seen, commands_run):
    """Analyze a single transcript entry for tool usage and errors."""
    if not isinstance(entry, dict):
        return

    for content in _get_content_blocks(entry):
        if not isinstance(content, dict):
            continue

        # Count tool uses
        if content.get("type") == "tool_use":
            name = content.get("name", "")
            tool_counts[name] = tool_counts.get(name, 0) + 1
            tool_input = content.get("input", {})
            if isinstance(tool_input, dict) and "command" in tool_input:
                commands_run.append(tool_input["command"])

        # Detect errors — only explicit errors, NOT file content from Read tools
        if content.get("type") == "tool_result" and content.get("is_error"):
            text = ""
            result_content = content.get("content", "")
            if isinstance(result_content, str):
                text = result_content
            elif isinstance(result_content, list):
                text = " ".join(
                    c.get("text", "") for c in result_content
                    if isinstance(c, dict)
                )
            summary = _summarize_error(text)
            if summary:
                errors_seen.append(summary)

    # Also handle PostToolUse format (top-level fields)
    if "tool_name" in entry:
        name = entry["tool_name"]
        tool_counts[name] = tool_counts.get(name, 0) + 1
        tool_input = entry.get("tool_input", {})
        if isinstance(tool_input, dict) and "command" in tool_input:
            commands_run.append(tool_input["command"])

        # Check stderr and non-zero exit codes for errors
        resp = entry.get("tool_response", {})
        if isinstance(resp, dict):
            stderr = resp.get("stderr", "")
            if stderr and _looks_like_error(stderr):
                errors_seen.append(_summarize_error(stderr))


ERROR_PATTERNS = re.compile(
    r"(error|exception|traceback|failed|fatal|panic|ENOENT|EACCES|"
    r"segfault|undefined|TypeError|SyntaxError|ReferenceError|"
    r"ImportError|ModuleNotFoundError|KeyError|ValueError|"
    r"RuntimeError|ConnectionError|TimeoutError|PermissionError)",
    re.IGNORECASE,
)


def _looks_like_error(text):
    """Check if text contains error-like patterns."""
    if not text or len(text) < 10:
        return False
    return bool(ERROR_PATTERNS.search(text))


def _summarize_error(text):
    """Extract a short error summary (max 100 chars)."""
    if not text:
        return ""
    # Try to find the most relevant error line
    for line in text.split("\n"):
        line = line.strip()
        if line and ERROR_PATTERNS.search(line):
            return line[:100]
    return text.strip().split("\n")[0][:100]


def _is_test_command(cmd):
    """Check if a command looks like a test run."""
    patterns = ("test", "jest", "pytest", "mocha", "vitest", "rspec", "cargo test",
                "go test", "npm test", "yarn test", "pnpm test")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _is_debug_command(cmd):
    """Check if a command looks like debugging/log inspection."""
    patterns = ("log", "cat ", "tail ", "head ", "grep ", "less ", "journalctl",
                "docker logs", "kubectl logs", "console", "debug", "strace",
                "ltrace", "dmesg")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _is_install_command(cmd):
    """Check if a command looks like a dependency install."""
    patterns = ("npm install", "npm i ", "yarn add", "pip install", "cargo add",
                "go get", "brew install", "apt install", "pnpm add")
    cmd_lower = cmd.lower()
    return any(p in cmd_lower for p in patterns)


def _collect_edited_files(hook_input):
    """Quick scan of transcript for file names touched by write tools."""
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
                                    # Just the filename for extension checking
                                    files.add(os.path.basename(inp[key]))
                                    break
    except (OSError, IOError):
        pass
    return files


def detect_ai_tool(hook_input):
    """Detect whether this is Claude Code or Copilot CLI from the hook event format."""
    event = hook_input.get("hook_event_name", "")
    # Claude Code uses PascalCase: SessionEnd, PostToolUse
    # Copilot CLI uses camelCase: sessionEnd, postToolUse
    if event and event[0].isupper():
        return "claude-code"
    elif event and event[0].islower():
        return "copilot-cli"
    # Fallback: Claude Code sends transcript_path
    if "transcript_path" in hook_input:
        return "claude-code"
    return "unknown"


def find_existing_thread(threads, session_id):
    """Find an existing thread for this session."""
    for thread in threads:
        if thread.get("session_id") == session_id:
            return thread
    return None


def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    session_id = hook_input.get("session_id", os.environ.get("SESSION_ID", "unknown"))
    ai_tool = detect_ai_tool(hook_input)
    user = get_user()
    now = datetime.now(timezone.utc).isoformat()

    # Debug dump to capture actual hook input format
    dump_debug(hook_input)

    memory_path = get_memory_path()
    memory = load_memory(memory_path)

    files_touched = extract_files_touched(hook_input)
    last_note = extract_last_note(hook_input)
    session_analysis = analyze_session_activities(hook_input)

    # Find or create thread
    threads = memory.setdefault("threads", [])
    existing = find_existing_thread(threads, session_id)

    if existing:
        existing["files_touched"] = list(set(existing.get("files_touched", []) + files_touched))
        existing["last_note"] = last_note
        existing["tool"] = ai_tool
        existing["work_type"] = session_analysis["work_type"]
        existing["activities"] = session_analysis["activities"]
        existing["updated_at"] = now
        existing["status"] = "open"
    else:
        thread = {
            "id": str(uuid.uuid4()),
            "author": user,
            "tool": ai_tool,
            "session_id": session_id,
            "files_touched": files_touched,
            "work_type": session_analysis["work_type"],
            "activities": session_analysis["activities"],
            "status": "open",
            "last_note": last_note,
            "created_at": now,
            "updated_at": now,
        }
        threads.append(thread)

    # Append audit entry
    audit = memory.setdefault("audit", [])
    audit_entry = {
        "type": "session_end",
        "user": user,
        "timestamp": now,
        "session_id": session_id,
        "intent": last_note,
        "work_type": session_analysis["work_type"],
        "files_touched": files_touched,
        "reason": "session_complete",
    }
    audit.append(audit_entry)
    if len(audit) > 500:
        memory["audit"] = audit[-500:]

    save_memory(memory_path, memory)

    print(json.dumps({"output": ""}))


if __name__ == "__main__":
    main()
