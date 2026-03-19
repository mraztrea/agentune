import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import WebSocket from 'ws';
import { HistoryStore } from '../history/history-store.js';
import { invalidateDiscoverCache, getDiscoverPaginationCache } from '../taste/discover-pagination-cache.js';
import { handleSetPersonaTraits, handleUpdatePersona } from '../mcp/tool-handlers.js';
import { QueueManager } from '../queue/queue-manager.js';
import { createTasteEngine } from '../taste/taste-engine.js';
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbotify-web-sync-'));
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

async function waitForBufferedMessage(
  messages: Array<{ type?: string; data?: { taste?: string; traits?: { exploration?: number; variety?: number; loyalty?: number } } }>,
  predicate: (payload: { type?: string; data?: { taste?: string; traits?: { exploration?: number; variety?: number; loyalty?: number } } }) => boolean,
): Promise<{ type?: string; data?: { taste?: string; traits?: { exploration?: number; variety?: number; loyalty?: number } } }> {
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

test('WebServer syncs dashboard persona API and MCP manual trait updates', async () => {
  const dbPath = getTempDbPath();
  const store = new HistoryStore(dbPath);
  const tasteEngine = createTasteEngine(store);
  tasteEngine.saveTasteText('Initial taste');
  tasteEngine.saveTraits({ exploration: 0.25, variety: 0.5, loyalty: 0.75 });

  const webServer = createWebServer(new FakeMpv() as never, new QueueManager());
  await webServer.waitUntilReady();

  const socket = new WebSocket(`${webServer.getDashboardUrl().replace('http', 'ws')}/ws`);
  const messages: Array<{ type?: string; data?: { taste?: string; traits?: { exploration?: number; variety?: number; loyalty?: number } } }> = [];
  socket.on('message', (raw) => {
    messages.push(JSON.parse(raw.toString()) as { type?: string; data?: { taste?: string; traits?: { exploration?: number; variety?: number; loyalty?: number } } });
  });
  await new Promise<void>((resolve) => socket.once('open', () => resolve()));

  try {
    const initialResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`);
    const initialPayload = await initialResponse.json() as {
      taste: string;
      traits: { exploration: number; variety: number; loyalty: number };
    };
    assert.equal(initialPayload.taste, 'Initial taste');
    assert.deepEqual(initialPayload.traits, { exploration: 0.25, variety: 0.5, loyalty: 0.75 });

    const initialPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Initial taste',
    );
    assert.equal(initialPersona.data?.taste, 'Initial taste');
    assert.deepEqual(initialPersona.data?.traits, { exploration: 0.25, variety: 0.5, loyalty: 0.75 });

    const dashboardResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taste: 'Dashboard taste',
        traits: { exploration: 0.4, variety: 0.85, loyalty: 0.15 },
      }),
    });
    const dashboardPayload = await dashboardResponse.json() as {
      updated: boolean;
      taste: string;
      traits: { exploration: number; variety: number; loyalty: number };
    };
    assert.equal(dashboardPayload.updated, true);
    assert.equal(dashboardPayload.taste, 'Dashboard taste');
    assert.deepEqual(dashboardPayload.traits, { exploration: 0.4, variety: 0.85, loyalty: 0.15 });

    const dashboardPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Dashboard taste'
        && payload.data?.traits?.variety === 0.85,
    );
    assert.equal(dashboardPersona.data?.taste, 'Dashboard taste');

    const tasteOnlyCache = getDiscoverPaginationCache();
    tasteOnlyCache.setSnapshot(
      { genres: ['focus'] },
      [{ title: 'Focus Track', artist: 'Focus Artist', tags: ['focus'], provider: 'apple' }],
    );
    assert.notEqual(tasteOnlyCache.getPage({ genres: ['focus'] }, 1, 10), null);

    const tasteOnlyResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taste: 'Taste only dashboard update' }),
    });
    const tasteOnlyPayload = await tasteOnlyResponse.json() as {
      updated: boolean;
      taste: string;
      traits: { exploration: number; variety: number; loyalty: number };
    };
    assert.equal(tasteOnlyResponse.status, 200);
    assert.equal(tasteOnlyPayload.updated, true);
    assert.equal(tasteOnlyPayload.taste, 'Taste only dashboard update');
    assert.deepEqual(tasteOnlyPayload.traits, { exploration: 0.4, variety: 0.85, loyalty: 0.15 });
    assert.notEqual(tasteOnlyCache.getPage({ genres: ['focus'] }, 1, 10), null);

    const invalidResponse = await fetch(`${webServer.getDashboardUrl()}/api/persona`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        traits: { exploration: 2, variety: 0.4, loyalty: 0.5 },
      }),
    });
    const invalidPayload = await invalidResponse.json() as { message: string };
    assert.equal(invalidResponse.status, 400);
    assert.match(invalidPayload.message, /traits must include/i);

    const cache = getDiscoverPaginationCache();
    cache.setSnapshot(
      { genres: ['ambient'] },
      [{ title: 'Track', artist: 'Artist', tags: ['ambient'], provider: 'apple' }],
    );
    assert.notEqual(cache.getPage({ genres: ['ambient'] }, 1, 10), null);

    const traitsResult = await handleSetPersonaTraits({ exploration: 0.9, variety: 0.1, loyalty: 0.2 });
    assert.equal(traitsResult.isError, undefined);
    assert.equal(cache.getPage({ genres: ['ambient'] }, 1, 10), null);

    const traitsPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.traits?.exploration === 0.9,
    );
    assert.equal(traitsPersona.data?.taste, 'Taste only dashboard update');
    assert.deepEqual(traitsPersona.data?.traits, { exploration: 0.9, variety: 0.1, loyalty: 0.2 });

    const updateResult = await handleUpdatePersona({ taste: 'Updated taste' });
    assert.equal(updateResult.isError, undefined);

    const updatedPersona = await waitForBufferedMessage(
      messages,
      (payload) => payload.type === 'persona' && payload.data?.taste === 'Updated taste',
    );
    assert.equal(updatedPersona.data?.taste, 'Updated taste');
    assert.deepEqual(updatedPersona.data?.traits, { exploration: 0.9, variety: 0.1, loyalty: 0.2 });
  } finally {
    socket.close();
    await webServer.destroy();
    store.close();
    invalidateDiscoverCache();
    cleanupDb(dbPath);
  }
});
