#!/usr/bin/env python3
"""inject-context.py — Relevance-Scored Thread Injection (V2)

Hook: UserPromptSubmit (Claude Code) / userPromptSubmitted (Copilot CLI)
Scores threads by file overlap, branch, recency, stuck status, same dev.
Injects top 3-5 most relevant threads under a 300-token budget.
"""

import json
import os
import subprocess
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
        get_memory_path, load_json, save_json, get_user, get_branch,
        get_resume_thread_id, find_thread_by_id, get_session_id,
        append_audit_line,
    )
except Exception:
    if __name__ == "__main__":
        _safe_exit()


def get_recently_modified_files():
    """Get files modified in recent commits (proxy for current work area)."""
    files = set()
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD~5"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            files.update(f.strip() for f in result.stdout.strip().split("\n") if f.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    # Also include uncommitted changes
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            files.update(f.strip() for f in result.stdout.strip().split("\n") if f.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass
    return files


# ── Keyword extraction ─────────────────────────────────────

def extract_keywords(prompt):
    keywords = set()
    words = prompt.lower().replace("/", " ").replace("\\", " ").replace(".", " ").split()

    for word in words:
        cleaned = word.strip("()[]{}\"'`,;:")
        if len(cleaned) >= 2:
            keywords.add(cleaned)

    for token in prompt.split():
        token = token.strip("()[]{}\"'`,;:")
        if "/" in token or "\\" in token or "." in token:
            keywords.add(token.lower())
            parts = token.replace("\\", "/").split("/")
            for part in parts:
                if len(part) >= 2:
                    keywords.add(part.lower())

    return keywords


# ── Relevance scoring ──────────────────────────────────────

def score_thread(thread, recently_modified, current_branch, current_user, prompt_keywords):
    """Score a thread for relevance. Higher = more relevant."""
    if thread.get("status") in ("expired", "stale"):
        return -1

    score = 0.0
    now = datetime.now(timezone.utc)

    # File overlap (weight 3) — highest signal
    thread_files = set(thread.get("files_touched", []))
    overlap = thread_files & recently_modified
    if overlap:
        score += 3 * min(len(overlap), 5)

    # Prompt keyword match against thread files
    for file_path in thread_files:
        path_lower = file_path.lower()
        path_parts = set(path_lower.replace("\\", "/").replace(".", "/").split("/"))
        for kw in prompt_keywords:
            if kw in path_lower or kw in path_parts:
                score += 1
                break

    # Branch match (weight 2)
    if current_branch and thread.get("branch") == current_branch:
        score += 2

    # Recency (weight 2) — decay over days
    ts_field = (
        thread.get("last_activity_at")
        or thread.get("updated_at")
        or thread.get("created_at", "")
    )
    if ts_field:
        try:
            ts = datetime.fromisoformat(ts_field.replace("Z", "+00:00"))
            days_ago = max((now - ts).total_seconds() / 86400, 0)
            recency = max(2 - (days_ago * 0.2), 0)
            score += recency
        except (ValueError, TypeError):
            pass

    # Stuck boost (+2)
    if thread.get("status") == "stuck":
        score += 2

    # Same developer (weight 1)
    thread_user = thread.get("user") or thread.get("author", "")
    if thread_user == current_user:
        score += 1

    return score


# ── Formatting ─────────────────────────────────────────────

def format_top_thread(thread):
    """Full detail for top-scoring thread."""
    user = thread.get("user") or thread.get("author", "unknown")
    status = thread.get("status", "open")
    files = ", ".join(thread.get("files_touched", [])[:3])
    narrative = thread.get("narrative", "")
    failed = thread.get("failed_approaches", [])
    branch = thread.get("branch", "")

    status_icon = "🔴" if status == "stuck" else "🟢" if status == "open" else "⚪"
    line = f"{status_icon} {files} · {user}"
    if branch:
        line += f" · {branch}"
    ts_field = thread.get("last_activity_at") or thread.get("updated_at", "")
    if ts_field:
        line += f" · {_relative_time(ts_field)}"
    line += "\n"

    if narrative:
        line += narrative[:200] + "\n"
    elif thread.get("last_note"):
        line += thread["last_note"][:150] + "\n"

    # Include conversation prompts for cross-tool context
    prompts = thread.get("prompts", [])
    if prompts:
        line += f"Conversation ({len(prompts)} prompt(s)):\n"
        for i, p in enumerate(prompts[:5], 1):
            line += f"  {i}. {p[:120]}\n"
        if len(prompts) > 5:
            line += f"  ... and {len(prompts) - 5} more\n"

    if failed:
        line += f"{len(failed)} failed approach(es)."
        line += f" Full context: ask get_session_context(\"{thread.get('id', '')}\")\n"

    return line.strip()


def format_summary_thread(thread):
    """One-liner for matches 2-5."""
    user = thread.get("user") or thread.get("author", "unknown")
    status = thread.get("status", "open")
    files = ", ".join(thread.get("files_touched", [])[:2])
    note = thread.get("last_note", "")[:60]

    status_icon = "🔴" if status == "stuck" else "🟢" if status == "open" else "⚪"
    line = f"{status_icon} {files} · {user}"
    if note:
        line += f" — {note}"
    return line


def _relative_time(ts_str):
    try:
        ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        delta = now - ts
        hours = delta.total_seconds() / 3600
        if hours < 1:
            return f"{int(delta.total_seconds() / 60)}min ago"
        elif hours < 24:
            return f"{int(hours)}hrs ago"
        else:
            return f"{int(hours / 24)}d ago"
    except (ValueError, TypeError):
        return ""


# ── Main ───────────────────────────────────────────────────

def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    prompt = hook_input.get("prompt", hook_input.get("user_prompt", ""))
    if not prompt:
        print(json.dumps({"output": ""}))
        return

    # Log user prompt to audit trail so session-end can use it
    session_id = get_session_id(hook_input)
    try:
        append_audit_line({
            "type": "user_prompt",
            "user": get_user(),
            "ts": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "prompt": prompt[:500],
        })
    except (OSError, IOError):
        pass  # Audit write failure must not block context injection

    memory = load_json(get_memory_path(), {"version": "2", "threads": []})
    threads = memory.get("threads", [])

    # Only consider live threads
    live = [t for t in threads if t.get("status") in ("open", "stuck", "closed")]
    if not live:
        print(json.dumps({"output": ""}))
        return

    keywords = extract_keywords(prompt)
    current_branch = get_branch()
    current_user = get_user()
    recently_modified = get_recently_modified_files()

    # Score all live threads
    resume_thread_id = get_resume_thread_id()
    memory_dirty = False

    # Mid-session resume: reopen the thread if signal file exists
    if resume_thread_id:
        resumed = find_thread_by_id(threads, resume_thread_id)
        if resumed and resumed.get("status") != "open":
            resumed["status"] = "open"
            resumed["last_activity_at"] = datetime.now(timezone.utc).isoformat()
            session_id = get_session_id(hook_input)
            related = resumed.setdefault("related_session_ids", [])
            if session_id not in related:
                related.append(session_id)
            memory_dirty = True

    scored = []
    for t in live:
        s = score_thread(t, recently_modified, current_branch, current_user, keywords)
        # Resumed thread always surfaces first
        if resume_thread_id and t.get("id") == resume_thread_id:
            s = max(s, 0) + 10
        if s > 0:
            scored.append((s, t))

    if memory_dirty:
        try:
            save_json(get_memory_path(), memory)
        except (OSError, IOError):
            pass  # Memory save failure must not block context injection

    scored.sort(key=lambda x: x[0], reverse=True)

    if not scored:
        print(json.dumps({"output": ""}))
        return

    # Token budget: ~300 tokens max
    MAX_TOKENS = 300
    token_count = 10  # header overhead

    output_lines = []
    threads_shown = 0

    for i, (score, thread) in enumerate(scored[:5]):
        if i == 0:
            block = format_top_thread(thread)
        else:
            block = format_summary_thread(thread)

        token_count += len(block) // 4
        if token_count > MAX_TOKENS:
            remaining = len(scored) - i
            if remaining > 0:
                output_lines.append(f"... and {remaining} more relevant threads")
            break
        output_lines.append(block)
        threads_shown += 1

    header = f"[STICKY NOTE — {threads_shown} relevant thread{'s' if threads_shown != 1 else ''}]\n"
    output_lines.insert(0, header)

    output = "\n".join(output_lines).strip()
    print(json.dumps({"output": output}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _safe_exit()
