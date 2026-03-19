import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import { HistoryStore } from './history-store.js';

function getTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbotify-history-redesign-'));
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

function recordPlay(
  store: HistoryStore,
  track: { title: string; artist: string; duration: number; tags?: string[]; playedSec?: number; skipped?: boolean },
): void {
  const playId = store.recordPlay({
    title: track.title,
    artist: track.artist,
    duration: track.duration,
    thumbnail: 'thumb',
    ytVideoId: `${track.artist}-${track.title}`.replace(/\s+/g, '-').toLowerCase(),
  });
  if (track.tags) {
    store.updateTrackTags(`${track.artist.toLowerCase()}::${track.title.toLowerCase()}`, track.tags);
  }
  store.updatePlay(playId, { played_sec: track.playedSec ?? track.duration, skipped: track.skipped ?? false });
}

test('HistoryStore.getTopArtists counts real plays instead of multiplying track totals', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);
    recordPlay(store, { title: 'Track 1', artist: 'Artist A', duration: 200, playedSec: 180 });
    recordPlay(store, { title: 'Track 2', artist: 'Artist A', duration: 200, playedSec: 190 });
    recordPlay(store, { title: 'Track 3', artist: 'Artist A', duration: 200, playedSec: 170 });
    recordPlay(store, { title: 'Track 4', artist: 'Artist B', duration: 200, playedSec: 120, skipped: true });

    const topArtists = store.getTopArtists(5);
    assert.equal(topArtists[0]?.artist, 'Artist A');
    assert.equal(topArtists[0]?.plays, 3);
    assert.equal(topArtists[1]?.artist, 'Artist B');
    assert.equal(topArtists[1]?.plays, 1);
    assert.ok(topArtists[0]?.avgCompletion > topArtists[1]?.avgCompletion);
    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore exposes detailed recent plays, tag stats, and manual persona state', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);
    recordPlay(store, {
      title: 'Focus Track',
      artist: 'Artist A',
      duration: 200,
      tags: ['ambient', 'focus'],
      playedSec: 150,
      skipped: true,
    });
    recordPlay(store, {
      title: 'Night Track',
      artist: 'Artist B',
      duration: 240,
      tags: ['ambient', 'night'],
      playedSec: 210,
    });
    store.savePersonaTasteText('Warm ambient and slow piano.');
    store.savePersonaTraits({ exploration: 0.8, variety: 0.35, loyalty: 0.6 });

    const recentDetailed = store.getRecentPlaysDetailed(5);
    const topTags = store.getTopTags(5);

    assert.equal(recentDetailed.length, 2);
    assert.deepEqual(recentDetailed[0]?.tags, ['ambient', 'night']);
    assert.equal(recentDetailed[1]?.skipped, true);
    assert.ok(topTags.some((tag) => tag.tag === 'ambient' && tag.frequency >= 2));
    assert.equal(store.getPersonaTasteText(), 'Warm ambient and slow piano.');
    assert.deepEqual(store.getPersonaTraits(), { exploration: 0.8, variety: 0.35, loyalty: 0.6 });
    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore migrates existing session_state tables to include manual persona columns', () => {
  const dbPath = getTempDbPath();
  try {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE session_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        lane_json TEXT DEFAULT '{}',
        taste_state_json TEXT DEFAULT '{}',
        agent_persona_json TEXT DEFAULT '{}',
        current_intent_json TEXT DEFAULT '{}'
      );
      INSERT INTO session_state (id, lane_json, taste_state_json, agent_persona_json, current_intent_json)
      VALUES (1, '{}', '{}', '{}', '{}');
    `);
    legacyDb.close();

    const store = new HistoryStore(dbPath);
    store.savePersonaTasteText('Migrated taste');
    store.savePersonaTraits({ exploration: 0.2, variety: 0.9, loyalty: 0.4 });
    assert.equal(store.getPersonaTasteText(), 'Migrated taste');
    assert.deepEqual(store.getPersonaTraits(), { exploration: 0.2, variety: 0.9, loyalty: 0.4 });
    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore rejects invalid manual persona traits', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    assert.throws(() => {
      store.savePersonaTraits({ exploration: -0.1, variety: 0.5, loyalty: 0.5 });
    });

    assert.deepEqual(store.getPersonaTraits(), { exploration: 0.5, variety: 0.5, loyalty: 0.5 });
    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});
