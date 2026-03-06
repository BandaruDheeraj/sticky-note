#!/usr/bin/env python3
"""parse-transcript.py — Standalone Transcript Parser (V2)

Extracts narrative + failed_approaches from a session transcript file.
Used by sticky-codex.sh to process Codex stdout/stderr logs.
Also usable standalone: python parse-transcript.py <transcript_path>

Outputs JSON to stdout: {"narrative": "...", "failed_approaches": [...]}
"""

import json
import os
import re
import sys


ERROR_PATTERNS = re.compile(
    r"(error|exception|traceback|failed|fatal|panic|ENOENT|EACCES|"
    r"segfault|undefined|TypeError|SyntaxError|ReferenceError|"
    r"ImportError|ModuleNotFoundError|KeyError|ValueError|"
    r"RuntimeError|ConnectionError|TimeoutError|PermissionError)",
    re.IGNORECASE,
)

RETRY_PATTERNS = re.compile(
    r"(try again|let me try|didn't work|doesn't work|failed|let's try|"
    r"another approach|instead|alternatively|that approach|this doesn't|"
    r"that didn't|won't work|can't|cannot)",
    re.IGNORECASE,
)

FILE_PATH_PATTERN = re.compile(
    r"[\w./\\-]+\.\w{1,10}"
)


def parse_jsonl_transcript(path):
    """Parse a JSONL transcript (Claude Code format)."""
    entries = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except (OSError, IOError):
        pass
    return entries


def parse_plaintext_transcript(path):
    """Parse a plain-text transcript (Codex stdout/stderr capture)."""
    lines = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, IOError):
        pass
    return lines


def extract_narrative_from_jsonl(entries):
    """Extract narrative from JSONL transcript entries."""
    last_texts = []
    for entry in entries:
        message = entry.get("message", {})
        if not isinstance(message, dict):
            continue
        role = message.get("role", entry.get("role", ""))
        if role != "assistant":
            continue
        content = message.get("content", entry.get("content", []))
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    text = block["text"].strip()
                    if text:
                        last_texts.append(text)

    if not last_texts:
        return ""
    return last_texts[-1][:300].strip()


def extract_narrative_from_text(lines):
    """Extract narrative from plain-text transcript."""
    # Use the last substantial block of text as narrative
    text_blocks = []
    current_block = []

    for line in lines:
        stripped = line.strip()
        if stripped:
            current_block.append(stripped)
        elif current_block:
            text_blocks.append(" ".join(current_block))
            current_block = []

    if current_block:
        text_blocks.append(" ".join(current_block))

    if not text_blocks:
        return ""

    # Return the last substantial block
    for block in reversed(text_blocks):
        if len(block) > 20:
            return block[:300].strip()
    return ""


def extract_failed_approaches_from_jsonl(entries):
    """Extract failed approaches from JSONL transcript."""
    approaches = []

    for entry in entries:
        message = entry.get("message", {})
        if not isinstance(message, dict):
            continue
        content = message.get("content", entry.get("content", []))
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") != "text":
                continue
            text = block.get("text", "")
            if RETRY_PATTERNS.search(text) and ERROR_PATTERNS.search(text):
                error_match = ERROR_PATTERNS.search(text)
                error_ctx = text[max(0, error_match.start() - 40):error_match.end() + 60].strip() if error_match else ""
                files_tried = FILE_PATH_PATTERN.findall(text)[:5]
                approaches.append({
                    "description": text[:150].strip(),
                    "error": error_ctx[:100],
                    "files_tried": files_tried,
                })

    return approaches[:5]


def extract_failed_approaches_from_text(lines):
    """Extract failed approaches from plain-text transcript."""
    approaches = []
    full_text = "\n".join(lines)

    # Split into paragraphs and look for error+retry patterns
    paragraphs = full_text.split("\n\n")
    for para in paragraphs:
        if RETRY_PATTERNS.search(para) and ERROR_PATTERNS.search(para):
            error_match = ERROR_PATTERNS.search(para)
            error_ctx = para[max(0, error_match.start() - 40):error_match.end() + 60].strip() if error_match else ""
            files_tried = FILE_PATH_PATTERN.findall(para)[:5]
            approaches.append({
                "description": para[:150].strip(),
                "error": error_ctx[:100],
                "files_tried": files_tried,
            })

    return approaches[:5]


def parse_transcript(path):
    """Auto-detect format and extract narrative + failed_approaches."""
    # Try JSONL first
    entries = parse_jsonl_transcript(path)
    if entries:
        return {
            "narrative": extract_narrative_from_jsonl(entries),
            "failed_approaches": extract_failed_approaches_from_jsonl(entries),
        }

    # Fall back to plain text
    lines = parse_plaintext_transcript(path)
    if lines:
        return {
            "narrative": extract_narrative_from_text(lines),
            "failed_approaches": extract_failed_approaches_from_text(lines),
        }

    return {"narrative": "", "failed_approaches": []}


def main():
    if len(sys.argv) < 2:
        print("Usage: parse-transcript.py <transcript_path>", file=sys.stderr)
        sys.exit(1)

    transcript_path = sys.argv[1]
    if not os.path.exists(transcript_path):
        print(json.dumps({"narrative": "", "failed_approaches": []}))
        return

    result = parse_transcript(transcript_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
