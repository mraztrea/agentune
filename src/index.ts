#!/usr/bin/env node

// sbotify — MCP music server entry point
// Bootstraps MCP server, audio engine, and web dashboard

import { createMpvController, getMpvController } from './audio/mpv-controller.js';
import { createYoutubeProvider } from './providers/youtube-provider.js';
import { createWebServer, getWebServer } from './web/web-server.js';
import { createQueueManager } from './queue/queue-manager.js';
import { createQueuePlaybackController, getQueuePlaybackController } from './queue/queue-playback-controller.js';
import { createHistoryStore, getHistoryStore } from './history/history-store.js';
import { createAppleSearchProvider } from './providers/apple-search-provider.js';
import { createTasteEngine } from './taste/taste-engine.js';
import { DaemonServer } from './daemon/daemon-server.js';
import { writePidFile, removePidFile } from './daemon/pid-manager.js';
import { loadRuntimeConfig } from './runtime/runtime-config.js';
import type { WebServerOptions } from './web/web-server.js';

// --- Shared bootstrap ---

async function bootstrapComponents(webServerOptions?: Pick<WebServerOptions, 'onStopDaemon'>) {
  const runtimeConfig = loadRuntimeConfig();

  // Initialize history store (SQLite) — non-fatal if it fails
  try {
    createHistoryStore();
  } catch (err) {
    console.error('[sbotify] History DB unavailable:', (err as Error).message);
  }

  const store = getHistoryStore();
  if (store) {
    createTasteEngine(store);
    console.error('[sbotify] Taste engine initialized.');
  }

  const queueManager = createQueueManager();
  const youtubeProvider = createYoutubeProvider();

  if (store) {
    const db = store.getDatabase();
    createAppleSearchProvider(db);
    console.error('[sbotify] Discovery provider initialized (Apple).');
  }

  const mpv = createMpvController(runtimeConfig.defaultVolume);
  createQueuePlaybackController(mpv, queueManager, youtubeProvider);
  const webServer = createWebServer(mpv, queueManager, {
    ...webServerOptions,
    port: runtimeConfig.dashboardPort,
  });
  await webServer.waitUntilReady();

  try {
    mpv.init();
  } catch (err) {
    console.error('[sbotify] Audio engine unavailable:', (err as Error).message);
    console.error('[sbotify] MCP tools will return errors until mpv is installed.');
  }

  return { mpv };
}

// --- Daemon mode ---

async function startDaemon() {
  console.error('[sbotify] Starting in daemon mode...');
  const runtimeConfig = loadRuntimeConfig();
  const daemonServer = new DaemonServer(runtimeConfig.daemonPort);

  async function daemonShutdown(reason: string) {
    console.error(`[sbotify] Daemon shutting down (${reason})...`);
    getQueuePlaybackController()?.clearForShutdown();
    getHistoryStore()?.close();
    await getWebServer()?.destroy();
    removePidFile();
    await daemonServer.destroy();
    getMpvController()?.destroy();
    process.exit(0);
  }

  await bootstrapComponents({ onStopDaemon: daemonShutdown });
  daemonServer.setShutdownHandler(daemonShutdown);

  const port = await daemonServer.start();
  writePidFile(port);

  console.error(`[sbotify] Daemon ready on http://127.0.0.1:${port}`);

  process.on('SIGINT', () => void daemonShutdown('SIGINT'));
  process.on('SIGTERM', () => void daemonShutdown('SIGTERM'));
}

// --- Entry point ---

const args = process.argv.slice(2);

if (args.includes('--daemon')) {
  startDaemon().catch((err) => { console.error('[sbotify] Fatal:', err); process.exit(1); });
} else if (args[0] === 'status') {
  import('./cli/status-command.js').then(({ runStatus }) => runStatus());
} else if (args[0] === 'stop') {
  import('./cli/stop-command.js').then(({ runStop }) => runStop());
} else {
  // Default: proxy mode — auto-start daemon, relay stdio↔HTTP
  startProxyMode().catch((err) => { console.error('[sbotify] Fatal:', err); process.exit(1); });
}

async function startProxyMode() {
  const { ensureDaemon } = await import('./proxy/daemon-launcher.js');
  const { startProxy } = await import('./proxy/stdio-proxy.js');

  const { port } = await ensureDaemon();
  console.error(`[sbotify] Connected to daemon on port ${port}`);
  await startProxy(port);
}
