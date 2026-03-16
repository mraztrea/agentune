// Smart search provider — ytsr-based intelligent query construction for discovery
// Simulates "related tracks", "mood search", "similar artists" via crafted YouTube queries
// Cache: 3-day TTL in provider_cache table (prefixed keys)

import type Database from 'better-sqlite3';
import type { YouTubeProvider, SearchResult } from './youtube-provider.js';
import { normalizeForQuery } from './metadata-normalizer.js';
import { ProviderCache } from './provider-cache.js';

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days (fresher than Apple)
const MIN_DURATION_MS = 60 * 1000;   // 1 min — filter out shorts/intros
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 min — filter out mixes/podcasts

export interface SmartTrack {
  title: string;
  artist: string;
  source: string;   // query that found this track
  videoId: string;   // YouTube video ID for direct play
}

export class SmartSearchProvider {
  private readonly cache: ProviderCache;

  constructor(
    private readonly youtube: YouTubeProvider,
    db: Database.Database,
  ) {
    this.cache = new ProviderCache(db, CACHE_TTL_MS);
    this.cache.evictExpired('smart:');
  }

  /** Related tracks via smart queries: "similar songs", "songs like X" */
  async getRelatedTracks(artist: string, title: string, limit = 8): Promise<SmartTrack[]> {
    const normArtist = normalizeForQuery(artist);
    const normTitle = normalizeForQuery(title);
    const cacheKey = `smart:related:${normArtist.toLowerCase()}::${normTitle.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as SmartTrack[]).slice(0, limit);

    const queries = [
      `${normArtist} similar songs`,
      `songs like ${normTitle} ${normArtist}`,
    ];

    const allResults = await this.runParallelQueries(queries, 8);
    // Deduplicate and exclude the current track
    const deduped = this.deduplicateResults(allResults, normArtist, normTitle);
    const results = deduped.slice(0, limit);

    this.cache.set(cacheKey, results);
    return results;
  }

  /** Mood-based discovery: "{mood} music playlist", "{mood} songs" */
  async searchByMood(mood: string, limit = 8): Promise<SmartTrack[]> {
    const normMood = mood.toLowerCase().trim();
    const cacheKey = `smart:mood:${normMood}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as SmartTrack[]).slice(0, limit);

    const queries = [
      `${normMood} music playlist`,
      `${normMood} songs ${new Date().getFullYear()}`,
    ];

    const allResults = await this.runParallelQueries(queries, 6);
    const results = this.deduplicateResults(allResults).slice(0, limit);

    this.cache.set(cacheKey, results);
    return results;
  }

  /** Similar artists: search "artists similar to X", extract unique channel names */
  async getArtistSuggestions(artist: string, limit = 5): Promise<string[]> {
    const normArtist = normalizeForQuery(artist);
    const cacheKey = `smart:artists:${normArtist.toLowerCase()}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return (cached as string[]).slice(0, limit);

    const query = `artists similar to ${normArtist}`;
    try {
      const searchResults = await this.youtube.search(query, 10);
      // Extract unique artist/channel names, excluding the original artist
      const seen = new Set<string>();
      const artists: string[] = [];
      const lowerOriginal = normArtist.toLowerCase();

      for (const r of searchResults) {
        const name = normalizeForQuery(r.artist);
        const lower = name.toLowerCase();
        if (lower === lowerOriginal || seen.has(lower) || !name) continue;
        seen.add(lower);
        artists.push(name);
        if (artists.length >= limit) break;
      }

      this.cache.set(cacheKey, artists);
      return artists;
    } catch (err) {
      console.error(`[sbotify] Smart artist suggestions failed: ${(err as Error).message}`);
      return [];
    }
  }

  // --- Internal helpers ---

  /** Run multiple ytsr queries in parallel, merge results */
  private async runParallelQueries(queries: string[], perQueryLimit: number): Promise<SmartTrack[]> {
    const results: SmartTrack[] = [];

    const settled = await Promise.allSettled(
      queries.map(async (q) => {
        try {
          const searchResults = await this.youtube.search(q, perQueryLimit);
          return { query: q, results: searchResults };
        } catch (err) {
          console.error(`[sbotify] Smart search query failed "${q}": ${(err as Error).message}`);
          return { query: q, results: [] as SearchResult[] };
        }
      }),
    );

    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      const { query, results: searchResults } = outcome.value;
      for (const r of searchResults) {
        // Filter by duration — skip shorts and long mixes
        if (r.durationMs > 0 && (r.durationMs < MIN_DURATION_MS || r.durationMs > MAX_DURATION_MS)) {
          continue;
        }
        results.push({
          title: normalizeForQuery(r.title),
          artist: normalizeForQuery(r.artist),
          source: query,
          videoId: r.id,
        });
      }
    }

    return results;
  }

  /** Deduplicate by videoId, optionally exclude a specific track */
  private deduplicateResults(
    tracks: SmartTrack[],
    excludeArtist?: string,
    excludeTitle?: string,
  ): SmartTrack[] {
    const seen = new Set<string>();
    const lowerExcludeArtist = excludeArtist?.toLowerCase();
    const lowerExcludeTitle = excludeTitle?.toLowerCase();

    return tracks.filter((t) => {
      if (seen.has(t.videoId)) return false;
      seen.add(t.videoId);

      // Exclude the current track if specified
      if (lowerExcludeArtist && lowerExcludeTitle) {
        if (t.artist.toLowerCase() === lowerExcludeArtist &&
            t.title.toLowerCase() === lowerExcludeTitle) {
          return false;
        }
      }
      return true;
    });
  }
}

// -- Singleton --

let smartProvider: SmartSearchProvider | null = null;

export function createSmartSearchProvider(
  youtube: YouTubeProvider, db: Database.Database,
): SmartSearchProvider {
  if (!smartProvider) {
    smartProvider = new SmartSearchProvider(youtube, db);
  }
  return smartProvider;
}

export function getSmartSearchProvider(): SmartSearchProvider | null {
  return smartProvider;
}
