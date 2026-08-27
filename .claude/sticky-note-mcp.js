#!/usr/bin/env node
// sticky-note MCP server entry point (local dev — points to project's own bin/)
process.argv.push("--project", require("path").resolve(__dirname, ".."));
require("../bin/mcp-server.js");
