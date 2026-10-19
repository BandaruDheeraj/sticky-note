#!/usr/bin/env bash
# Scripted two-person demo: plays Alice's and Bob's Claude Code sessions by
# sending the same hook events Claude Code sends, through the real built CLI,
# and prints what each person and agent is shown. No Claude needed.
set -euo pipefail

SN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$SN_ROOT/dist/cli.js"
DEMO="$(mktemp -d)/sticky-demo"
trap 'rm -rf "$(dirname "$DEMO")"' EXIT

STICKY_DEMO_QUIET=1 "$SN_ROOT/scripts/demo-setup.sh" "$DEMO"
ALICE="$DEMO/alice"
BOB="$DEMO/bob"

bold=$'\e[1m'; dim=$'\e[2m'; cyan=$'\e[36m'; yellow=$'\e[33m'; reset=$'\e[0m'
[ -n "${NO_COLOR:-}" ] && bold= dim= cyan= yellow= reset=

scene() { printf '\n%s━━ %s%s\n' "$bold" "$1" "$reset"; }
say()   { printf '%s%s%s\n' "$dim" "$1" "$reset"; }
sn()    { local dir=$1; shift; (cd "$dir" && NO_COLOR=1 node "$BIN" "$@"); }

# hook <clone dir> <session id> <json fields...>: fire one hook, show what the person and the agent get.
hook() {
  local dir=$1 session=$2 fields=$3
  local out
  out=$(printf '{"session_id":"%s","cwd":"%s",%s}' "$session" "$dir" "$fields" | (cd "$dir" && node "$BIN" run-hook claude-code))
  [ -z "$out" ] && return 0
  node -e '
    const o = JSON.parse(process.argv[1]);
    const [y, c, d, r] = process.argv.slice(2);
    if (o.systemMessage) console.log(`${y}  you see › ${o.systemMessage}${r}`);
    const ctx = o.hookSpecificOutput?.additionalContext;
    if (ctx) console.log(`${c}  agent is told ›${r}\n${ctx.split("\n").map((l) => `${d}    ${l}${r}`).join("\n")}`);
  ' "$out" "$yellow" "$cyan" "$dim" "$reset"
}

scene "1. Alice starts a Claude Code session and asks for a fix"
say 'Alice: "In src/billing/invoice.js totals are sometimes a cent off. Switch to integer cents."'
hook "$ALICE" a1 '"hook_event_name":"SessionStart","source":"startup"'
hook "$ALICE" a1 '"hook_event_name":"UserPromptSubmit","prompt":"In src/billing/invoice.js totals are sometimes a cent off. Switch to integer cents."'
hook "$ALICE" a1 "\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ALICE/src/billing/invoice.js\"}"
hook "$ALICE" a1 "\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ALICE/src/billing/invoice.js\"}"
hook "$ALICE" a1 '"hook_event_name":"Stop"'
say "Her agent edited invoice.js and finished the turn. The thread was committed and pushed in the background."
sn "$ALICE" sync >/dev/null

scene "2. Bob checks who's working on what"
sn "$BOB" sync >/dev/null
sn "$BOB" who

scene "3. Bob starts his own session"
hook "$BOB" b1 '"hook_event_name":"SessionStart","source":"startup"'

scene "4. Bob asks for a change in the same file"
say 'Bob: "Add a discount parameter to computeTotal in src/billing/invoice.js"'
hook "$BOB" b1 '"hook_event_name":"UserPromptSubmit","prompt":"Add a discount parameter to computeTotal in src/billing/invoice.js"'
say "(Nothing new: Bob's agent already saw Alice's thread at session start.)"
say "Bob's agent is about to edit invoice.js:"
hook "$BOB" b1 "\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$BOB/src/billing/invoice.js\"}"

scene "5. Bob claims the auth module; Alice's agent is warned before touching it"
sn "$BOB" claim src/auth/session.js -m "rewriting sessions"
sn "$BOB" sync >/dev/null && sn "$ALICE" sync >/dev/null
say 'Alice: "Make session ids in src/auth/session.js use crypto.randomUUID"'
hook "$ALICE" a1 '"hook_event_name":"UserPromptSubmit","prompt":"Make session ids in src/auth/session.js use crypto.randomUUID"'
hook "$ALICE" a1 "\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$ALICE/src/auth/session.js\"}"

scene "6. Alice commits her fix and ends her session"
printf 'export function computeTotal(items, taxRate) {\n  const cents = items.reduce((s, i) => s + Math.round(i.price * 100) * i.quantity, 0);\n  return Math.round(cents * (1 + taxRate)) / 100;\n}\n' > "$ALICE/src/billing/invoice.js"
git -C "$ALICE" commit -qam "Compute invoice totals in integer cents"
git -C "$ALICE" push -q origin main
hook "$ALICE" a1 '"hook_event_name":"Stop"'
hook "$ALICE" a1 '"hook_event_name":"SessionEnd","reason":"prompt_input_exit"'
say "Her commit is now linked to her thread; session ended and synced."

scene "7. Later, a new session of Bob's reads invoice.js: git history leads back to Alice's thread"
git -C "$BOB" pull -q origin main
sn "$BOB" sync >/dev/null
hook "$BOB" b2 "\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"$BOB/src/billing/invoice.js\"}"

scene "8. The shared record"
sn "$BOB" threads -a
echo
sn "$BOB" claims
printf '\n%sDone. Everything above ran through the real CLI and git (temp dir, now removed).%s\n' "$dim" "$reset"
