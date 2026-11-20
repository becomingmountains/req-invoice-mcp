#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RequestApi } from './api.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  const server = createServer(config, new RequestApi(config.api));
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // stdout is the MCP channel; diagnostics go to stderr.
  console.error(`req-invoice-mcp: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
