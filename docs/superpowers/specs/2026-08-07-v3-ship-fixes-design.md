# V3 Pre-Ship Fixes — Design Spec

**Date:** 2026-08-07  
**Branch:** feature/v3  
**Status:** Approved for implementation

---

## Context

The Cloudflare-based V3 backend is feature-complete but has four gaps blocking ship:

1. `deploy-backend` doesn't provision the `STICKY_API_KEY` on the Worker
2. No smoke tests cover cloud CLI commands or cloud transport
3. MCP server is local-only; cloud threads are invisible to it
4. Docs don't mention the MCP cloud limitation (now moot after fix 3)

---

## Fix 1: API Key Provisioning in `cmdDeployBackend`

**File:** `bin/cli.js` — `cmdDeployBackend()` (~line 2920)

After the Worker is deployed and `workerUrl` is extracted, add **Step 3**:

1. Generate a crypto-random API key: `require('crypto').randomBytes(24).toString('base64url')`
2. Pipe it into `wrangler secret put STICKY_API_KEY` via stdin (Wrangler reads secrets from stdin)
3. Append `STICKY_API_KEY=<key>` to `.env.sticky` alongside `STICKY_URL`
4. Print: `[OK] API key set — share STICKY_URL and STICKY_API_KEY with your team`

**Why this matters:** Without this, the Worker runs unauthenticated (open to anyone).  
**No new dependencies** — uses Node's built-in `crypto` module.

---

## Fix 2: Smoke Tests

**File:** `test/smoke.test.js` — append to existing test block

Three new tests:

### 2a. `migrate --to cloud` fails without STICKY_URL
- Run `migrate --to cloud` with no `STICKY_URL` env var and no `.env.sticky` in tmpDir
- Assert exit code 1 and stdout includes `STICKY_URL`

### 2b. `useCloud()` returns false by default
- `require()` sticky-utils from the installed hooks dir
- Assert `utils.useCloud() === false` (no `STICKY_URL` set in test env)

### 2c. `deploy-backend` errors when wrangler missing
- Run with a PATH that excludes wrangler (empty PATH override on Unix; skip on Windows if PATH override is unsafe)
- Assert exit code 1 and output mentions `wrangler`

---

## Fix 3: Cloud-Aware MCP Server

**File:** `bin/mcp-server.js`

**Approach:** Startup-time cloud sync. On boot, if `.env.sticky` provides `STICKY_URL`, fetch threads and presence from the cloud backend before accepting any MCP requests. Cache in memory; all 9 tool handlers read from cache (falling back to local disk if cloud is unavailable).

### New additions to `mcp-server.js`

**`readEnvSticky()`** — reads `.env.sticky` from `PROJECT_ROOT`, returns `{ STICKY_URL, STICKY_API_KEY }`. Mirrors the same helper in `sticky-utils.js` (inline copy to keep zero-dependency guarantee).

**`getCloudConfig()`** — merges env vars + `.env.sticky`, returns `{ url, apiKey }`.

**`getProjectName()`** — runs `git remote get-url origin` and extracts `owner/repo`. Falls back to `"default"`.

**`_cloudThreads`** — module-level variable, `null` until `initCloudCache()` resolves. `getThreads()` returns `_cloudThreads ?? localThreads`.

**`_cloudPresence`** — same pattern. Cloud presence is an array `[{ user, active_files, last_seen }]`; `getAllPresence()` converts it to the existing dict format `{ user: { active_files, last_seen } }`.

**`initCloudCache()`** — async function:
```
read .env.sticky
if no STICKY_URL → return (local-only mode)
fetch GET /threads and GET /presence in parallel (Promise.all)
on success → cache in _cloudThreads / _cloudPresence
on failure (network error, non-200) → log to stderr, stay null (local fallback)
timeout: 5 seconds
```

**Boot sequence** — wrap existing stdin setup in an async IIFE:
```js
(async () => {
  await initCloudCache();
  // existing process.stdin setup goes here
})();
```

This guarantees cloud data is ready before the first MCP request is processed.

### What each tool sees after this change

| Tool | Cloud data used |
|------|----------------|
| `search_threads` | cloud threads |
| `get_session_context` | cloud threads |
| `get_stuck_threads` | cloud threads |
| `check_overlaps` | cloud threads + cloud presence |
| `get_presence` | cloud presence |
| `get_thread_context_for_files` | cloud threads |
| `get_audit_trail` | local only (cloud audit is append-only, lower priority) |
| `get_full_transcript` | local only (transcripts not stored in cloud) |
| `get_environment_status` | local only (env sync is always local) |

### Limitations (acceptable for V3.0)
- Snapshot at boot — cloud threads written by teammates after MCP starts won't appear until restart. Same behavior as local-file mode.
- Audit trail and transcripts remain local-only.

---

## Fix 4: Docs Update

**File:** `docs/v3-migration-guide.md`

Add a **"MCP Server and Cloud"** subsection under "What Changes After Migration":

> **MCP server reads cloud threads (V3.0):** When `STICKY_URL` is set, `npx sticky-note mcp-server` fetches threads and presence from the cloud backend at startup. All 9 tools (`search_threads`, `check_overlaps`, etc.) see cloud data. The snapshot is taken at server boot — restart the MCP server to pick up threads written after it started.
>
> Audit trail and transcripts remain local-only in V3.0.

---

## Files Changed

| File | Change |
|------|--------|
| `bin/cli.js` | Add Step 3 to `cmdDeployBackend`: generate key, `wrangler secret put`, write to `.env.sticky` |
| `bin/mcp-server.js` | Add cloud cache init at boot; update `getThreads()` and `getAllPresence()` |
| `test/smoke.test.js` | Add 3 new tests |
| `docs/v3-migration-guide.md` | Add MCP + cloud section; update deploy-backend description |

---

## Out of Scope

- Cloud-aware audit trail (V3.2)
- Live cloud refresh mid-session (V3.2)
- Cloud transcript storage (not planned)
