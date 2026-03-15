#!/usr/bin/env node

// sbotify — MCP music server entry point
// Bootstraps MCP server, audio engine, and web dashboard

import { createMcpServer } from './mcp/mcp-server.js';
import { createMpvController } from './audio/mpv-controller.js';
import { createYoutubeProvider } from './providers/youtube-provider.js';
import { createWebServer } from './web/web-server.js';
import { createQueueManager } from './queue/queue-manager.js';

async function main() {
  console.error('[sbotify] Starting...');

  // Initialize components (implementations in later phases)
  createQueueManager();
  createYoutubeProvider();
  createMpvController();
  createWebServer();
  await createMcpServer();

  console.error('[sbotify] Ready.');
}

// Graceful shutdown
function shutdown(signal: string) {
  console.error(`[sbotify] Received ${signal}, shutting down...`);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[sbotify] Fatal error:', err);
  process.exit(1);
});
