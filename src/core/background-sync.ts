import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';

/**
 * Run `sticky-note sync` as a detached process so the caller (a hook or the MCP server) never waits on the network.
 * Output is appended to the hook log. Disabled with STICKY_NO_BACKGROUND_SYNC=1 (tests).
 */
export function syncInBackground(repoRoot: string, logFile: string): void {
  const entry = process.argv[1];
  if (process.env.STICKY_NO_BACKGROUND_SYNC === '1' || !entry) return;
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, 'a');
  try {
    spawn(process.execPath, [entry, 'sync', '--cwd', repoRoot], {
      detached: true,
      // Without this, Windows opens a new console window for every detached sync.
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      // GCM_INTERACTIVE: Git Credential Manager (Windows) ignores GIT_TERMINAL_PROMPT and would wait on a hidden dialog.
      env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).unref();
  } finally {
    closeSync(fd);
  }
}
