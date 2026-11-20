// Live smoke test: drives the built server over stdio like a real MCP client.
// Usage: node --env-file=.env scripts/live.mjs <tool> '<json args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, args = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'live-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], env: process.env }));
const res = await client.callTool({ name: tool, arguments: JSON.parse(args) });
console.log(res.isError ? 'ERROR' : 'OK');
console.log(res.content.map((c) => c.text).join('\n'));
await client.close();
