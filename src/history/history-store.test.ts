// Comprehensive unit tests for HistoryStore — SQLite history foundation
// Tests: recordPlay, updatePlay, getRecent, getTopTracks, getTrackStats,
// normalizeTrackId, session state, preferences, hoursSinceLastPlay, getTrackPlayCount

import { test } from 'node:test';
import * as assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HistoryStore } from './history-store.js';
import { normalizeTrackId } from './history-schema.js';

// Helper to create temp DB path
function getTempDbPath(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbotify-test-'));
  return path.join(tmpDir, 'test-history.db');
}

// Helper to cleanup temp DB and directory
function cleanupDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  } catch {
    // Ignore cleanup errors
  }
}

test('normalizeTrackId - formats artist::title correctly', () => {
  const result = normalizeTrackId('Nils Frahm', 'Says');
  assert.strictEqual(result, 'nils frahm::says');

  const result2 = normalizeTrackId('  The Beatles  ', '  HELP!  ');
  assert.strictEqual(result2, 'the beatles::help!');

  const result3 = normalizeTrackId('', '');
  assert.strictEqual(result3, '::');
});

test('HistoryStore.recordPlay - creates track and play records', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const playId = store.recordPlay({
      title: 'Nylon',
      artist: 'Nils Frahm',
      duration: 215,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'dummyid123',
    });

    assert.strictEqual(typeof playId, 'number');
    assert.ok(playId > 0, 'playId should be positive');

    // Verify track exists
    const recent = store.getRecent(1);
    assert.strictEqual(recent.length, 1);
    assert.strictEqual(recent[0].id, 'nils frahm::nylon');
    assert.strictEqual(recent[0].title, 'Nylon');
    assert.strictEqual(recent[0].artist, 'Nils Frahm');
    assert.strictEqual(recent[0].duration_sec, 215);
    assert.strictEqual(recent[0].play_count, 1);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.recordPlay - with canonicalOverride', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const playId = store.recordPlay(
      {
        title: 'says',
        artist: 'nils frahm',
        duration: 180,
        thumbnail: 'https://example.com/thumb.jpg',
        ytVideoId: 'vid123',
      },
      undefined,
      { artist: 'Nils Frahm', title: 'Says' },
    );

    assert.ok(playId > 0);

    const recent = store.getRecent(1);
    assert.strictEqual(recent[0].title, 'Says');
    assert.strictEqual(recent[0].artist, 'Nils Frahm');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.recordPlay - with context', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const playId = store.recordPlay(
      {
        title: 'Test Track',
        artist: 'Test Artist',
        duration: 180,
        thumbnail: 'https://example.com/thumb.jpg',
        ytVideoId: 'vid123',
      },
      { mood: 'focus', source: 'mcp_server' },
    );

    assert.ok(playId > 0);

    const recent = store.getRecent(1);
    assert.strictEqual(recent.length, 1);
    // Context is stored but not returned in getRecent, just verify play was recorded
    // Note: getRecent aliases started_at as play_started_at from the query
    const playRecord = recent[0] as any;
    assert.ok(playRecord.play_started_at > 0 || playRecord.started_at > 0, 'play record should have timestamp');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.recordPlay - duplicate track increments play_count', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const track = {
      title: 'Same Track',
      artist: 'Same Artist',
      duration: 200,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid123',
    };

    const play1 = store.recordPlay(track);
    assert.ok(play1 > 0);

    const play2 = store.recordPlay(track);
    assert.ok(play2 > play1);

    const recent = store.getRecent(2);
    assert.strictEqual(recent[0].play_count, 2);
    assert.strictEqual(recent[1].play_count, 2);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.updatePlay - updates played_sec and skipped', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const playId = store.recordPlay({
      title: 'Track A',
      artist: 'Artist A',
      duration: 300,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid123',
    });

    store.updatePlay(playId, { played_sec: 150 });
    let recent = store.getRecent(1);
    assert.strictEqual(recent[0].played_sec, 150);

    store.updatePlay(playId, { skipped: true });
    recent = store.getRecent(1);
    assert.strictEqual(recent[0].skipped, 1);

    store.updatePlay(playId, { played_sec: 250, skipped: false });
    recent = store.getRecent(1);
    assert.strictEqual(recent[0].played_sec, 250);
    assert.strictEqual(recent[0].skipped, 0);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getRecent - returns recent plays ordered by time', async () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    store.recordPlay({
      title: 'Track 1',
      artist: 'Artist 1',
      duration: 200,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid1',
    });

    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));

    store.recordPlay({
      title: 'Track 2',
      artist: 'Artist 2',
      duration: 200,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid2',
    });

    const recent = store.getRecent(10);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].title, 'Track 2', 'Most recent should be first');
    assert.strictEqual(recent[1].title, 'Track 1');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getRecent - respects limit', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    for (let i = 0; i < 5; i++) {
      store.recordPlay({
        title: `Track ${i}`,
        artist: `Artist ${i}`,
        duration: 200,
        thumbnail: 'https://example.com/thumb.jpg',
        ytVideoId: `vid${i}`,
      });
    }

    const recent = store.getRecent(3);
    assert.strictEqual(recent.length, 3);

    const all = store.getRecent(100);
    assert.strictEqual(all.length, 5);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getRecent - filters by query (title or artist)', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    store.recordPlay({
      title: 'Nylon',
      artist: 'Nils Frahm',
      duration: 215,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid1',
    });

    store.recordPlay({
      title: 'Unfinished',
      artist: 'Nils Frahm',
      duration: 240,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid2',
    });

    store.recordPlay({
      title: 'Breathe',
      artist: 'The Pink Floyd',
      duration: 300,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid3',
    });

    // Query by artist
    const nils = store.getRecent(10, 'Nils');
    assert.strictEqual(nils.length, 2);

    // Query by title
    const unfinished = store.getRecent(10, 'Unfinished');
    assert.strictEqual(unfinished.length, 1);
    assert.strictEqual(unfinished[0].title, 'Unfinished');

    // Query that matches nothing
    const noMatch = store.getRecent(10, 'NonExistent');
    assert.strictEqual(noMatch.length, 0);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTrackStats - returns play count, completion, skip rate', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const trackId = 'test artist::test track';
    const track = {
      title: 'Test Track',
      artist: 'Test Artist',
      duration: 300,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid123',
    };

    // Play 1: full listen
    const play1 = store.recordPlay(track);
    store.updatePlay(play1, { played_sec: 300, skipped: false });

    // Play 2: partial listen (50%)
    const play2 = store.recordPlay(track);
    store.updatePlay(play2, { played_sec: 150, skipped: false });

    // Play 3: skipped
    const play3 = store.recordPlay(track);
    store.updatePlay(play3, { played_sec: 10, skipped: true });

    const stats = store.getTrackStats(trackId);
    assert.strictEqual(stats.playCount, 3);
    assert.ok(stats.avgCompletion > 0.5 && stats.avgCompletion < 1, 'avg completion should be between 0.5 and 1');
    assert.strictEqual(stats.skipRate, 1 / 3, 'skip rate should be 1/3');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTrackStats - returns zero stats for non-existent track', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const stats = store.getTrackStats('nonexistent::track');
    assert.deepStrictEqual(stats, { playCount: 0, avgCompletion: 0, skipRate: 0 });

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTopTracks - returns tracks ordered by play count', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    // Track A: 3 plays
    const trackA = { title: 'Track A', artist: 'Artist A', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid1' };
    store.recordPlay(trackA);
    store.recordPlay(trackA);
    store.recordPlay(trackA);

    // Track B: 2 plays
    const trackB = { title: 'Track B', artist: 'Artist B', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid2' };
    store.recordPlay(trackB);
    store.recordPlay(trackB);

    // Track C: 1 play
    const trackC = { title: 'Track C', artist: 'Artist C', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid3' };
    store.recordPlay(trackC);

    const top = store.getTopTracks(10);
    assert.strictEqual(top.length, 3);
    assert.strictEqual(top[0].play_count, 3);
    assert.strictEqual(top[1].play_count, 2);
    assert.strictEqual(top[2].play_count, 1);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTopTracks - respects limit', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    for (let i = 0; i < 15; i++) {
      store.recordPlay({
        title: `Track ${i}`,
        artist: `Artist ${i}`,
        duration: 200,
        thumbnail: 'https://example.com/thumb.jpg',
        ytVideoId: `vid${i}`,
      });
    }

    const top = store.getTopTracks(5);
    assert.strictEqual(top.length, 5);

    const all = store.getTopTracks(100);
    assert.strictEqual(all.length, 15);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTrackPlayCount - returns play count for artist/title', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const track = { title: 'Some Track', artist: 'Some Artist', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid1' };

    assert.strictEqual(store.getTrackPlayCount('Some Artist', 'Some Track'), 0);

    store.recordPlay(track);
    assert.strictEqual(store.getTrackPlayCount('Some Artist', 'Some Track'), 1);

    store.recordPlay(track);
    assert.strictEqual(store.getTrackPlayCount('Some Artist', 'Some Track'), 2);

    // Query with different case
    assert.strictEqual(store.getTrackPlayCount('some artist', 'some track'), 2);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.hoursSinceLastPlay - returns hours since last play', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const track = { title: 'Track', artist: 'Artist', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid1' };

    // Non-existent track should return Infinity
    assert.strictEqual(store.hoursSinceLastPlay('Artist', 'Track'), Infinity);

    const now = Date.now();
    store.recordPlay(track);

    const hours = store.hoursSinceLastPlay('Artist', 'Track');
    assert.ok(hours < 1, 'Recently played track should be < 1 hour');
    assert.ok(hours >= 0, 'hours should be non-negative');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.saveSessionState / getSessionState - persists session state', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const state = {
      lane: { name: 'chill', bpm: 120 },
      tasteState: { mood: 'focus', energy: 0.7 },
      agentPersona: { name: 'DJ Claude', style: 'eclectic' },
      currentIntent: { action: 'discover', genre: 'ambient' },
    };

    store.saveSessionState(state);

    const retrieved = store.getSessionState();
    assert.deepStrictEqual(retrieved, state);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.saveSessionState - overwrites previous state', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const state1 = { lane: { name: 'first' }, tasteState: { mood: 'happy' } };
    store.saveSessionState(state1);

    const state2 = { lane: { name: 'second' }, tasteState: { mood: 'sad' } };
    store.saveSessionState(state2);

    const retrieved = store.getSessionState();
    assert.strictEqual((retrieved.lane as any)?.name, 'second');
    assert.strictEqual((retrieved.tasteState as any)?.mood, 'sad');

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getSessionState - returns empty object if not set', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const state = store.getSessionState();
    assert.deepStrictEqual(state, {});

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.setPreference / getPreference - stores preferences', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    store.setPreference('ambient', 0.8, 0.2);

    const pref = store.getPreference('ambient');
    assert.ok(pref);
    assert.strictEqual(pref.key, 'ambient');
    assert.strictEqual(pref.weight, 0.8);
    assert.strictEqual(pref.boredom, 0.2);
    assert.ok(pref.last_seen_at > 0);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.setPreference - overwrites existing preference', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    store.setPreference('jazz', 0.5, 0.1);
    let pref = store.getPreference('jazz');
    assert.strictEqual(pref?.weight, 0.5);

    store.setPreference('jazz', 0.9, 0.3);
    pref = store.getPreference('jazz');
    assert.strictEqual(pref?.weight, 0.9);
    assert.strictEqual(pref?.boredom, 0.3);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getPreference - returns undefined for non-existent key', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const pref = store.getPreference('nonexistent');
    assert.strictEqual(pref, undefined);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.close - closes database connection', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    store.recordPlay({
      title: 'Track',
      artist: 'Artist',
      duration: 200,
      thumbnail: 'https://example.com/thumb.jpg',
      ytVideoId: 'vid1',
    });

    store.close();

    // Attempting to use store after close should throw
    assert.throws(() => {
      store.getRecent();
    });

    store.close(); // Should not throw on second close

    store.close(); // Should not throw on third close
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore - concurrent operations on same database', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    const track = { title: 'Concurrent', artist: 'Test', duration: 200, thumbnail: 'https://example.com/thumb.jpg', ytVideoId: 'vid1' };

    const play1 = store.recordPlay(track);
    const play2 = store.recordPlay(track);
    const play3 = store.recordPlay(track);

    store.updatePlay(play1, { played_sec: 100 });
    store.updatePlay(play2, { played_sec: 200 });
    store.updatePlay(play3, { played_sec: 300 });

    const recent = store.getRecent(3);
    assert.strictEqual(recent.length, 3);
    assert.strictEqual(recent[0].play_count, 3);

    const stats = store.getTrackStats('test::concurrent');
    assert.strictEqual(stats.playCount, 3);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});

test('HistoryStore.getTrackTags - returns parsed tags', () => {
  const dbPath = getTempDbPath();
  try {
    const store = new HistoryStore(dbPath);

    // For now, tags are empty by default, but testing retrieval
    const tags = store.getTrackTags('any::track');
    assert.deepStrictEqual(tags, []);

    store.close();
  } finally {
    cleanupDb(dbPath);
  }
});
