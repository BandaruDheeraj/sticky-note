#!/usr/bin/env python3
"""parse-transcript.py — Standalone Transcript Parser (V2)

Extracts narrative + failed_approaches from a session transcript file.
Used by sticky-codex.sh to process Codex stdout/stderr logs.
Also usable standalone: python parse-transcript.py <transcript_path>

Outputs JSON to stdout: {"narrative": "...", "failed_approaches": [...]}
"""

import json
import os
import sys

from sticky_utils import (
    parse_jsonl_file,
    extract_narrative_from_entries, extract_narrative_from_text,
    extract_failed_from_entries, extract_failed_from_text,
)


def parse_plaintext_transcript(path):
    """Parse a plain-text transcript (Codex stdout/stderr capture)."""
    lines = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except (OSError, IOError):
        pass
    return lines


def parse_transcript(path):
    """Auto-detect format and extract narrative + failed_approaches."""
    entries = parse_jsonl_file(path)
    if entries:
        return {
            "narrative": extract_narrative_from_entries(entries),
            "failed_approaches": extract_failed_from_entries(entries),
        }

    lines = parse_plaintext_transcript(path)
    if lines:
        return {
            "narrative": extract_narrative_from_text(lines),
            "failed_approaches": extract_failed_from_text(lines),
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
    try:
        main()
    except Exception:
        print(json.dumps({"narrative": "", "failed_approaches": []}))
        sys.exit(0)
