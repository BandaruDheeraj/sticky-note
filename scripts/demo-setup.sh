#!/usr/bin/env bash
# Creates a two-person sticky-note demo: a shared remote and two clones
# ("alice" and "bob") of a tiny sample app, each with its own git identity
# and Claude Code hooks pointing at this checkout's build.
#
#   scripts/demo-setup.sh [dir]     default dir: ~/sticky-demo
set -euo pipefail

SN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$SN_ROOT/dist/cli.js"
DEMO="${1:-$HOME/sticky-demo}"
QUIET="${STICKY_DEMO_QUIET:-}"

[ -f "$BIN" ] || { echo "Build first: (cd $SN_ROOT && npm run build)" >&2; exit 1; }
if [ -e "$DEMO" ]; then
  echo "$DEMO already exists. Remove it first (rm -rf \"$DEMO\") or pass another directory." >&2
  exit 1
fi

mkdir -p "$DEMO"
git init -q --bare -b main "$DEMO/remote.git"

# Seed the sample app.
SEED="$DEMO/.seed"
git init -q -b main "$SEED"
mkdir -p "$SEED/src/billing" "$SEED/src/auth"
cat > "$SEED/README.md" <<'EOF'
# Acme Shop (sticky-note demo app)

A tiny app for trying sticky-note with two people.
EOF
cat > "$SEED/src/billing/invoice.js" <<'EOF'
// Totals are computed in floating point, so some come out a cent off.
export function computeTotal(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(subtotal * (1 + taxRate) * 100) / 100;
}
EOF
cat > "$SEED/src/auth/session.js" <<'EOF'
const sessions = new Map();

export function createSession(userId) {
  const id = Math.random().toString(36).slice(2);
  sessions.set(id, { userId, createdAt: Date.now() });
  return id;
}

export function getSession(id) {
  return sessions.get(id) ?? null;
}
EOF
git -C "$SEED" add -A
git -C "$SEED" -c user.name=Setup -c user.email=setup@example.com commit -q -m "Acme Shop sample app"
git -C "$SEED" push -q "$DEMO/remote.git" main
rm -rf "$SEED"

for person in alice bob; do
  name="$(tr '[:lower:]' '[:upper:]' <<< "${person:0:1}")${person:1}"
  git clone -q "$DEMO/remote.git" "$DEMO/$person"
  git -C "$DEMO/$person" config user.name "$name"
  git -C "$DEMO/$person" config user.email "$person@example.com"
  # The first init can't fetch a data branch that doesn't exist yet; that warning is expected.
  (cd "$DEMO/$person" && node "$BIN" init --hook-command "node \"$BIN\"" >/dev/null 2>&1)
done

[ -n "$QUIET" ] && exit 0
cat <<EOF

Demo ready in $DEMO
  remote.git   shared remote (stands in for GitHub)
  alice/       Alice's clone   (git user: Alice <alice@example.com>)
  bob/         Bob's clone     (git user: Bob <bob@example.com>)

Use this to run sticky-note in either clone:
  alias sn='node "$BIN"'

Live demo with two Claude Code sessions:

  1. Terminal A (Alice):
       cd $DEMO/alice && claude
     Approve the project hooks if asked (/hooks to check). Prompt:
       "In src/billing/invoice.js totals are sometimes a cent off. Switch to integer cents."
     Let it edit the file. Keep this session open.

  2. Terminal C (anyone), a few seconds after Alice's first turn ends:
       cd $DEMO/bob && sn sync && sn who
     Alice shows as active on "In src/billing/invoice.js totals ..." with the file she edited.

  3. Terminal B (Bob):
       cd $DEMO/bob && sn sync && claude
     At start you'll see:  sticky-note: 1 related thread (1 in progress) ...
     Prompt:
       "Add a discount parameter to computeTotal in src/billing/invoice.js"
     Before editing, Claude is warned and you see:
       sticky-note: Alice is working on src/billing/invoice.js (...)

  4. Claims. In terminal C:
       cd $DEMO/bob && sn claim src/auth/session.js -m "rewriting sessions" && sn sync
       cd $DEMO/alice && sn sync      # Alice's session would also pick it up within ~2 min
     In Alice's session: "Make session ids in src/auth/session.js use crypto.randomUUID"
     Before editing, Alice sees:  sticky-note: Bob has claimed src/auth/session.js (rewriting sessions)

  5. Exit both sessions, then:  cd $DEMO/alice && sn sync && sn threads -a

Clean up afterwards with:  rm -rf "$DEMO"
EOF
