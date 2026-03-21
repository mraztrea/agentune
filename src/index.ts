#!/usr/bin/env node

// agentune — MCP music server entry point
// Bootstraps MCP server, audio engine, and web dashboard

import { createMpvController, getMpvController, waitForMpvStartupWarmup } from './audio/mpv-controller.js';
import { createYoutubeProvider } from './providers/youtube-provider.js';
import { createWebServer, getWebServer } from './web/web-server.js';
import { createQueueManager } from './queue/queue-manager.js';
import { createQueuePlaybackController, getQueuePlaybackController } from './queue/queue-playback-controller.js';
import { createHistoryStore, getHistoryStore } from './history/history-store.js';
import { createAppleSearchProvider } from './providers/apple-search-provider.js';
import { createTasteEngine } from './taste/taste-engine.js';
import { createDaemonControlToken } from './daemon/daemon-auth.js';
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
    console.error('[agentune] History DB unavailable:', (err as Error).message);
  }

  const store = getHistoryStore();
  if (store) {
    createTasteEngine(store);
    console.error('[agentune] Taste engine initialized.');
  }

  const queueManager = createQueueManager();
  const youtubeProvider = createYoutubeProvider();

  if (store) {
    const db = store.getDatabase();
    createAppleSearchProvider(db);
    console.error('[agentune] Discovery provider initialized (Apple).');
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
    // node-mpv needs a short idle warmup before first playback, otherwise EOF
    // can miss the stop signal and queued tracks will not auto-advance.
    await waitForMpvStartupWarmup();
  } catch (err) {
    console.error('[agentune] Audio engine unavailable:', (err as Error).message);
    console.error('[agentune] MCP tools will return errors until mpv is installed.');
  }

  return { mpv };
}

// --- Daemon mode ---

async function startDaemon() {
  console.error('[agentune] Starting in daemon mode...');
  const runtimeConfig = loadRuntimeConfig();
  const daemonControlToken = createDaemonControlToken();
  const daemonServer = new DaemonServer(runtimeConfig.daemonPort, daemonControlToken);
  let shutdownPromise: Promise<void> | null = null;

  async function daemonShutdown(reason: string) {
    if (shutdownPromise) {
      return await shutdownPromise;
    }

    shutdownPromise = (async () => {
      console.error(`[agentune] Daemon shutting down (${reason})...`);
      getQueuePlaybackController()?.clearForShutdown();

      await runShutdownStep('daemon server destroy', async () => {
        await daemonServer.destroy();
      });
      await runShutdownStep('web server destroy', async () => {
        await getWebServer()?.destroy();
      });
      await runShutdownStep('history store close', async () => {
        getHistoryStore()?.close();
      });
      await runShutdownStep('mpv destroy', async () => {
        getMpvController()?.destroy();
      });
      await runShutdownStep('pid file removal', async () => {
        removePidFile();
      });

      process.exit(0);
    })();

    return await shutdownPromise;
  }

  await bootstrapComponents({ onStopDaemon: daemonShutdown });
  daemonServer.setShutdownHandler(daemonShutdown);

  const port = await daemonServer.start();
  writePidFile(port, daemonControlToken);

  console.error(`[agentune] Daemon ready on http://127.0.0.1:${port}`);

  process.on('SIGINT', () => void daemonShutdown('SIGINT'));
  process.on('SIGTERM', () => void daemonShutdown('SIGTERM'));
}

async function runShutdownStep(step: string, action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(`[agentune] Shutdown step failed (${step}):`, (err as Error).message);
  }
}

// --- Entry point ---

const args = process.argv.slice(2);

if (args.includes('--daemon')) {
  startDaemon().catch((err) => { console.error('[agentune] Fatal:', err); process.exit(1); });
} else if (args[0] === 'status') {
  import('./cli/status-command.js').then(({ runStatus }) => runStatus());
} else if (args[0] === 'start') {
  import('./cli/start-command.js').then(({ runStart }) => runStart());
} else if (args[0] === 'stop') {
  import('./cli/stop-command.js').then(({ runStop }) => runStop());
} else {
  // Default: proxy mode — relay stdio↔HTTP and optionally auto-start daemon.
  startProxyMode().catch((err) => { console.error('[agentune] Fatal:', err); process.exit(1); });
}

async function startProxyMode() {
  const { ensureDaemon } = await import('./proxy/daemon-launcher.js');
  const { startProxy } = await import('./proxy/stdio-proxy.js');
  const runtimeConfig = loadRuntimeConfig();

  const { controlToken, port } = await ensureDaemon({ allowSpawn: runtimeConfig.autoStartDaemon });
  console.error(`[agentune] Connected to daemon on port ${port}`);
  await startProxy(port, controlToken);
}
