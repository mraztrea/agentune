// Stdio↔HTTP MCP proxy — bridges agent's stdio to daemon's HTTP MCP endpoint
// Uses low-level Server to forward tools/list and tools/call to daemon

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DAEMON_CONTROL_TOKEN_HEADER } from '../daemon/daemon-auth.js';

/** Connect stdio transport to daemon HTTP MCP endpoint and relay all traffic */
export async function startProxy(daemonPort: number, controlToken: string): Promise<void> {
  // Connect HTTP client to daemon
  const httpTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${daemonPort}/mcp`),
    {
      requestInit: {
        headers: {
          [DAEMON_CONTROL_TOKEN_HEADER]: controlToken,
        },
      },
    },
  );
  const httpClient = new Client(
    { name: 'agentune-proxy', version: '0.1.0' },
    { capabilities: {} }
  );
  await httpClient.connect(httpTransport);

  // Create stdio-facing server for the agent
  const stdioServer = new Server(
    { name: 'agentune', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // Forward tools/list to daemon
  stdioServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return await httpClient.listTools();
  });

  // Forward tools/call to daemon
  stdioServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await httpClient.callTool(request.params);
  });

  // Connect stdio transport (blocks until closed)
  const stdioTransport = new StdioServerTransport();
  await stdioServer.connect(stdioTransport);

  // Cleanup on exit
  const cleanup = () => {
    Promise.all([httpClient.close(), stdioServer.close()])
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
