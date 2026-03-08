# What Changes in V3.5 — Migration Path

V2.5 proves the architecture. V3.5 upgrades the storage layer.

---

## One-Command Migration

```bash
npx sticky-note migrate --to cloud
```

This single command:
1. Points the attribution engine at V3's cloud API instead of local lookups
2. Enables `resume-thread` to search cloud thread index (no push required)
3. Preserves all V2.5 features, response shapes, and CLI commands

---

## What V3.5 Changes

| Component | V2.5 (Local) | V3.5 (Cloud) |
|-----------|-------------|-------------|
| **Thread store** | `.sticky-note/sticky-note.json` | Cloud API |
| **Audit data** | `.sticky-note/audit/*.jsonl` | Cloud API |
| **SHA lookup** | Local Git Notes + audit JSONL | Cloud index query |
| **Resume scope** | Same machine (push required) | Cross-machine |
| **Attribution query** | ~50ms (local git blame + file I/O) | ~200ms (API call) |
| **Lazy injection** | PreToolUse → local attribution | PreToolUse → cloud attribution |

---

## What V3.5 Does NOT Change

- **CLI commands** — same `resume-thread` and `get-line-attribution` interfaces
- **Hook architecture** — same PreToolUse, SessionStart, SessionEnd hooks
- **Thread schema** — same fields, same format
- **Two-tier injection** — same eager/lazy model
- **Built-in attribution** — git blame still used for line-level mapping

---

## Why V2.5 Before V3

1. **Earlier value** — developers get right-context-at-right-moment before
   cloud infrastructure exists
2. **Traction signal** — V2.5 usage data (resume frequency, lazy injection
   rate) justifies V3's infrastructure investment
3. **Proven architecture** — V3.5 becomes a storage swap, not a feature build

---

## Migration Checklist

When V3.5 ships:

- [ ] Run `npx sticky-note migrate --to cloud`
- [ ] Verify `npx sticky-note status` shows cloud attribution
- [ ] Test `resume-thread` across machines (no push needed)
- [ ] Local files remain as fallback (auto-sync to cloud)

No data loss. No breaking changes. One command.
