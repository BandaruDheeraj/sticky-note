#!/usr/bin/env python3
"""inject-context.py — Prompt-Level Thread Surfacing (F3)

Hook: UserPromptSubmit (Claude Code) / userPromptSubmitted (Copilot CLI)
Keyword-matches the user prompt against open thread file paths.
Injects compact context only when relevant. Silent if no match.
"""

import json
import os
import sys


def get_memory_path():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "sticky-note.json")


def load_memory(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"config": {}, "threads": [], "audit": []}


def extract_keywords(prompt):
    """Extract potential file paths and keywords from the user prompt."""
    keywords = set()
    words = prompt.lower().replace("/", " ").replace("\\", " ").replace(".", " ").split()

    for word in words:
        cleaned = word.strip("()[]{}\"'`,;:")
        if len(cleaned) >= 2:
            keywords.add(cleaned)

    # Also check for path-like patterns in the original prompt
    for token in prompt.split():
        token = token.strip("()[]{}\"'`,;:")
        if "/" in token or "\\" in token or "." in token:
            keywords.add(token.lower())
            # Add individual path segments
            parts = token.replace("\\", "/").split("/")
            for part in parts:
                if len(part) >= 2:
                    keywords.add(part.lower())

    return keywords


def match_thread(thread, keywords):
    """Check if a thread's files match any of the prompt keywords."""
    if thread.get("status") not in ("open", "stuck"):
        return False

    for file_path in thread.get("files_touched", []):
        path_lower = file_path.lower()
        path_parts = set(
            path_lower.replace("\\", "/").replace(".", "/").split("/")
        )

        for keyword in keywords:
            if keyword in path_lower or keyword in path_parts:
                return True

    return False


def format_match(thread):
    """Format a matched thread for compact injection."""
    status_label = "[STUCK] " if thread.get("status") == "stuck" else ""
    author = thread.get("author", "unknown")
    files = ", ".join(thread.get("files_touched", [])[:3])
    note = thread.get("last_note", "")[:80]

    line = f"📌 {status_label}{author} was working on: {files}"
    if note:
        line += f" — {note}"
    return line


def main():
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
    except (json.JSONDecodeError, Exception):
        hook_input = {}

    prompt = hook_input.get("prompt", hook_input.get("user_prompt", ""))
    if not prompt:
        print(json.dumps({"output": ""}))
        return

    keywords = extract_keywords(prompt)
    if not keywords:
        print(json.dumps({"output": ""}))
        return

    memory_path = get_memory_path()
    memory = load_memory(memory_path)

    matches = []
    for thread in memory.get("threads", []):
        if match_thread(thread, keywords):
            matches.append(format_match(thread))

    if not matches:
        print(json.dumps({"output": ""}))
        return

    # Cap at 3 matches to keep context compact
    output_lines = matches[:3]
    if len(matches) > 3:
        output_lines.append(f"... and {len(matches) - 3} more related threads")

    output = "\n".join(output_lines)
    print(json.dumps({"output": output}))


if __name__ == "__main__":
    main()
