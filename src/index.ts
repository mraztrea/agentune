#!/usr/bin/env node

// sbotify — MCP music server entry point
// Bootstraps MCP server, audio engine, and web dashboard

import { createMcpServer } from './mcp/mcp-server.js';
import { createMpvController } from './audio/mpv-controller.js';
import { createYoutubeProvider } from './providers/youtube-provider.js';
import { createWebServer, getWebServer } from './web/web-server.js';
import { createQueueManager } from './queue/queue-manager.js';
import { createQueuePlaybackController, getQueuePlaybackController } from './queue/queue-playback-controller.js';

async function main() {
  console.error('[sbotify] Starting...');

  // Initialize components
  const queueManager = createQueueManager();
  const youtubeProvider = createYoutubeProvider();

  // Initialize audio engine — non-fatal if mpv is missing
  const mpv = createMpvController();
  createQueuePlaybackController(mpv, queueManager, youtubeProvider);
  createWebServer(mpv, queueManager);
  try {
    mpv.init();
  } catch (err) {
    console.error('[sbotify] Audio engine unavailable:', (err as Error).message);
    console.error('[sbotify] MCP tools will return errors until mpv is installed.');
  }

  await createMcpServer();
  console.error('[sbotify] Ready.');
}

// Graceful shutdown — destroy mpv process before exiting
async function shutdown(signal: string) {
  console.error(`[sbotify] Received ${signal}, shutting down...`);
  getQueuePlaybackController()?.clearForShutdown();
  await getWebServer()?.destroy();
  const mpv = createMpvController();
  mpv.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[sbotify] Fatal error:', err);
  process.exit(1);
});
