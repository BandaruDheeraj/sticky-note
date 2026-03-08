#!/usr/bin/env bash
# sticky-codex.sh — Codex wrapper for Sticky Note V2
#
# Captures Codex stdout/stderr to a temp session log.
# On exit: calls session-end.js with the transcript for
# narrative + failed_approaches extraction.
#
# Usage:
#   sticky-codex [codex args...]
#
# Setup:
#   npx sticky-note init --codex
#   alias sticky-codex="/path/to/.claude/hooks/sticky-codex.sh"
#
# Limitation: Context is printed to terminal after Codex exits,
# not injected into the Codex window. Per-prompt surfacing not available.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STICKY_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/.sticky-note"
SESSION_ID="codex-$(date +%s)-$$"
TRANSCRIPT_FILE=$(mktemp "${TMPDIR:-/tmp}/sticky-codex-XXXXXX.log")
USER="${USER:-${USERNAME:-unknown}}"

# Ensure .sticky-note directory exists
mkdir -p "$STICKY_DIR"

# Print context from sticky-note before starting Codex
echo ""
echo "📌 Sticky Note — injecting context for Codex session $SESSION_ID"
echo ""

if [ -f "$STICKY_DIR/sticky-note.json" ]; then
    node "$SCRIPT_DIR/session-start.js" <<EOF 2>/dev/null || true
{"session_id": "$SESSION_ID"}
EOF
fi

echo "─────────────────────────────────────────────"
echo ""

# Run Codex, capturing output
codex "$@" 2>&1 | tee "$TRANSCRIPT_FILE"
CODEX_EXIT=$?

echo ""
echo "─────────────────────────────────────────────"
echo "📌 Sticky Note — processing Codex session..."

# Parse transcript for narrative + failed_approaches
PARSED=$(node "$SCRIPT_DIR/parse-transcript.js" "$TRANSCRIPT_FILE" 2>/dev/null || echo '{"narrative":"","failed_approaches":[]}')

# Call session-end.js with the transcript info + parsed data
node "$SCRIPT_DIR/session-end.js" <<EOF 2>/dev/null || true
{
    "session_id": "$SESSION_ID",
    "transcript_path": "$TRANSCRIPT_FILE",
    "parsed_transcript": ${PARSED},
    "hook_event_name": "sessionEnd",
    "reason": "codex_exit"
}
EOF

# Cleanup transcript
rm -f "$TRANSCRIPT_FILE"

echo "[OK] Session $SESSION_ID recorded."
echo ""

exit $CODEX_EXIT
