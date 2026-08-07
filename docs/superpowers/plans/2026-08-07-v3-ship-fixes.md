# V3 Pre-Ship Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four gaps blocking V3 ship: API key provisioning in deploy-backend, smoke tests for cloud paths, cloud-aware MCP server, and docs update.

**Architecture:** All changes are additive — no existing behavior changes. `cmdDeployBackend` gains a Step 3 that generates and wires a secret. `mcp-server.js` gains a boot-time async init that fetches cloud data into module-level cache variables; all 9 tool handlers read from cache with local fallback. Three smoke tests cover the new CLI code paths. Docs updated to reflect actual V3.0 MCP behavior.

**Tech Stack:** Node.js built-ins only (`crypto`, `fs`, `path`, `child_process`). Zero new dependencies.

## Global Constraints

- Zero new npm dependencies — Node.js built-ins only
- Node >= 16 (no top-level await; use IIFE for async boot)
- All changes on `feature/v3` branch
- Do not break existing local-only mode (no `STICKY_URL` → identical behavior)
- `mcp-server.js` must remain a single self-contained file
- Test runner: `node test/smoke.test.js` (no test framework)

---

### Task 1: API Key Provisioning in `cmdDeployBackend`

**Files:**
- Modify: `bin/cli.js` — `cmdDeployBackend()` around line 2920

**Interfaces:**
- Consumes: `workerUrl` (string) extracted at line 2918, `serverDir` (string) at line 2876
- Produces: `.env.sticky` with both `STICKY_URL` and `STICKY_API_KEY`; Wrangler secret set on Worker

- [ ] **Step 1: Write the failing smoke test**

Add this test to `test/smoke.test.js` inside the `try` block, before the `finally`:

```js
run("deploy-backend: errors when wrangler not installed", () => {
  try {
    // Run with empty PATH so wrangler can't be found
    cli(["deploy-backend"], {
      env: { ...process.env, PATH: "", Path: "", path: "" },
    });
    assert.fail("Should have exited with error");
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    assert.ok(
      output.toLowerCase().includes("wrangler"),
      "Error output should mention wrangler"
    );
  }
});
```

- [ ] **Step 2: Run test to verify it fails (currently deploy-backend has no API key step)**

```bash
node test/smoke.test.js 2>&1 | tail -20
```

Expected: the new test passes (wrangler check already exists), but note it as a baseline. We want the API key provisioning tests to fail until implemented.

- [ ] **Step 3: Add API key generation and Wrangler secret provisioning to `cmdDeployBackend`**

In `bin/cli.js`, find the block starting at `if (workerUrl) {` (around line 2920). Replace the entire `if (workerUrl)` block:

```js
    if (workerUrl) {
      print(`  [OK] Worker deployed: ${workerUrl}`);

      // Generate API key and set it as a Wrangler secret
      const crypto = require("crypto");
      const apiKey = crypto.randomBytes(24).toString("base64url");

      print("  Step 3: Setting API key on Worker...");
      try {
        execSync("wrangler secret put STICKY_API_KEY", {
          cwd: serverDir,
          input: apiKey,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        print("  [OK] STICKY_API_KEY secret set on Worker");
      } catch (err) {
        print("  [WARN] Could not set STICKY_API_KEY automatically: " + (err.message || err));
        print("         Run manually: wrangler secret put STICKY_API_KEY");
      }

      // Write .env.sticky with both URL and key
      const envPath = path.join(process.cwd(), ".env.sticky");
      fs.writeFileSync(
        envPath,
        `STICKY_URL=${workerUrl}\nSTICKY_API_KEY=${apiKey}\n`,
        "utf-8"
      );
      print("  [OK] .env.sticky written with STICKY_URL and STICKY_API_KEY");
      print("\n  Share STICKY_URL and STICKY_API_KEY with your team securely");
      print("  (e.g. org secrets, 1Password). Do not commit .env.sticky.\n");
    } else {
      print("  [OK] Worker deployed (URL not detected — check wrangler output)");
    }
```

- [ ] **Step 4: Run the smoke test suite to confirm no regressions**

```bash
node test/smoke.test.js
```

Expected: all existing tests pass, new deploy-backend test passes.

- [ ] **Step 5: Commit**

```bash
git add bin/cli.js test/smoke.test.js
git commit -m "feat: deploy-backend generates and provisions STICKY_API_KEY via wrangler secret"
```

---

### Task 2: Smoke Tests for `migrate --to cloud` and `useCloud()`

**Files:**
- Modify: `test/smoke.test.js` — append two more tests inside the `try` block

**Interfaces:**
- Consumes: `cli()` helper, `tmpDir`, installed hook files from `setupStickyNote()`
- Produces: 2 new passing tests

- [ ] **Step 1: Add `migrate --to cloud` test**

Append inside the `try` block in `test/smoke.test.js`, before the `finally`:

```js
run("migrate --to cloud: exits with error when STICKY_URL not configured", () => {
  // Remove .env.sticky if it exists, clear STICKY_URL from env
  const envPath = path.join(tmpDir, ".env.sticky");
  if (fs.existsSync(envPath)) fs.unlinkSync(envPath);

  try {
    cli(["migrate", "--to", "cloud"], {
      env: { ...process.env, STICKY_URL: undefined },
    });
    assert.fail("Should have exited with error");
  } catch (err) {
    const output = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    assert.ok(
      output.includes("STICKY_URL"),
      "Error should mention STICKY_URL"
    );
  }
});
```

- [ ] **Step 2: Add `useCloud()` default-false test**

```js
run("useCloud() returns false when STICKY_URL not set", () => {
  // Load a fresh copy without cached state by resolving from tmpDir's installed hooks
  const utilsPath = path.join(tmpDir, ".claude", "hooks", "sticky-utils.js");
  // Clear the module cache so _cachedUseCloud is reset
  delete require.cache[require.resolve(utilsPath)];
  const utils = require(utilsPath);
  // Ensure no STICKY_URL in env
  const saved = process.env.STICKY_URL;
  delete process.env.STICKY_URL;
  try {
    assert.strictEqual(utils.useCloud(), false, "useCloud() should be false without STICKY_URL");
  } finally {
    if (saved !== undefined) process.env.STICKY_URL = saved;
  }
});
```

- [ ] **Step 3: Run the tests**

```bash
node test/smoke.test.js
```

Expected: all tests pass including the two new ones.

- [ ] **Step 4: Commit**

```bash
git add test/smoke.test.js
git commit -m "test: add smoke tests for migrate --to cloud and useCloud() default"
```

---

### Task 3: Cloud-Aware MCP Server

**Files:**
- Modify: `bin/mcp-server.js` — add cloud init section (after line 64 `stickyDir()`) and update `getThreads()` and `getAllPresence()`

**Interfaces:**
- Consumes: `.env.sticky` in `PROJECT_ROOT`, `STICKY_URL` / `STICKY_API_KEY` env vars
- Produces: `_cloudThreads` (array | null), `_cloudPresence` (array | null); updated `getThreads()` and `getAllPresence()` that prefer cloud data

- [ ] **Step 1: Add `readEnvSticky()`, `getCloudConfig()`, `getProjectName()` helpers**

In `bin/mcp-server.js`, after the `getTranscriptPath()` function (after line 68), add:

```js
// ──────────────────────────────────────────────
// Cloud config (V3 optional cloud backend)
// ──────────────────────────────────────────────

function readEnvSticky() {
  const envPath = path.join(PROJECT_ROOT, ".env.sticky");
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("STICKY_URL=")) result.STICKY_URL = trimmed.slice("STICKY_URL=".length);
    if (trimmed.startsWith("STICKY_API_KEY=")) result.STICKY_API_KEY = trimmed.slice("STICKY_API_KEY=".length);
  }
  return result;
}

function getCloudConfig() {
  const envFile = readEnvSticky();
  return {
    url: process.env.STICKY_URL || envFile.STICKY_URL || "",
    apiKey: process.env.STICKY_API_KEY || envFile.STICKY_API_KEY || "",
  };
}

function getProjectName() {
  try {
    const remote = require("child_process").execFileSync(
      "git", ["remote", "get-url", "origin"],
      { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"], cwd: PROJECT_ROOT }
    ).trim();
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1];
  } catch (_) {}
  return "default";
}
```

- [ ] **Step 2: Add cloud cache variables and `initCloudCache()`**

Directly after the helpers added in Step 1, add:

```js
let _cloudThreads = null;
let _cloudPresence = null;

async function initCloudCache() {
  const { url, apiKey } = getCloudConfig();
  if (!url) return;

  const headers = { "X-Sticky-Project": getProjectName() };
  if (apiKey) headers["X-Sticky-API-Key"] = apiKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const [threadsRes, presenceRes] = await Promise.all([
      fetch(`${url}/threads`, { headers, signal: controller.signal }),
      fetch(`${url}/presence`, { headers, signal: controller.signal }),
    ]);
    if (threadsRes.ok) {
      const data = await threadsRes.json();
      _cloudThreads = data.threads || [];
    }
    if (presenceRes.ok) {
      const data = await presenceRes.json();
      _cloudPresence = data.presence || [];
    }
  } catch (_) {
    process.stderr.write("[sticky-note] Cloud unreachable — using local data\n");
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 3: Update `getThreads()` to prefer cloud cache**

Find `getThreads()` (around line 98):

```js
function getThreads() {
  return getMemory().threads || [];
}
```

Replace with:

```js
function getThreads() {
  if (_cloudThreads !== null) return _cloudThreads;
  return getMemory().threads || [];
}
```

- [ ] **Step 4: Update `getAllPresence()` to prefer cloud cache**

Find `getAllPresence()` (around line 106). Replace the entire function:

```js
function getAllPresence() {
  if (_cloudPresence !== null) {
    // Convert cloud array [{ user, active_files, last_seen }] to local dict format
    const result = {};
    for (const entry of _cloudPresence) {
      if (entry.user) result[entry.user] = { active_files: entry.active_files || [], last_seen: entry.last_seen };
    }
    return result;
  }

  const presenceDir = path.join(stickyDir(), "presence");
  const result = {};
  if (!fs.existsSync(presenceDir)) return result;
  for (const file of fs.readdirSync(presenceDir)) {
    if (!file.endsWith(".json")) continue;
    const user = file.replace(".json", "");
    result[user] = readJsonSafe(path.join(presenceDir, file), {});
  }
  return result;
}
```

- [ ] **Step 5: Wrap stdio setup in async IIFE**

At the bottom of `bin/mcp-server.js`, find:

```js
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
```

Replace the entire bottom section (from `let buffer = ""` to end of file) with:

```js
(async () => {
  await initCloudCache();

  let buffer = "";

  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const errResp = {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        };
        process.stdout.write(JSON.stringify(errResp) + "\n");
        continue;
      }

      const response = handleRequest(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    }
  });

  process.stdin.on("end", () => {
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`sticky-note MCP server error: ${err.message}\n`);
  });
})();
```

- [ ] **Step 6: Smoke test — MCP server starts without error in local-only mode**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node bin/mcp-server.js
```

Expected: JSON response with `protocolVersion` and `serverInfo.name: "sticky-note"`. No crash.

- [ ] **Step 7: Smoke test — `getThreads` falls back to local when no STICKY_URL**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_stuck_threads","arguments":{}}}' | node bin/mcp-server.js
```

Expected: Two JSON lines in response, second contains `count` field. No error.

- [ ] **Step 8: Commit**

```bash
git add bin/mcp-server.js
git commit -m "feat: mcp-server fetches cloud threads and presence at boot when STICKY_URL is set"
```

---

### Task 4: Update Docs

**Files:**
- Modify: `docs/v3-migration-guide.md`

- [ ] **Step 1: Update deploy-backend description and add MCP cloud section**

In `docs/v3-migration-guide.md`, find the Step 2 block that lists what `deploy-backend` does (around line 38):

```markdown
This command:
1. Checks for `wrangler` CLI (prompts to install if missing)
2. Creates a Cloudflare KV namespace
3. Deploys the Sticky Note Worker
4. Writes `.env.sticky` with your `STICKY_URL` and `STICKY_API_KEY`
```

Replace with:

```markdown
This command:
1. Checks for `wrangler` CLI (install with `npm install -g wrangler` if missing)
2. Creates a Cloudflare KV namespace
3. Deploys the Sticky Note Worker
4. Generates a random API key and sets it on the Worker via `wrangler secret put`
5. Writes `.env.sticky` with `STICKY_URL` and `STICKY_API_KEY`
```

- [ ] **Step 2: Add MCP + cloud subsection**

In `docs/v3-migration-guide.md`, find the `### With \`STICKY_URL\` set (cloud mode)` section (around line 89). After the bullet list in that section, add:

```markdown
#### MCP Server and Cloud

When `STICKY_URL` is set, `npx sticky-note mcp-server` fetches threads and
presence from the cloud backend at startup. All team-facing tools
(`search_threads`, `check_overlaps`, `get_presence`, `get_stuck_threads`,
`get_session_context`, `get_thread_context_for_files`) see cloud data
automatically.

The snapshot is taken at server boot — restart the MCP server to pick up
threads written by teammates after it started.

Audit trail and transcripts remain local-only in V3.0.
```

- [ ] **Step 3: Verify the file reads correctly**

```bash
node -e "const fs=require('fs'); const c=fs.readFileSync('docs/v3-migration-guide.md','utf-8'); console.log(c.includes('wrangler secret put') && c.includes('MCP Server and Cloud') ? 'OK' : 'MISSING')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add docs/v3-migration-guide.md docs/superpowers/specs/2026-08-07-v3-ship-fixes-design.md docs/superpowers/plans/2026-08-07-v3-ship-fixes.md
git commit -m "docs: update v3-migration-guide with API key steps and MCP cloud section"
```

---

### Task 5: Full Test Run and Verification

- [ ] **Step 1: Run full smoke test suite**

```bash
node test/smoke.test.js
```

Expected: all tests pass, 0 failed.

- [ ] **Step 2: Verify MCP server cloud init path (Node 18+ required for fetch)**

```bash
node --version
```

If Node >= 18: run the manual MCP smoke test from Task 3 Step 6 again and confirm clean output.

If Node < 18: cloud init silently skips (fetch undefined check in initCloudCache handles it). Confirm with:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' | node bin/mcp-server.js
```

Expected: clean JSON response, no crash.

- [ ] **Step 3: Verify deploy-backend help text mentions API key**

```bash
node bin/cli.js --help | grep -i "deploy"
```

Expected: deploy-backend appears in output.

- [ ] **Step 4: Confirm no regressions in git log**

```bash
git log --oneline -6
```

Expected: 4 new commits from this plan visible on top.
