#!/usr/bin/env node
// Call one sticky-note MCP tool the way an MCP client (Claude Code, Cursor, ...)
// would: launch `sticky-note mcp` over stdio, call the tool, print the text result.
//
//   node scripts/mcp-call.mjs <repo dir> <tool> '<json args>'
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [dir, tool, json = '{}'] = process.argv.slice(2);
if (!dir || !tool) {
  console.error("usage: mcp-call.mjs <repo dir> <tool> '<json args>'");
  process.exit(2);
}
const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], cwd: dir, stderr: 'ignore' });
const client = new Client({ name: 'sticky-note-demo', version: '0' });
await client.connect(transport);
try {
  const result = await client.callTool({ name: tool, arguments: JSON.parse(json) });
  console.log(result.content.map((c) => c.text).join('\n'));
} finally {
  await client.close();
  // On Windows the server child may linger after transport close; ensure it's dead.
  try { process.kill(transport.pid); } catch {}
}
