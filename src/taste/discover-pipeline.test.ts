import assert from 'node:assert/strict';
import test from 'node:test';
import type { BatchTrackStats } from '../history/history-store.js';
import { DiscoverBatchBuilder } from './discover-batch-builder.js';
import { DiscoverPaginationCache } from './discover-pagination-cache.js';
import { DiscoverPipeline } from './discover-pipeline.js';

class FakeAppleProvider {
  public artistCalls: string[] = [];
  public genreCalls: string[] = [];

  async getArtistTracks(artist: string): Promise<Array<{
    title: string;
    artist: string;
    album: string;
    genre: string;
    durationMs: number;
    artwork: string;
    trackId: number;
    artistId: number;
  }>> {
    this.artistCalls.push(artist);
    return [
      { title: `${artist} Song 1`, artist, album: 'Album', genre: 'ambient', durationMs: 200000, artwork: '', trackId: 1, artistId: 10 },
      { title: `${artist} Song 2`, artist, album: 'Album', genre: 'ambient', durationMs: 200000, artwork: '', trackId: 2, artistId: 10 },
      { title: `${artist} Song 3`, artist, album: 'Album', genre: 'ambient', durationMs: 200000, artwork: '', trackId: 3, artistId: 10 },
    ];
  }

  async searchByGenre(genre: string): Promise<Array<{
    title: string;
    artist: string;
    album: string;
    genre: string;
    durationMs: number;
    artwork: string;
    trackId: number;
    artistId: number;
  }>> {
    this.genreCalls.push(genre);
    return [
      { title: `${genre} Pulse`, artist: `${genre} Artist`, album: 'Album', genre, durationMs: 210000, artwork: '', trackId: 11, artistId: 21 },
      { title: `${genre} Pulse`, artist: `${genre} Artist`, album: 'Album', genre, durationMs: 210000, artwork: '', trackId: 12, artistId: 21 },
      { title: `${genre} Drift`, artist: `${genre} Artist`, album: 'Album', genre, durationMs: 210000, artwork: '', trackId: 13, artistId: 21 },
      { title: `${genre} Glow`, artist: `${genre} Artist`, album: 'Album', genre, durationMs: 210000, artwork: '', trackId: 14, artistId: 21 },
    ];
  }
}

function createStore(overrides?: {
  topArtists?: Array<{ artist: string; plays: number; avgCompletion: number }>;
  topTags?: Array<{ tag: string; frequency: number }>;
  recentCount?: number;
}): {
  getTopArtists: (limit?: number) => Array<{ artist: string; plays: number; avgCompletion: number }>;
  getTopTags: (limit?: number) => Array<{ tag: string; frequency: number }>;
  getRecentPlaysDetailed: (limit?: number) => Array<{ title: string; artist: string; completion: number; skipped: boolean; playedAt: number; tags: string[] }>;
  batchGetTrackStats: (trackIds: string[]) => Map<string, BatchTrackStats>;
} {
  return {
    getTopArtists: () => overrides?.topArtists ?? [{ artist: 'History Artist', plays: 5, avgCompletion: 0.9 }],
    getTopTags: () => overrides?.topTags ?? [{ tag: 'ambient', frequency: 5 }],
    getRecentPlaysDetailed: () => Array.from({ length: overrides?.recentCount ?? 10 }, (_, index) => ({
      title: `Recent ${index}`,
      artist: `Artist ${index}`,
      completion: 0.9,
      skipped: false,
      playedAt: Date.now() - index * 1000,
      tags: ['ambient'],
    })),
    batchGetTrackStats: (trackIds: string[]) => new Map(trackIds.map((trackId, index) => [trackId, {
      trackId,
      playCount: index === 0 ? 5 : 0,
      avgCompletion: index === 0 ? 0.9 : 0.5,
      skipRate: 0,
      hoursSinceLastPlay: Infinity,
    }])),
  };
}

function createPipeline(apple: FakeAppleProvider, store = createStore()): DiscoverPipeline {
  const batchBuilder = new DiscoverBatchBuilder(apple as never, store as never);
  return new DiscoverPipeline(
    batchBuilder,
    store as never,
    { getTraits: () => ({ exploration: 0.5, variety: 0.5, loyalty: 0.5 }) },
    new DiscoverPaginationCache(),
  );
}

test('DiscoverPipeline returns flat paginated candidates without internal Apple IDs', async () => {
  const pipeline = createPipeline(new FakeAppleProvider());
  const result = await pipeline.discover({ artist: 'Nils Frahm', limit: 2 });

  assert.equal(result.page, 1);
  assert.equal(result.limit, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0]?.provider, 'apple');
  assert.ok(!('appleTrackId' in result.candidates[0]!));
});

test('DiscoverPipeline uses history seeds when artist and genres are omitted', async () => {
  const apple = new FakeAppleProvider();
  const pipeline = createPipeline(apple);

  const result = await pipeline.discover({});

  assert.ok(result.candidates.length > 0);
  assert.deepEqual(apple.artistCalls, ['History Artist']);
  assert.deepEqual(apple.genreCalls, ['ambient']);
});

test('DiscoverPipeline paginates from cache without re-querying Apple', async () => {
  const apple = new FakeAppleProvider();
  const pipeline = createPipeline(apple);

  const pageOne = await pipeline.discover({ genres: ['ambient'], limit: 2 });
  const callsAfterPageOne = apple.genreCalls.length + apple.artistCalls.length;
  const pageTwo = await pipeline.discover({ genres: ['ambient'], page: 2, limit: 2 });

  assert.notDeepEqual(pageOne.candidates, pageTwo.candidates);
  assert.equal(apple.genreCalls.length + apple.artistCalls.length, callsAfterPageOne);
});

test('DiscoverPipeline marks page overflow as page exhaustion instead of cold-start empty', async () => {
  const pipeline = createPipeline(new FakeAppleProvider());

  await pipeline.discover({ genres: ['ambient'], limit: 2 });
  const overflow = await pipeline.discover({ genres: ['ambient'], page: 10, limit: 2 });

  assert.equal(overflow.candidates.length, 0);
  assert.equal(overflow.emptyReason, 'page_exhausted');
});

test('DiscoverPipeline returns empty results when there is no history and no explicit seeds', async () => {
  const pipeline = createPipeline(
    new FakeAppleProvider(),
    createStore({ topArtists: [], topTags: [] }),
  );

  const result = await pipeline.discover({});

  assert.equal(result.candidates.length, 0);
  assert.equal(result.hasMore, false);
});

test('DiscoverPipeline deduplicates repeated tracks and caps artist presence at three', async () => {
  const apple = new FakeAppleProvider();
  const pipeline = createPipeline(apple);

  const result = await pipeline.discover({ genres: ['ambient'], limit: 10 });
  const ambientArtistCount = result.candidates.filter((candidate) => candidate.artist === 'ambient Artist').length;

  assert.equal(ambientArtistCount, 3);
});

test('DiscoverPipeline preserves tags from duplicate candidates before ranking', async () => {
  const apple = new FakeAppleProvider();
  apple.searchByGenre = async (genre: string) => {
    apple.genreCalls.push(genre);
    return [{
      title: 'Shared Song',
      artist: 'Shared Artist',
      album: 'Album',
      genre: 'ambient',
      durationMs: 210000,
      artwork: '',
      trackId: genre === 'ambient' ? 11 : 12,
      artistId: 21,
    }];
  };

  const pipeline = createPipeline(apple);
  const result = await pipeline.discover({ genres: ['ambient', 'focus'] });

  assert.deepEqual(result.candidates[0]?.tags, ['ambient', 'focus']);
});

test('DiscoverPipeline keeps artist tags non-empty when Apple genre is blank', async () => {
  const apple = new FakeAppleProvider();
  apple.getArtistTracks = async (artist: string) => {
    apple.artistCalls.push(artist);
    return [{
      title: `${artist} Untagged`,
      artist,
      album: 'Album',
      genre: '',
      durationMs: 200000,
      artwork: '',
      trackId: 99,
      artistId: 88,
    }];
  };

  const pipeline = createPipeline(apple);
  const result = await pipeline.discover({ artist: 'Blank Genre Artist' });

  assert.deepEqual(result.candidates[0]?.tags, ['unknown']);
});

test('DiscoverPipeline shares the six-call budget across artist and genres', async () => {
  const apple = new FakeAppleProvider();
  const pipeline = createPipeline(apple);

  await pipeline.discover({
    artist: 'Seed Artist',
    genres: ['ambient', 'piano', 'focus', 'night', 'modern classical', 'drone'],
  });

  assert.deepEqual(apple.artistCalls, ['Seed Artist']);
  assert.deepEqual(apple.genreCalls, ['ambient', 'piano', 'focus', 'night', 'modern classical']);
});

test('DiscoverPaginationCache expires snapshots and evicts least recently used entries', async () => {
  const cache = new DiscoverPaginationCache(5, 2);
  const sample = [{ title: 'Track', artist: 'Artist', tags: ['ambient'], provider: 'apple' as const }];

  cache.setSnapshot({ artist: 'one' }, sample);
  cache.setSnapshot({ artist: 'two' }, sample);
  cache.getPage({ artist: 'one' }, 1, 10);
  cache.setSnapshot({ artist: 'three' }, sample);

  assert.equal(cache.getPage({ artist: 'two' }, 1, 10), null);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cache.getPage({ artist: 'one' }, 1, 10), null);
});

test('DiscoverPaginationCache invalidate clears snapshots and empty results are not cached', () => {
  const cache = new DiscoverPaginationCache();
  const sample = [{ title: 'Track', artist: 'Artist', tags: ['ambient'], provider: 'apple' as const }];

  cache.setSnapshot({ artist: 'one' }, []);
  assert.equal(cache.getPage({ artist: 'one' }, 1, 10), null);

  cache.setSnapshot({ artist: 'two' }, sample);
  cache.invalidate();
  assert.equal(cache.getPage({ artist: 'two' }, 1, 10), null);
});
