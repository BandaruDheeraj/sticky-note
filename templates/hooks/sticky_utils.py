#!/usr/bin/env python3
"""sticky_utils.py — Shared utilities for Sticky Note hooks."""

import json
import os
import re
import subprocess


# ── Shared regex patterns ─────────────────────────────────

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


# ── Path helpers ──────────────────────────────────────────

def _sticky_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(script_dir, "..", "..", ".sticky-note")


def get_memory_path():
    return os.path.join(_sticky_dir(), "sticky-note.json")


def get_config_path():
    return os.path.join(_sticky_dir(), "sticky-note-config.json")


def get_audit_path():
    return os.path.join(_sticky_dir(), "sticky-note-audit.jsonl")


def get_presence_path():
    return os.path.join(_sticky_dir(), ".sticky-presence.json")


# ── JSON I/O ─────────────────────────────────────────────

def load_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default if default is not None else {}


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def append_audit_line(entry):
    path = get_audit_path()
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ── Environment helpers ───────────────────────────────────

def get_user():
    return os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"


def get_branch():
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


# ── Transcript parsing helpers ────────────────────────────

def parse_jsonl_file(path):
    """Read a JSONL file, returning a list of parsed dicts."""
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


def extract_narrative_from_entries(entries):
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
    """Extract narrative from plain-text lines."""
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

    for block in reversed(text_blocks):
        if len(block) > 20:
            return block[:300].strip()
    return ""


def extract_failed_from_entries(entries):
    """Extract failed approaches from JSONL transcript entries."""
    approaches = []

    for entry in entries:
        message = entry.get("message", {})
        if not isinstance(message, dict):
            continue
        content = message.get("content", entry.get("content", []))
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict) or block.get("type") != "text":
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


def extract_failed_from_text(lines):
    """Extract failed approaches from plain-text lines."""
    approaches = []
    full_text = "\n".join(lines)

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
