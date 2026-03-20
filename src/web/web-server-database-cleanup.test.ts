import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { HistoryStore } from '../history/history-store.js';
import { createQueuePlaybackController } from '../queue/queue-playback-controller.js';
import { QueueManager } from '../queue/queue-manager.js';
import { createTasteEngine } from '../taste/taste-engine.js';
import { createWebServer } from './web-server.js';

class CleanupFakeMpv extends EventEmitter {
  private state = {
    currentTrack: null as { title: string; artist: string; duration: number; thumbnail: string } | null,
    isPlaying: false,
    isMuted: false,
    volume: 80,
  };
  stopCount = 0;

  setCurrentTrack(track: { title: string; artist: string; duration: number; thumbnail: string } | null): void {
    this.state.currentTrack = track;
    this.state.isPlaying = track !== null;
  }

  getState(): typeof this.state {
    return this.state;
  }

  isReady(): boolean {
    return true;
  }

  getCurrentTrack(): typeof this.state.currentTrack {
    return this.state.currentTrack;
  }

  stop(): void {
    this.stopCount += 1;
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    this.emit('stopped');
    this.emit('state-change', this.state);
  }

  play(): void {}
  pause(): void {}
  resume(): void {}
  setVolume(level: number): number {
    this.state.volume = level;
    this.emit('state-change', this.state);
    return level;
  }
  getVolume(): number {
    return this.state.volume;
  }
  toggleMute(): boolean {
    this.state.isMuted = !this.state.isMuted;
    this.emit('state-change', this.state);
    return this.state.isMuted;
  }
  getIsMuted(): boolean {
    return this.state.isMuted;
  }
  async getPosition(): Promise<number> {
    return 0;
  }
}

function getTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbotify-web-cleanup-'));
  return path.join(tmpDir, 'history.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
    if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } catch {
    // Ignore cleanup errors in tests.
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port.')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test('WebServer database cleanup endpoints stop runtime state and clear selected data', async () => {
  const dbPath = getTempDbPath();
  const store = new HistoryStore(dbPath);
  createTasteEngine(store);
  const queueManager = new QueueManager();
  const mpv = new CleanupFakeMpv();
  createQueuePlaybackController(mpv as never, queueManager, {
    search: async () => [],
    getAudioUrl: async () => ({ streamUrl: '', title: '', artist: '', duration: 0, thumbnail: '' }),
  } as never);

  const webServer = createWebServer(mpv as never, queueManager, {
    historyStore: store,
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();

  try {
    store.recordPlay({ title: 'Track A', artist: 'Artist A', duration: 200, thumbnail: 'thumb', ytVideoId: 'vid-a' });
    store.getDatabase().prepare(`
      INSERT INTO provider_cache (cache_key, response_json, fetched_at)
      VALUES ('apple:test', '{}', 123)
    `).run();
    queueManager.add({ id: 'queued', title: 'Queued', artist: 'Artist Q', duration: 100, thumbnail: 'thumb', url: 'url' });
    queueManager.setNowPlaying({ id: 'current', title: 'Current', artist: 'Artist C', duration: 120, thumbnail: 'thumb', url: 'url' });
    mpv.setCurrentTrack({ title: 'Current', artist: 'Artist C', duration: 120, thumbnail: 'thumb' });

    const statsResponse = await fetch(`${webServer.getDashboardUrl()}/api/database/stats`);
    const statsPayload = await statsResponse.json() as { stats: { counts: { plays: number; tracks: number; providerCache: number } } };
    assert.deepEqual(statsPayload.stats.counts, { plays: 1, tracks: 1, providerCache: 1 });

    const clearHistoryResponse = await fetch(`${webServer.getDashboardUrl()}/api/database/clear-history`, { method: 'POST' });
    const clearHistoryPayload = await clearHistoryResponse.json() as {
      updated: boolean;
      removed: { plays: number; tracks: number; providerCache: number };
      stats: { counts: { plays: number; tracks: number; providerCache: number } };
    };
    assert.equal(clearHistoryResponse.status, 200);
    assert.equal(clearHistoryPayload.updated, true);
    assert.deepEqual(clearHistoryPayload.removed, { plays: 1, tracks: 1, providerCache: 0 });
    assert.deepEqual(clearHistoryPayload.stats.counts, { plays: 0, tracks: 0, providerCache: 1 });
    assert.equal(mpv.stopCount, 1);
    assert.deepEqual(queueManager.getState(), { nowPlaying: null, queue: [], history: [] });

    const clearCacheResponse = await fetch(`${webServer.getDashboardUrl()}/api/database/clear-provider-cache`, { method: 'POST' });
    const clearCachePayload = await clearCacheResponse.json() as {
      removed: { plays: number; tracks: number; providerCache: number };
      stats: { counts: { plays: number; tracks: number; providerCache: number } };
    };
    assert.equal(clearCacheResponse.status, 200);
    assert.deepEqual(clearCachePayload.removed, { plays: 0, tracks: 0, providerCache: 1 });
    assert.deepEqual(clearCachePayload.stats.counts, { plays: 0, tracks: 0, providerCache: 0 });
  } finally {
    await webServer.destroy();
    store.close();
    cleanupDb(dbPath);
  }
});

test('WebServer fails startup when exact configured port is busy', async () => {
  const blocker = createServer();
  const port = await getAvailablePort();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', () => resolve());
  });

  const webServer = createWebServer(new CleanupFakeMpv() as never, new QueueManager(), { port });
  try {
    await assert.rejects(() => webServer.waitUntilReady(), /EADDRINUSE/i);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('WebServer stop endpoint schedules explicit daemon shutdown', async () => {
  const stopReasons: string[] = [];
  const webServer = createWebServer(new CleanupFakeMpv() as never, new QueueManager(), {
    onStopDaemon: (reason) => {
      stopReasons.push(reason);
    },
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();

  try {
    const response = await fetch(`${webServer.getDashboardUrl()}/api/daemon/stop`, { method: 'POST' });
    const payload = await response.json() as { stopped: boolean; message: string };

    assert.equal(response.status, 200);
    assert.equal(payload.stopped, true);
    assert.match(payload.message, /dashboard will stay offline/i);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(stopReasons, ['dashboard stop']);
  } finally {
    await webServer.destroy();
  }
});
