import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HistoryStore } from '../history/history-store.js';
import type { DiscoverCandidate } from './discover-batch-builder.js';
import { rankCandidates } from './discover-soft-ranker.js';

function getTempDbPath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbotify-discover-ranker-'));
  return path.join(tempDir, 'history.db');
}

function cleanupDb(dbPath: string): void {
  try {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  } catch {
    // ignore cleanup failures on Windows if a handle lingers after an assertion
  }
}

function seedPlay(
  store: HistoryStore,
  track: { title: string; artist: string; tags: string[]; playedSec?: number; skipped?: boolean },
): void {
  const playId = store.recordPlay({
    title: track.title,
    artist: track.artist,
    duration: 200,
    thumbnail: 'thumb',
    ytVideoId: `${track.artist}-${track.title}`.replace(/\s+/g, '-').toLowerCase(),
  });
  store.updateTrackTags(`${track.artist.toLowerCase()}::${track.title.toLowerCase()}`, track.tags);
  store.updatePlay(playId, { played_sec: track.playedSec ?? 190, skipped: track.skipped ?? false });
}

function candidate(title: string, artist: string, tags: string[]): DiscoverCandidate {
  return { title, artist, tags, provider: 'apple' };
}

test('rankCandidates favors familiar artists when loyalty is high', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    for (let index = 0; index < 10; index += 1) {
      seedPlay(store, { title: `Known ${index}`, artist: 'Familiar Artist', tags: ['ambient'] });
    }

    const ranked = rankCandidates(
      [
        candidate('Known New Single', 'Familiar Artist', ['ambient']),
        candidate('Fresh Arrival', 'Novel Artist', ['ambient']),
      ],
      { loyalty: 1, exploration: 0, variety: 0.5 },
      store,
    );

    assert.equal(ranked[0]?.artist, 'Familiar Artist');
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});

test('rankCandidates favors novel artists when exploration is high', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    for (let index = 0; index < 10; index += 1) {
      seedPlay(store, { title: `Known ${index}`, artist: 'Familiar Artist', tags: ['ambient'] });
    }

    const ranked = rankCandidates(
      [
        candidate('Known New Single', 'Familiar Artist', ['ambient']),
        candidate('Fresh Arrival', 'Novel Artist', ['ambient']),
      ],
      { loyalty: 0, exploration: 1, variety: 0.5 },
      store,
    );

    assert.equal(ranked[0]?.artist, 'Novel Artist');
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});

test('rankCandidates penalizes recent repeats and skipped tracks', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    seedPlay(store, { title: 'Repeat Me', artist: 'Artist A', tags: ['ambient'], playedSec: 30, skipped: true });
    seedPlay(store, { title: 'Reliable Pick', artist: 'Artist B', tags: ['ambient'], playedSec: 195 });

    const ranked = rankCandidates(
      [
        candidate('Repeat Me', 'Artist A', ['ambient']),
        candidate('Reliable Pick', 'Artist B', ['ambient']),
      ],
      { loyalty: 0.5, exploration: 0.5, variety: 0.5 },
      store,
    );

    assert.equal(ranked[0]?.title, 'Reliable Pick');
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});

test('rankCandidates treats empty tags as neutral instead of worst-case', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    for (let index = 0; index < 3; index += 1) {
      seedPlay(store, { title: `Ambient ${index}`, artist: 'Anchor Artist', tags: ['ambient'] });
    }

    const ranked = rankCandidates(
      [
        candidate('No Tags Candidate', 'Anchor Artist', []),
        candidate('Mismatched Tags Candidate', 'Anchor Artist', ['metal']),
      ],
      { loyalty: 0.5, exploration: 0.5, variety: 0.5 },
      store,
    );

    assert.equal(ranked[0]?.title, 'No Tags Candidate');
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});

test('rankCandidates breaks same-artist clusters after sorting', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    for (let index = 0; index < 6; index += 1) {
      seedPlay(store, { title: `Artist A ${index}`, artist: 'Artist A', tags: ['ambient'] });
    }
    seedPlay(store, { title: 'Artist B Seed', artist: 'Artist B', tags: ['ambient'] });

    const ranked = rankCandidates(
      [
        candidate('Artist A One', 'Artist A', ['ambient']),
        candidate('Artist A Two', 'Artist A', ['ambient']),
        candidate('Artist A Three', 'Artist A', ['ambient']),
        candidate('Artist B One', 'Artist B', ['ambient']),
      ],
      { loyalty: 1, exploration: 0, variety: 0.5 },
      store,
    );

    assert.notEqual(ranked[0]?.artist, ranked[1]?.artist);
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});

test('rankCandidates uses high variety to avoid repeating nearby tags', () => {
  const dbPath = getTempDbPath();
  let store: HistoryStore | null = null;
  try {
    store = new HistoryStore(dbPath);
    for (let index = 0; index < 8; index += 1) {
      seedPlay(store, { title: `Ambient ${index}`, artist: `Familiar ${index % 2}`, tags: ['ambient'] });
    }
    for (let index = 0; index < 2; index += 1) {
      seedPlay(store, { title: `Focus ${index}`, artist: `Focus Seed ${index}`, tags: ['focus'] });
    }

    const candidates = [
      candidate('Ambient Return One', 'Familiar 0', ['ambient']),
      candidate('Ambient Return Two', 'Familiar 1', ['ambient']),
      candidate('Focus Detour', 'Focus Explorer', ['focus']),
    ];

    const lowVariety = rankCandidates(
      candidates,
      { loyalty: 1, exploration: 0, variety: 0 },
      store,
    );
    const highVariety = rankCandidates(
      candidates,
      { loyalty: 1, exploration: 0, variety: 1 },
      store,
    );

    assert.deepEqual(lowVariety.slice(0, 2).map((entry) => entry.tags[0]), ['ambient', 'ambient']);
    assert.equal(highVariety[1]?.title, 'Focus Detour');
  } finally {
    store?.close();
    cleanupDb(dbPath);
  }
});
