// Apple iTunes Search API provider — zero-key metadata/genre source for discovery pipeline
// Endpoints: search tracks, artist tracks, track genre, genre search
// Cache: 7-day TTL in provider_cache table (prefixed keys)

import type Database from 'better-sqlite3';
import { normalizeForQuery } from './metadata-normalizer.js';
import { ProviderCache } from './provider-cache.js';

const APPLE_API_URL = 'https://itunes.apple.com/search';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const FETCH_TIMEOUT_MS = 5000;

export interface AppleTrack {
  title: string;
  artist: string;
  album: string;
  genre: string;
  durationMs: number;
  artwork: string;
}

interface AppleApiResult {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  primaryGenreName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
}

export class AppleSearchProvider {
  private readonly cache: ProviderCache;

  constructor(db: Database.Database) {
    this.cache = new ProviderCache(db, CACHE_TTL_MS);
    this.cache.evictExpired('apple:');
  }

  async searchTracks(query: string, limit = 10): Promise<AppleTrack[]> {
    const normalized = normalizeForQuery(query);
    const cacheKey = `apple:search:${normalized.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as AppleTrack[]).slice(0, limit);

    const results = await this.fetchApple({ term: normalized, entity: 'song', limit: String(limit) });
    if (!results) return [];

    this.cache.set(cacheKey, results);
    return results.slice(0, limit);
  }

  async getArtistTracks(artist: string, limit = 10): Promise<AppleTrack[]> {
    const normalized = normalizeForQuery(artist);
    const cacheKey = `apple:artist:${normalized.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as AppleTrack[]).slice(0, limit);

    const results = await this.fetchApple({
      term: normalized, entity: 'song', attribute: 'artistTerm', limit: String(limit),
    });
    if (!results) return [];

    this.cache.set(cacheKey, results);
    return results.slice(0, limit);
  }

  async getTrackGenre(artist: string, title: string): Promise<string[]> {
    const normArtist = normalizeForQuery(artist).toLowerCase();
    const normTitle = normalizeForQuery(title).toLowerCase();
    const cacheKey = `apple:genre:${normArtist}::${normTitle}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached as string[];

    const results = await this.fetchApple({
      term: `${normalizeForQuery(artist)} ${normalizeForQuery(title)}`,
      entity: 'song', limit: '3',
    });
    if (!results || results.length === 0) return [];

    // Collect unique genres from results
    const genres = [...new Set(results.map(r => r.genre).filter(Boolean))];
    this.cache.set(cacheKey, genres);
    return genres;
  }

  async searchByGenre(genre: string, limit = 10): Promise<AppleTrack[]> {
    const normalized = genre.toLowerCase().trim();
    const cacheKey = `apple:bygenre:${normalized}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as AppleTrack[]).slice(0, limit);

    const results = await this.fetchApple({
      term: normalized, entity: 'song', limit: String(limit),
    });
    if (!results) return [];

    this.cache.set(cacheKey, results);
    return results.slice(0, limit);
  }

  // --- HTTP (private) ---

  private async fetchApple(params: Record<string, string>): Promise<AppleTrack[] | null> {
    const url = new URL(APPLE_API_URL);
    url.searchParams.set('media', 'music');
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const response = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        console.error(`[sbotify] Apple API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const json = await response.json() as { resultCount?: number; results?: AppleApiResult[] };
      const raw = json.results ?? [];

      return raw.map((r) => ({
        title: r.trackName ?? '',
        artist: r.artistName ?? '',
        album: r.collectionName ?? '',
        genre: r.primaryGenreName ?? '',
        durationMs: r.trackTimeMillis ?? 0,
        artwork: r.artworkUrl100 ?? '',
      }));
    } catch (err) {
      console.error(`[sbotify] Apple fetch failed: ${(err as Error).message}`);
      return null;
    }
  }
}

// -- Singleton --

let appleProvider: AppleSearchProvider | null = null;

export function createAppleSearchProvider(db: Database.Database): AppleSearchProvider {
  if (!appleProvider) {
    appleProvider = new AppleSearchProvider(db);
  }
  return appleProvider;
}

export function getAppleSearchProvider(): AppleSearchProvider | null {
  return appleProvider;
}
