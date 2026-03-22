import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createServer } from 'http';
import test from 'node:test';
import WebSocket from 'ws';
import { createQueuePlaybackController } from '../queue/queue-playback-controller.js';
import { QueueManager } from '../queue/queue-manager.js';
import { getDashboardAuth } from './web-server-test-helpers.js';
import { createWebServer } from './web-server.js';

class PlaybackControlsFakeMpv extends EventEmitter {
  private state = {
    currentTrack: null as { id: string; title: string; artist: string; duration: number; thumbnail: string } | null,
    isPlaying: false,
    isMuted: false,
    volume: 80,
  };

  pauseCount = 0;
  playCount = 0;
  private pauseProperty = false;
  private suppressStoppedCount = 0;
  resumeCount = 0;
  stopCount = 0;

  seedCurrentTrack(track: { id: string; title: string; artist: string; duration: number; thumbnail: string }): void {
    this.state.currentTrack = track;
    this.state.isPlaying = true;
    this.pauseProperty = false;
  }

  getState(): typeof this.state {
    return this.state;
  }

  getCurrentTrack(): typeof this.state.currentTrack {
    return this.state.currentTrack;
  }

  getIsPlaying(): boolean {
    return this.state.isPlaying;
  }

  isReady(): boolean {
    return true;
  }

  play(_url: string, track: { id: string; title: string; artist: string; duration: number; thumbnail: string }): void {
    this.playCount += 1;
    this.state.currentTrack = track;
    this.state.isPlaying = !this.pauseProperty;
    if (this.state.isPlaying) {
      this.emit('started');
    }
    this.emit('state-change', this.state);
  }

  pause(): void {
    this.pauseCount += 1;
    this.pauseProperty = true;
    this.state.isPlaying = false;
    this.emit('paused');
    this.emit('state-change', this.state);
  }

  resume(): void {
    this.resumeCount += 1;
    this.pauseProperty = false;
    this.state.isPlaying = this.state.currentTrack !== null;
    this.emit('resumed');
    this.emit('state-change', this.state);
  }

  suppressNextStopped(): void {
    this.suppressStoppedCount++;
  }

  stop(): void {
    this.stopCount += 1;
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    if (this.suppressStoppedCount > 0) {
      this.suppressStoppedCount--;
    } else {
      this.emit('stopped');
    }
    this.emit('state-change', this.state);
  }

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

async function waitFor(check: () => boolean): Promise<void> {
  const timeoutAt = Date.now() + 5000;

  while (Date.now() < timeoutAt) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('Timed out waiting for playback control update.');
}

test('WebServer websocket playback controls pause, toggle resume, and skip the current track', async () => {
  const queueManager = new QueueManager();
  const mpv = new PlaybackControlsFakeMpv();
  const currentTrack = {
    id: 'current-track',
    title: 'Current Track',
    artist: 'Current Artist',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  };
  const nextTrack = {
    id: 'next-track',
    title: 'Next Track',
    artist: 'Queued Artist',
    duration: 200,
    thumbnail: 'thumb-next',
    url: 'https://youtube.test/next',
  };

  queueManager.setNowPlaying(currentTrack);
  queueManager.add(nextTrack);
  mpv.seedCurrentTrack(currentTrack);

  createQueuePlaybackController(mpv as never, queueManager, {
    search: async () => [],
    getAudioUrl: async (id: string) => ({
      streamUrl: `https://stream.test/${id}`,
      title: id === nextTrack.id ? nextTrack.title : currentTrack.title,
      artist: id === nextTrack.id ? nextTrack.artist : currentTrack.artist,
      duration: id === nextTrack.id ? nextTrack.duration : currentTrack.duration,
      thumbnail: id === nextTrack.id ? nextTrack.thumbnail : currentTrack.thumbnail,
    }),
  } as never);

  const webServer = createWebServer(mpv as never, queueManager, { port: await getAvailablePort() });
  webServer.openDashboardOnce = () => {};
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);

  const socket = new WebSocket(
    `${webServer.getDashboardUrl().replace('http', 'ws')}/ws?dashboardToken=${encodeURIComponent(auth.token)}`,
    { headers: { Origin: auth.origin } },
  );
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  try {
    socket.send(JSON.stringify({ type: 'pause' }));
    await waitFor(() => mpv.pauseCount === 1 && mpv.getState().isPlaying === false);

    socket.send(JSON.stringify({ type: 'pause' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(mpv.pauseCount, 1);
    assert.equal(mpv.resumeCount, 0);
    assert.equal(mpv.getState().isPlaying, false);

    socket.send(JSON.stringify({ type: 'playback-toggle' }));
    await waitFor(() => mpv.resumeCount === 1 && mpv.getState().isPlaying === true);

    socket.send(JSON.stringify({ type: 'playback-toggle' }));
    await waitFor(() => mpv.pauseCount === 2 && mpv.getState().isPlaying === false);

    socket.send(JSON.stringify({ type: 'playback-toggle' }));
    await waitFor(() => mpv.resumeCount === 2 && mpv.getState().isPlaying === true);

    socket.send(JSON.stringify({ type: 'playback-toggle' }));
    await waitFor(() => mpv.pauseCount === 3 && mpv.getState().isPlaying === false);

    socket.send(JSON.stringify({ type: 'next' }));
    await waitFor(() => mpv.playCount === 1 && queueManager.getNowPlaying()?.id === nextTrack.id && mpv.getState().isPlaying === true);

    assert.equal(mpv.stopCount, 1);
    assert.equal(queueManager.list().length, 0);
    assert.equal(queueManager.getNowPlaying()?.title, nextTrack.title);
  } finally {
    socket.close();
    await webServer.destroy();
  }
});

test('WebServer volume endpoint clamps out-of-range values and rejects malformed payloads', async () => {
  const queueManager = new QueueManager();
  const mpv = new PlaybackControlsFakeMpv();
  const webServer = createWebServer(mpv as never, queueManager, { port: await getAvailablePort() });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);

  try {
    const lowResponse = await fetch(`${webServer.getDashboardUrl()}/api/volume`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: -15 }),
    });
    const lowPayload = await lowResponse.json() as { volume: number };
    assert.equal(lowResponse.status, 200);
    assert.equal(lowPayload.volume, 0);
    assert.equal(mpv.getVolume(), 0);

    const highResponse = await fetch(`${webServer.getDashboardUrl()}/api/volume`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: 180 }),
    });
    const highPayload = await highResponse.json() as { volume: number };
    assert.equal(highResponse.status, 200);
    assert.equal(highPayload.volume, 100);
    assert.equal(mpv.getVolume(), 100);

    const invalidResponse = await fetch(`${webServer.getDashboardUrl()}/api/volume`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: null }),
    });
    const invalidPayload = await invalidResponse.json() as { message: string };
    assert.equal(invalidResponse.status, 400);
    assert.match(invalidPayload.message, /volume must be a number/i);
  } finally {
    await webServer.destroy();
  }
});

test('WebServer rejects unauthenticated websocket and volume requests', async () => {
  const queueManager = new QueueManager();
  const mpv = new PlaybackControlsFakeMpv();
  const webServer = createWebServer(mpv as never, queueManager, { port: await getAvailablePort() });
  await webServer.waitUntilReady();

  try {
    const socket = new WebSocket(`${webServer.getDashboardUrl().replace('http', 'ws')}/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    assert.equal(closeCode, 4403);

    const response = await fetch(`${webServer.getDashboardUrl()}/api/volume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume: 50 }),
    });
    assert.equal(response.status, 403);
  } finally {
    await webServer.destroy();
  }
});

test('WebServer serves local SVG placeholder artwork with image mime type', async () => {
  const queueManager = new QueueManager();
  const mpv = new PlaybackControlsFakeMpv();
  const webServer = createWebServer(mpv as never, queueManager, { port: await getAvailablePort() });
  await webServer.waitUntilReady();

  try {
    const response = await fetch(`${webServer.getDashboardUrl()}/assets/agentune-mark.svg`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/i);
    assert.match(body, /<svg/i);
  } finally {
    await webServer.destroy();
  }
});
