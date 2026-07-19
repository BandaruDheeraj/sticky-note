# Plan A: Team Environment Sync ("Vibe Coding Container")

## Problem

Customers want a "container-like" setup where installing sticky-note on a repo
gives every developer the complete vibe coding environment — MCP servers, skills,
plugins, permissions, agents, and tool configs — not just hooks and thread memory.

Today we store MCP servers and skills as metadata in `sticky-note-config.json`
but don't actually provision them. Credentials and env-dependent paths block
naive git-tracking of `.mcp.json` and `settings.local.json`.

## Core Design: The Hook IS the Provisioning Engine

The session-start hook already fires on every session for every teammate who
pulled the repo. Instead of requiring a separate `bootstrap` command, **the
hook auto-provisions everything it can** — just like it already auto-registers
the sticky-note MCP server (Plan B).

```
git pull -> start AI session -> session-start hook provisions everything -> done
```

No `init`. No `bootstrap`. No commands. The only exception: MCP servers that
need secrets the user hasn't provided yet. For those, `bootstrap` is the
interactive escape hatch.

### What the hook auto-provisions (no user action needed)

| What | How | One-session delay? |
|------|-----|-------------------|
| Skills (.md files) | Copy to .claude/plugins/ and .github/extensions/ | Yes (plugin dirs read at startup) |
| Agents (.md files) | Copy to plugin/extension dirs | Yes |
| Commands (.md files) | Copy to plugin/extension dirs | Yes |
| Permissions | Merge into .claude/settings.local.json | Yes |
| MCP servers (no secrets) | Write to .mcp.json | Yes |
| Sticky-note MCP server | Write to .mcp.json (see Plan B) | Yes |

**One-session delay:** AI tools read `.mcp.json`, plugin dirs, and settings
at startup, before hooks fire. So the hook provisions everything, but it
takes effect on the NEXT session. First session is hook-only (existing
behavior), second session onward gets the full environment.

### What needs `bootstrap` (interactive, secrets required)

| What | Why |
|------|-----|
| MCP servers with `${ENV_VAR}` placeholders | Can't prompt user from a hook |
| External plugin installs (registry/github) | Slow network calls, may timeout in hook |

`bootstrap` is the "fix what the hook couldn't do" command, not the "set up
your environment" command.

## How It Works: The Provisioning Function

The session-start hook gets a new `ensureEnvironmentProvisioned()` function
that runs on every session start:

```javascript
function ensureEnvironmentProvisioned() {
  const envDir = path.join(cwd, '.sticky-note', 'environment');
  if (!fs.existsSync(envDir)) return; // no environment defined

  // Hash check: skip if nothing changed
  const currentHash = hashEnvironment(envDir);
  const lastHash = readProvisionHash();
  if (currentHash === lastHash) return;

  // --- MCP servers (secret-free only) ---
  const manifest = readManifest(envDir);
  if (manifest.mcp_servers) {
    const mcpPath = path.join(cwd, '.mcp.json');
    let mcp = readJsonSafe(mcpPath, { mcpServers: {} });
    for (const [name, config] of Object.entries(manifest.mcp_servers)) {
      if (mcp.mcpServers[name]) continue; // already provisioned
      if (hasEnvPlaceholders(config)) continue; // needs secrets, skip
      mcp.mcpServers[name] = resolveConfig(config);
    }
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  }

  // --- Skills -> Claude Code plugin ---
  const skillsDir = path.join(envDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    const pluginSkillsDir = path.join(cwd, '.claude', 'plugins',
      'sticky-note-team', 'skills');
    fs.mkdirSync(pluginSkillsDir, { recursive: true });
    for (const file of fs.readdirSync(skillsDir)) {
      if (!file.endsWith('.md')) continue;
      const name = file.replace('.md', '');
      const destDir = path.join(pluginSkillsDir, name);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(
        path.join(skillsDir, file),
        path.join(destDir, 'SKILL.md')
      );
    }
    generatePluginJson(cwd); // auto-generate plugin.json
  }

  // --- Skills -> Copilot CLI extension ---
  const extSkillsDir = path.join(cwd, '.github', 'extensions',
    'sticky-note-team', 'skills');
  if (fs.existsSync(skillsDir)) {
    fs.mkdirSync(extSkillsDir, { recursive: true });
    for (const file of fs.readdirSync(skillsDir)) {
      if (!file.endsWith('.md')) continue;
      fs.copyFileSync(
        path.join(skillsDir, file),
        path.join(extSkillsDir, file)
      );
    }
  }

  // --- Agents, Commands (same pattern) ---
  copyMdDir(envDir, 'agents', cwd);
  copyMdDir(envDir, 'commands', cwd);

  // --- Permissions ---
  if (manifest.permissions) {
    mergePermissions(cwd, manifest.permissions);
  }

  // Save hash so we skip next time unless something changes
  writeProvisionHash(currentHash);
}
```

This runs in milliseconds (local file copies, no network). The hash check
means it only does work when the environment actually changed.

## Directory Structure

All team-shared content lives under `.sticky-note/` (already auto-staged
by the pre-commit hook):

```
.sticky-note/
├── environment/              # NEW: team vibe coding environment
│   ├── manifest.json         # MCP servers, plugins, permissions, env vars
│   ├── skills/               # team skill definitions (.md files)
│   │   ├── react-doctor.md
│   │   ├── code-review.md
│   │   └── custom-linter.md
│   ├── agents/               # team agent definitions (.md files)
│   │   ├── security-reviewer.md
│   │   └── api-designer.md
│   └── commands/             # team slash commands (.md files)
│       └── deploy.md
├── sticky-note.json          # thread memory (existing)
├── sticky-note-config.json   # team config (existing)
├── merge-driver.js           # merge strategy (existing)
├── audit/                    # per-user audit (existing)
└── presence/                 # per-user presence (existing)
```

**Why under `.sticky-note/`?**
- Pre-commit hook already auto-stages everything in `.sticky-note/`
- Skills/agents created during a session auto-commit with the next commit
- Same merge driver handles conflicts
- Zero extra git commands — it just flows with your work

## Manifest Schema (`.sticky-note/environment/manifest.json`)

```jsonc
{
  "version": "1",

  "mcp_servers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"],
      "description": "Fetch up-to-date docs for any library",
      "required": true
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      },
      "description": "GitHub API access",
      "required": true
    },
    "postgres-staging": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "${STAGING_DB_URL}"
      },
      "description": "Staging database access",
      "required": false
    }
  },

  "plugins": {
    "docker": {
      "source": "registry:docker-copilot-ext",
      "description": "Dockerfile generation and vulnerability analysis",
      "required": false
    }
  },

  "permissions": [
    "Bash(npx sticky-note:*)",
    "Bash(gh issue:*)",
    "Bash(npm test:*)",
    "Bash(node:*)",
    "mcp:context7",
    "mcp:github"
  ],

  "env_vars": {
    "GITHUB_TOKEN": {
      "description": "GitHub PAT with repo scope",
      "docs_url": "https://github.com/settings/tokens",
      "required": true
    },
    "STAGING_DB_URL": {
      "description": "Postgres connection string for staging",
      "docs_url": "https://internal.wiki/staging-db",
      "required": false
    }
  }
}
```

**Skills, agents, and commands are NOT in the manifest.** They're
auto-discovered from the directory structure. Creating a skill = dropping
a `.md` file into `.sticky-note/environment/skills/`. The manifest only
tracks things that need configuration (MCP servers, env vars, external
plugins, permissions).

## User Journeys

### Team lead sets up the repo (one time)

```
$ npx sticky-note init

  ...existing init prompts...

  Environment setup

  Share your vibe coding environment with the team? (yes)

  Auto-detected:
    MCP servers:  context7, github (needs GITHUB_TOKEN)
    Skills:       react-doctor
    Permissions:  Bash(npx sticky-note:*), Bash(gh issue:*)

  Include all? (yes)

  Documenting secrets:
    GITHUB_TOKEN
      Description: GitHub PAT with repo scope
      Docs URL: https://github.com/settings/tokens

  [OK] Saved to .sticky-note/environment/manifest.json
  [OK] Provisioned locally (context7, permissions, skills)
  [!!] github MCP server needs GITHUB_TOKEN -- run bootstrap to configure

$ git add -A && git commit -m "feat: add sticky-note" && git push
```

### Teammate joins (zero commands)

```
$ git pull                         # gets hooks + environment/
$ claude                           # starts session

  [session-start hook fires]
  [ensureEnvironmentProvisioned() runs silently]
  [copies skills to .claude/plugins/sticky-note-team/]
  [copies agents to .github/extensions/sticky-note-team/]
  [writes context7 to .mcp.json (no secrets needed)]
  [merges permissions into .claude/settings.local.json]
  [registers sticky-note MCP server in .mcp.json]
  [skips github MCP server (needs GITHUB_TOKEN)]

  [session proceeds normally -- hook-only experience]

$ claude                           # NEXT session

  [MCP server + plugins now active]
  [AI calls get_environment_status()]
  [AI tells user: "github MCP server needs GITHUB_TOKEN"]
  [AI tells user: "run npx sticky-note bootstrap to configure"]

  [full environment experience]
```

**Two sessions to full environment.** No commands at all. The AI itself
tells the user about missing secrets via the MCP server (Plan B).

### Developer creates a skill mid-session

```
User: "Create a skill that checks our API naming conventions"

AI: [writes .sticky-note/environment/skills/api-conventions.md]

    Created team skill: api-conventions
    This will be shared with your team on next commit.
```

What happens:
1. `.md` file written to `.sticky-note/environment/skills/`
2. Pre-commit hook auto-stages it on next commit
3. Teammate does `git pull`
4. Their next session-start hook copies it to their plugin dirs
5. Session after that, the skill is active

### Developer adds an MCP server

```
$ npx sticky-note env add-server

  Server name: sentry
  Command: npx
  Args: -y @sentry/mcp-server
  Description: Sentry error tracking
  Needs env vars? (yes)
    Name: SENTRY_AUTH_TOKEN
    Description: Sentry API token
    Docs: https://sentry.io/settings/...
    Required? (yes)

  [OK] Added to .sticky-note/environment/manifest.json
  [OK] Updated .env.example
```

Or just edit `manifest.json` directly — it's simple JSON.

### `bootstrap` — the escape hatch for secrets

```
$ npx sticky-note bootstrap

  Checking secrets...
    [OK] GITHUB_TOKEN -- found in .env
    [!!] SENTRY_AUTH_TOKEN -- not found
       Sentry API token
       Docs: https://sentry.io/settings/...
       Enter value: sntrys_xxxx
       Save to .env? (yes)

  MCP servers...
    [OK] github -- provisioned (was pending secrets)
    [OK] sentry -- provisioned

  Environment complete! All MCP servers provisioned.
```

`bootstrap` ONLY prompts for missing secrets and provisions what the hook
couldn't. Everything else was already done automatically.

## How Provisioning Works Per Target

### Claude Code (.claude/plugins/sticky-note-team/)

The hook generates a native Claude Code plugin:

```
.claude/plugins/sticky-note-team/
├── .claude-plugin/
│   └── plugin.json            # auto-generated
├── skills/
│   ├── react-doctor/
│   │   └── SKILL.md           # copied from .sticky-note/environment/skills/
│   ├── code-review/
│   │   └── SKILL.md
│   └── custom-linter/
│       └── SKILL.md
├── agents/
│   ├── security-reviewer.md
│   └── api-designer.md
└── commands/
    └── deploy.md
```

### Copilot CLI (.github/extensions/sticky-note-team/)

```
.github/extensions/sticky-note-team/
├── extension.mjs              # auto-generated
├── skills/
│   ├── react-doctor.md
│   ├── code-review.md
│   └── custom-linter.md
├── agents/
│   ├── security-reviewer.md
│   └── api-designer.md
└── package.json               # auto-generated
```

### .mcp.json (project root)

Secret-free MCP servers written by hook. Secret-requiring servers written
by `bootstrap` after user provides credentials.

### .claude/settings.local.json

Permissions merged by hook. Not git-tracked.

## Design Principles

1. **Hook-first** — session-start hook is the provisioning engine, not a CLI command
2. **One source of truth** — `.sticky-note/environment/` owns definitions
3. **Auto-flow via git** — pre-commit hook stages, session-start hook provisions
4. **Secrets never in git** — `${ENV_VAR}` placeholders, `bootstrap` resolves them
5. **Idempotent + hash-gated** — hook only runs when environment changes
6. **Opt-out not opt-in** — container model, everything provisions by default
7. **bootstrap is the escape hatch** — only for secrets, not for routine setup

## Env Var Resolution (bootstrap only)

```
1. process.env (shell environment)
2. .env file (project root, gitignored)
3. Interactive prompt -> option to save to .env
```

Auto-generates `.env.example` (git-tracked) from manifest:
```bash
# Required -- GitHub API access
# Docs: https://github.com/settings/tokens
GITHUB_TOKEN=

# Optional -- Staging database access
# Docs: https://internal.wiki/staging-db
# STAGING_DB_URL=
```

## Backward Compatibility

- Old top-level `mcp_servers[]` and `skills[]` in sticky-note-config.json still work
- New `environment/` directory takes precedence if it exists
- Hook migrates old format on first run
- `sticky-note-config.json` gets `"environment_version": "1"` field

## What About Tool X?

Extensible. Adding a new target tool:
1. Add a provisioner block in `ensureEnvironmentProvisioned()` 
2. Map from `.sticky-note/environment/` to that tool's format
3. Skills are markdown — they work anywhere

Future: Cursor (`.cursor/`), Windsurf (`.windsurf/`), Zed (`.zed/`).

## Relationship to Plan B (MCP Server)

The hook provisions silently but **cannot tell the user about failures**
(hooks can't reliably surface messages). Plan B's `get_environment_status()`
MCP tool is how the AI discovers and communicates missing secrets to the user.

The two plans together:
- **Plan A hook** provisions everything it can silently
- **Plan B MCP server** tells the AI what's missing, AI tells the user
- **`bootstrap`** is the interactive command for providing secrets

## Todos

1. Create `.sticky-note/environment/` directory structure and manifest.json template
2. Design manifest.json schema + validation
3. Implement `ensureEnvironmentProvisioned()` in session-start.js hook
4. Implement hash-based change detection (skip if nothing changed)
5. Implement MCP server provisioning to .mcp.json (secret-free only)
6. Implement skill provisioning to .claude/plugins/sticky-note-team/
7. Implement skill provisioning to .github/extensions/sticky-note-team/
8. Implement agent/command provisioning to plugin/extension dirs
9. Implement permission merging into .claude/settings.local.json
10. Auto-generate plugin.json and extension.mjs from directory contents
11. Implement `bootstrap` command (secrets-only escape hatch)
12. Implement env var resolution (env -> .env -> interactive prompt)
13. Generate `.env.example` from manifest env_vars
14. Implement `env add-server` / `env add-plugin` convenience commands
15. Update `init` to build manifest from auto-detected environment
16. Update pre-commit hook to auto-stage `.sticky-note/environment/`
17. Migrate old `mcp_servers[]`/`skills[]` to new environment structure
18. Update CLAUDE.md and copilot-instructions.md templates
19. Update README.md with environment sync documentation
20. Add tests for hook provisioning, bootstrap, and migration
