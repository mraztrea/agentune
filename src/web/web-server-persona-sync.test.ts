import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import { createServer } from 'http';
import os from 'os';
import path from 'path';
import test from 'node:test';
import WebSocket from 'ws';
import { HistoryStore } from '../history/history-store.js';
import { getDiscoverPaginationCache, invalidateDiscoverCache } from '../taste/discover-pagination-cache.js';
import { handleUpdatePersona } from '../mcp/tool-handlers.js';
import { QueueManager } from '../queue/queue-manager.js';
import { createTasteEngine } from '../taste/taste-engine.js';
import { getDashboardAuth } from './web-server-test-helpers.js';
import { createWebServer } from './web-server.js';

class FakeMpv extends EventEmitter {
  getState(): { currentTrack: null; isPlaying: false; volume: number; isMuted: boolean } {
    return { currentTrack: null, isPlaying: false, volume: 80, isMuted: false };
  }

  isReady(): boolean {
    return false;
  }

  async getPosition(): Promise<number> {
    return 0;
  }

  getVolume(): number {
    return 80;
  }

  getIsMuted(): boolean {
    return false;
  }
}

function getTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentune-web-sync-'));
  return path.join(tmpDir, 'history.db');
}

function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } catch {
    // ignore cleanup errors in tests
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

async function waitForBufferedMessage(
  messages: Array<{ type?: string; data?: { taste?: string } }>,
  predicate: (payload: { type?: string; data?: { taste?: string } }) => boolean,
): Promise<{ type?: string; data?: { taste?: string } }> {
  return await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      const match = messages.find((payload) => predicate(payload));
      if (match) {
        resolve(match);
        return;
      }

      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for websocket message.'));
        return;
      }

      setTimeout(check, 25);
    };

    check();
  });
}

test('WebServer syncs dashboard persona API and MCP taste updates without touching discover cache', async () => {
  const dbPath = getTempDbPath();
  const store = new HistoryStore(dbPath);
  const tasteEngine = createTasteEngine(store);
  tasteEngine.saveTasteText('Initial taste');

  const webServer = createWebServer(new FakeMpv() as never, new QueueManager(), {
    historyStore: store,
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);

  const socket = new WebSocket(
    `${webServer.getDashboardUrl().replace('http', 'ws')}/ws?dashboardToken=${encodeURIComponent(auth.token)}`,
    { headers: { Origin: auth.origin } },
  );
  const messages: Array<{ type?: string; data?: { taste?: string } }> = [];
  socket.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()) as { type?: string; data?: { taste?: string } });
  });
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  try {
    const initialResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      headers: auth.headers,
    });
    const initialPayload = await initialResponse.json() as { taste: string };
    assert.equal(initialPayload.taste, 'Initial taste');

    const initialPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Initial taste',
    );
    assert.equal(initialPersona.data?.taste, 'Initial taste');

    const cache = getDiscoverPaginationCache();
    cache.setSnapshot(
      { keywords: ['focus'] },
      [{ title: 'Focus Track', artist: 'Focus Artist', tags: ['focus'], provider: 'apple' }],
    );
    assert.notEqual(cache.getPage({ keywords: ['focus'] }, 1, 10), null);

    const dashboardResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taste: 'Dashboard taste' }),
    });
    const dashboardPayload = await dashboardResponse.json() as {
      updated: boolean;
      taste: string;
    };
    assert.equal(dashboardPayload.updated, true);
    assert.equal(dashboardPayload.taste, 'Dashboard taste');
    assert.notEqual(cache.getPage({ keywords: ['focus'] }, 1, 10), null);

    const dashboardPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Dashboard taste',
    );
    assert.equal(dashboardPersona.data?.taste, 'Dashboard taste');

    const invalidResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const invalidPayload = await invalidResponse.json() as { message: string };
    assert.equal(invalidResponse.status, 400);
    assert.match(invalidPayload.message, /taste field required/i);

    const oversizedResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { ...auth.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ taste: 'x'.repeat(1024 * 1024) }),
    });
    const oversizedPayload = await oversizedResponse.json() as { message: string };
    assert.equal(oversizedResponse.status, 400);
    assert.match(oversizedPayload.message, /taste field required/i);

    const updateResult = await handleUpdatePersona({ taste: 'Updated taste' });
    assert.equal(updateResult.isError, undefined);
    assert.notEqual(cache.getPage({ keywords: ['focus'] }, 1, 10), null);

    const updatedPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Updated taste',
    );
    assert.equal(updatedPersona.data?.taste, 'Updated taste');
  } finally {
    socket.close();
    await webServer.destroy();
    store.close();
    invalidateDiscoverCache();
    cleanupDb(dbPath);
  }
});

test('WebServer persona API rejects missing dashboard auth token', async () => {
  const dbPath = getTempDbPath();
  const store = new HistoryStore(dbPath);
  createTasteEngine(store);

  const webServer = createWebServer(new FakeMpv() as never, new QueueManager(), {
    historyStore: store,
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();

  try {
    const response = await fetch(`${webServer.getDashboardUrl()}/api/persona`);
    assert.equal(response.status, 403);
  } finally {
    await webServer.destroy();
    store.close();
    cleanupDb(dbPath);
  }
});
