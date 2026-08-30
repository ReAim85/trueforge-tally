// tally mcp server - connects trueforge to tallyprime via the bridge server

// load .env from project root
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { BridgeClient } from './bridge-client.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerWriteTools } from './tools/write-tools.js';
import { registerAiTools } from './tools/ai-tools.js';

const bridgeUrl = process.env.BRIDGE_URL || 'http://localhost:8080';
const bridgeApiKey = process.env.BRIDGE_API_KEY;
const bridgeAgentId = process.env.BRIDGE_AGENT_ID;
const port = Number(process.env.MCP_PORT || process.env.PORT) || 3001;

if (!bridgeApiKey) {
  console.error('BRIDGE_API_KEY env var is required');
  process.exit(1);
}
if (!bridgeAgentId) {
  console.error('BRIDGE_AGENT_ID env var is required');
  process.exit(1);
}

const bridge = new BridgeClient({
  bridgeUrl,
  apiKey: bridgeApiKey,
  agentId: bridgeAgentId,
});

const server = new McpServer({
  name: 'tally-mcp-server',
  version: '1.0.0',
});

registerReadTools(server, bridge);
registerWriteTools(server, bridge);
registerAiTools(server, bridge);

const app = express();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, name: 'tally-mcp-server' });
});

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    transport.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  res.status(405).json({ error: 'use POST for mcp requests' });
});

app.delete('/mcp', async (req, res) => {
  res.status(405).json({ error: 'session termination not supported' });
});

app.listen(port, () => {
  console.log(`tally mcp server running on port ${port}`);
  console.log(`bridge url: ${bridgeUrl}`);
  console.log(`agent id: ${bridgeAgentId}`);
});
