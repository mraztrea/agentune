import type { AppleSearchProvider, AppleTrack } from '../providers/apple-search-provider.js';
import { normalizeForQuery } from '../providers/metadata-normalizer.js';
import { scoreSearchResults, type ScoredResult } from '../providers/search-result-scorer.js';
import type { SearchResult, YouTubeProvider } from '../providers/youtube-provider.js';

const APPLE_MIN_SCORE = 0.6;
const YOUTUBE_MIN_SCORE = 0.2;

export interface ResolvedSong {
  matched: boolean;
  canonicalTitle: string;
  canonicalArtist?: string;
  canonicalSource: 'apple_search' | 'apple_artist_tracks' | 'input';
  matchScore: number;
  matchReasons: string[];
  result?: SearchResult;
  alternatives: Array<{
    id: string;
    title: string;
    artist: string;
    score: number;
    reasons: string[];
  }>;
}

interface AppleCandidate {
  title: string;
  artist: string;
  source: 'apple_search' | 'apple_artist_tracks';
  score: number;
}

function normalize(text: string): string {
  return normalizeForQuery(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let hits = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) hits += 1;
  }
  return hits / Math.max(wordsA.size, wordsB.size);
}

function scoreAppleTrack(track: AppleTrack, title: string, artist?: string): number {
  const normalizedTrackTitle = normalize(track.title);
  const normalizedTitle = normalize(title);
  let score = 0;

  if (normalizedTrackTitle === normalizedTitle) {
    score += 1.0;
  } else if (normalizedTrackTitle.startsWith(normalizedTitle)) {
    score += 0.8;
  } else if (normalizedTrackTitle.includes(normalizedTitle)) {
    score += 0.6;
  } else {
    score += wordOverlap(normalizedTrackTitle, normalizedTitle) * 0.4;
  }

  if (artist) {
    const normalizedArtist = normalize(artist);
    const normalizedTrackArtist = normalize(track.artist);
    if (
      normalizedTrackArtist.includes(normalizedArtist) ||
      normalizedArtist.includes(normalizedTrackArtist)
    ) {
      score += 0.4;
    }
  }

  if (track.durationMs >= 120000 && track.durationMs <= 420000) {
    score += 0.05;
  }

  return Math.round(score * 100) / 100;
}

function dedupeAppleTracks(
  tracks: AppleTrack[],
  source: 'apple_search' | 'apple_artist_tracks',
  title: string,
  artist?: string,
): AppleCandidate[] {
  const seen = new Set<string>();

  return tracks.flatMap((track) => {
    const key = `${normalize(track.artist)}::${normalize(track.title)}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      title: track.title,
      artist: track.artist,
      source,
      score: scoreAppleTrack(track, title, artist),
    }];
  });
}

async function pickCanonicalTrack(
  title: string,
  artist: string | undefined,
  apple: AppleSearchProvider | null,
): Promise<{
  title: string;
  artist?: string;
  source: 'apple_search' | 'apple_artist_tracks' | 'input';
}> {
  if (!apple) {
    return { title, artist, source: 'input' };
  }

  const scoredCandidates: AppleCandidate[] = [];
  const searchTracks = await apple.searchTracks(artist ? `${artist} ${title}` : title, 8);
  scoredCandidates.push(...dedupeAppleTracks(searchTracks, 'apple_search', title, artist));

  if (artist) {
    const artistTracks = await apple.getArtistTracks(artist, 10);
    scoredCandidates.push(...dedupeAppleTracks(artistTracks, 'apple_artist_tracks', title, artist));
  }

  scoredCandidates.sort((a, b) => b.score - a.score);
  if (scoredCandidates[0] && scoredCandidates[0].score >= APPLE_MIN_SCORE) {
    return {
      title: scoredCandidates[0].title,
      artist: scoredCandidates[0].artist,
      source: scoredCandidates[0].source,
    };
  }

  return { title, artist, source: 'input' };
}

function mergeScoredResults(pools: ScoredResult[][]): ScoredResult[] {
  const bestById = new Map<string, ScoredResult>();

  for (const pool of pools) {
    for (const scored of pool) {
      const previous = bestById.get(scored.result.id);
      if (!previous || scored.score > previous.score) {
        bestById.set(scored.result.id, scored);
      }
    }
  }

  return [...bestById.values()].sort((a, b) => b.score - a.score);
}

async function searchYoutubeWithFallback(
  youtube: YouTubeProvider,
  queries: string[],
  title: string,
  artist?: string,
): Promise<ScoredResult[]> {
  const scoredPools: ScoredResult[][] = [];
  let lastError: Error | null = null;

  for (const query of queries) {
    try {
      const results = await youtube.search(query, 10);
      scoredPools.push(scoreSearchResults(results, title, artist));
    } catch (err) {
      lastError = err as Error;
      console.error(`[sbotify] Resolver query failed "${query}": ${lastError.message}`);
    }
  }

  if (scoredPools.length === 0 && lastError) {
    throw lastError;
  }

  return mergeScoredResults(scoredPools);
}

export async function resolveSong(
  youtube: YouTubeProvider,
  apple: AppleSearchProvider | null,
  args: { title: string; artist?: string },
): Promise<ResolvedSong> {
  const canonical = await pickCanonicalTrack(args.title, args.artist, apple);
  const canonicalArtist = canonical.artist ?? args.artist;
  const canonicalTitle = canonical.title;

  const queries = [
    canonicalArtist ? `${canonicalArtist} - ${canonicalTitle} official audio` : `${canonicalTitle} official audio`,
    canonicalArtist ? `${canonicalArtist} ${canonicalTitle}` : canonicalTitle,
    args.artist && args.artist !== canonicalArtist ? `${args.artist} ${args.title}` : '',
  ].filter(Boolean);

  const scored = await searchYoutubeWithFallback(youtube, queries, canonicalTitle, canonicalArtist);
  const best = scored[0];

  if (!best || best.score < YOUTUBE_MIN_SCORE) {
    return {
      matched: false,
      canonicalTitle,
      canonicalArtist,
      canonicalSource: canonical.source,
      matchScore: best?.score ?? 0,
      matchReasons: best?.reasons ?? [],
      alternatives: scored.slice(0, 3).map((item) => ({
        id: item.result.id,
        title: item.result.title,
        artist: item.result.artist,
        score: item.score,
        reasons: item.reasons,
      })),
    };
  }

  return {
    matched: true,
    canonicalTitle,
    canonicalArtist,
    canonicalSource: canonical.source,
    matchScore: best.score,
    matchReasons: best.reasons,
    result: best.result,
    alternatives: scored.slice(1, 4).map((item) => ({
      id: item.result.id,
      title: item.result.title,
      artist: item.result.artist,
      score: item.score,
      reasons: item.reasons,
    })),
  };
}
