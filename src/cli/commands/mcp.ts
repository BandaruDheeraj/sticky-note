import pkg from '../../../package.json' with { type: 'json' };
import { defineCommand } from '../command.js';
import { Services } from '../context.js';

export const mcpCommand = defineCommand({
  name: 'mcp',
  summary: 'Run the MCP server for agents (stdio)',
  description:
    'Started by MCP clients (Claude Code, Cursor, Windsurf, ...) from .mcp.json, which `init` writes. ' +
    'Speaks MCP on stdin/stdout, so it prints nothing else. Uses $CLAUDE_PROJECT_DIR as the repo when set.',

  async run({ cwd }, { options }) {
    const dir = options.cwd === undefined && process.env.CLAUDE_PROJECT_DIR ? process.env.CLAUDE_PROJECT_DIR : cwd;
    // Loaded lazily so hooks (same binary) never pay for the MCP SDK.
    const { runStdioServer } = await import('../../mcp/stdio.js');
    await runStdioServer(new Services(dir), pkg.version);
  },
});
