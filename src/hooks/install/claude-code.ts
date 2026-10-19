import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_CODE_EVENTS } from '../adapters/claude-code.js';
import { EDIT_TOOL_NAMES, READ_TOOL_NAMES } from '../edited-files.js';

export const DEFAULT_HOOK_COMMAND = 'npx --no-install sticky-note-cli';
export const CLAUDE_SETTINGS_PATH = path.join('.claude', 'settings.json');

interface HookEntry {
  type: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

/**
 * Recognizes our own hooks so re-running init replaces them: any command ending
 * in `run-hook claude-code` (whatever --hook-command was), plus v3's `sticky-note-cli run-hook <event>`.
 */
const isOurs = (command = '') => /\brun-hook claude-code$/.test(command) || /sticky-note.*\brun-hook\b/.test(command);

const MATCHERS: Partial<Record<(typeof CLAUDE_CODE_EVENTS)[number], string>> = {
  // Only file tools matter; avoids spawning a process for every Bash/Grep call.
  PreToolUse: EDIT_TOOL_NAMES.join('|'),
  PostToolUse: [...EDIT_TOOL_NAMES, ...READ_TOOL_NAMES].join('|'),
};

// Generous because a killed hook is worse than a slow one; SessionEnd also syncs with the remote.
const DEFAULT_TIMEOUT = 30;
const TIMEOUTS: Partial<Record<(typeof CLAUDE_CODE_EVENTS)[number], number>> = { SessionEnd: 60 };

/**
 * Merge sticky-note hooks into .claude/settings.json, preserving everything
 * else in the file. Idempotent.
 */
export async function installClaudeCodeHooks(repoRoot: string, hookCommand = DEFAULT_HOOK_COMMAND): Promise<{ file: string; changed: boolean }> {
  const file = path.join(repoRoot, CLAUDE_SETTINGS_PATH);
  const before = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });

  let settings: Record<string, unknown>;
  try {
    settings = before ? JSON.parse(before) : {};
  } catch {
    throw new Error(`${CLAUDE_SETTINGS_PATH} is not valid JSON; fix it and re-run init`);
  }

  const hooks = (settings.hooks ?? {}) as Record<string, HookGroup[]>;
  for (const event of CLAUDE_CODE_EVENTS) {
    const kept = (hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: group.hooks.filter((h) => !isOurs(h.command)) }))
      .filter((group) => group.hooks.length > 0);
    const ours: HookGroup = {
      ...(MATCHERS[event] && { matcher: MATCHERS[event] }),
      hooks: [{ type: 'command', command: `${hookCommand} run-hook claude-code`, timeout: TIMEOUTS[event] ?? DEFAULT_TIMEOUT }],
    };
    hooks[event] = [...kept, ours];
  }
  settings.hooks = hooks;

  const after = `${JSON.stringify(settings, null, 2)}\n`;
  if (after === before) return { file, changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, after);
  return { file, changed: true };
}
