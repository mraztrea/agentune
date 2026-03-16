import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSong } from './song-resolver.js';

class FakeAppleProvider {
  constructor(
    private readonly searchResults: Array<{
      title: string;
      artist: string;
      album: string;
      genre: string;
      durationMs: number;
      artwork: string;
    }> = [],
    private readonly artistTracks: Array<{
      title: string;
      artist: string;
      album: string;
      genre: string;
      durationMs: number;
      artwork: string;
    }> = [],
  ) {}

  async searchTracks(): Promise<typeof this.searchResults> {
    return this.searchResults;
  }

  async getArtistTracks(): Promise<typeof this.artistTracks> {
    return this.artistTracks;
  }
}

class FakeYouTubeProvider {
  public queries: string[] = [];

  constructor(
    private readonly responses: Record<string, Array<{
      id: string;
      title: string;
      artist: string;
      duration: string;
      durationMs: number;
      thumbnail: string;
      url: string;
    }>>,
    private readonly failingQueries: Set<string> = new Set(),
  ) {}

  async search(query: string): Promise<Array<{
    id: string;
    title: string;
    artist: string;
    duration: string;
    durationMs: number;
    thumbnail: string;
    url: string;
  }>> {
    this.queries.push(query);
    if (this.failingQueries.has(query)) {
      throw new Error(`query failed: ${query}`);
    }
    return this.responses[query] ?? [];
  }
}

test('resolveSong prefers Apple canonical metadata before YouTube resolve', async () => {
  const apple = new FakeAppleProvider([
    {
      title: 'Blinding Lights',
      artist: 'The Weeknd',
      album: 'After Hours',
      genre: 'Pop',
      durationMs: 200000,
      artwork: '',
    },
  ]);
  const youtube = new FakeYouTubeProvider({
    'The Weeknd - Blinding Lights official audio': [{
      id: 'yt-1',
      title: 'The Weeknd - Blinding Lights (Official Audio)',
      artist: 'The Weeknd',
      duration: '3:20',
      durationMs: 200000,
      thumbnail: 'thumb',
      url: 'https://youtube.test/yt-1',
    }],
    'The Weeknd Blinding Lights': [],
  });

  const resolved = await resolveSong(
    youtube as never,
    apple as never,
    { title: 'Blinding Lights', artist: 'The Weeknd' },
  );

  assert.equal(resolved.matched, true);
  assert.equal(resolved.canonicalTitle, 'Blinding Lights');
  assert.equal(resolved.canonicalArtist, 'The Weeknd');
  assert.equal(resolved.canonicalSource, 'apple_search');
  assert.equal(resolved.result?.id, 'yt-1');
});

test('resolveSong falls back to a second YouTube query when the first query throws', async () => {
  const apple = new FakeAppleProvider([
    {
      title: 'Weightless',
      artist: 'Marconi Union',
      album: 'Weightless',
      genre: 'Ambient',
      durationMs: 480000,
      artwork: '',
    },
  ]);
  const youtube = new FakeYouTubeProvider(
    {
      'Marconi Union Weightless': [{
        id: 'yt-2',
        title: 'Marconi Union - Weightless',
        artist: 'Marconi Union',
        duration: '8:00',
        durationMs: 480000,
        thumbnail: 'thumb',
        url: 'https://youtube.test/yt-2',
      }],
    },
    new Set(['Marconi Union - Weightless official audio']),
  );

  const resolved = await resolveSong(
    youtube as never,
    apple as never,
    { title: 'Weightless', artist: 'Marconi Union' },
  );

  assert.equal(resolved.matched, true);
  assert.equal(resolved.result?.id, 'yt-2');
  assert.deepEqual(youtube.queries, [
    'Marconi Union - Weightless official audio',
    'Marconi Union Weightless',
  ]);
});
