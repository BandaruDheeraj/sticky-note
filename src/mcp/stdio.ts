import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Services } from '../cli/context.js';
import { syncInBackground } from '../core/background-sync.js';
import { createMcpServer } from './server.js';

/** Serve MCP over stdio until the client disconnects. */
export async function runStdioServer(services: Services, version: string): Promise<void> {
  // Warn (on stderr, which MCP clients show) if this isn't a sticky-note repo.
  const [repoRoot, { exists }] = await Promise.all([services.repoRoot(), services.config()]);
  if (!exists) process.stderr.write(`sticky-note: ${repoRoot} is not set up (run \`sticky-note init\`); tools will return empty results.\n`);
  else syncInBackground(repoRoot, (await services.log()).file); // freshen teammates' data

  const server = createMcpServer(services, version);
  // connect() takes over transport.onclose, and a client disconnecting only ends
  // our stdin, so wait on both the server's close event and stdin ending.
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    process.stdin.once('end', resolve);
  });
  await server.connect(new StdioServerTransport());
  await closed;
  await server.close().catch(() => {});
}
