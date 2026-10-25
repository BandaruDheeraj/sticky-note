import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MCP_CONFIG_PATH = '.mcp.json';
const SERVER_NAME = 'sticky-note';

/**
 * Register the sticky-note MCP server in the repo's .mcp.json (read by Claude
 * Code, Cursor and others), preserving other servers. Idempotent.
 *
 * `hookCommand` is the same shell-style command the hooks use; it's split into
 * command + args, and $CLAUDE_PROJECT_DIR becomes ${CLAUDE_PROJECT_DIR:-.}
 * (.mcp.json's variable syntax, falling back to the server's working directory).
 */
export async function installMcpServer(repoRoot: string, hookCommand: string): Promise<{ file: string; changed: boolean }> {
  const file = path.join(repoRoot, MCP_CONFIG_PATH);
  const before = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  let config: { mcpServers?: Record<string, unknown>; [key: string]: unknown };
  try {
    config = before ? JSON.parse(before) : {};
  } catch {
    throw new Error(`${MCP_CONFIG_PATH} is not valid JSON; fix it and re-run init`);
  }

  const [command, ...args] = splitCommand(hookCommand).map((w) => w.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, '${CLAUDE_PROJECT_DIR:-.}'));
  config.mcpServers = { ...config.mcpServers, [SERVER_NAME]: { type: 'stdio', command, args: [...args, 'mcp'] } };

  const after = `${JSON.stringify(config, null, 2)}\n`;
  if (after === before) return { file, changed: false };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, after);
  return { file, changed: true };
}

/** Minimal shell-words split: whitespace-separated, with single or double quotes grouping. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let current = '';
  let last = 0;
  for (const m of command.matchAll(re)) {
    const gap = command.slice(last, m.index);
    if (gap.trim() === '' && gap.length > 0 && current) {
      words.push(current);
      current = '';
    }
    current += m[1] ?? m[2] ?? m[3] ?? '';
    last = m.index! + m[0].length;
  }
  if (current) words.push(current);
  return words;
}
