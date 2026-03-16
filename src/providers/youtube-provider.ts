// YouTube search + audio URL extraction via @distube/ytsr and yt-dlp

import fs from 'node:fs';
import type { Video } from '@distube/ytsr';
import { youtubeDl } from 'youtube-dl-exec';

export interface SearchResult {
  id: string;
  title: string;
  artist: string;
  duration: string;      // "3:45" formatted
  durationMs: number;    // milliseconds
  thumbnail: string;
  url: string;           // YouTube watch URL
}

export interface AudioInfo {
  streamUrl: string;
  title: string;
  artist: string;
  duration: number;      // seconds
  thumbnail: string;
}

interface YtDlpSearchEntry {
  id?: string;
  title?: string;
  duration?: number | null;
  channel?: string | null;
  uploader?: string | null;
  thumbnails?: Array<{ url?: string | null }>;
  url?: string;
  webpage_url?: string;
}

interface YtDlpSearchResult {
  entries?: YtDlpSearchEntry[];
}

type YtsrSearch = (
  query: string,
  options?: { limit?: number; safeSearch?: boolean },
) => Promise<{ items: Video[] }>;

let ytsrModulePromise: Promise<YtsrSearch> | null = null;
let ytsrCompatPatched = false;

function ensureYtsrNode25Compatibility(): void {
  if (ytsrCompatPatched) return;

  const fsCompat = fs as typeof fs & {
    rmdirSync(path: fs.PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }): void;
  };
  const originalRmdirSync = fsCompat.rmdirSync.bind(fsCompat) as (...args: unknown[]) => void;

  fsCompat.rmdirSync = ((path: fs.PathLike, options?: { recursive?: boolean; maxRetries?: number; retryDelay?: number }) => {
    const recursive = typeof options === 'object' && options !== null && 'recursive' in options && options.recursive === true;
    if (recursive) {
      const { recursive: _recursive, ...rest } = options;
      fs.rmSync(path, { ...rest, recursive: true });
      return;
    }
    return originalRmdirSync(path, options);
  }) as typeof fsCompat.rmdirSync;

  ytsrCompatPatched = true;
}

async function loadYtsr(): Promise<YtsrSearch> {
  ensureYtsrNode25Compatibility();
  ytsrModulePromise ??= import('@distube/ytsr').then((module) => ((module as { default?: unknown }).default ?? module) as YtsrSearch);
  return ytsrModulePromise;
}

// Parse "3:45" or "1:02:30" duration string to milliseconds
function parseDuration(duration: string): number {
  const parts = duration.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  } else {
    seconds = parts[0] || 0;
  }
  return seconds * 1000;
}

function formatDuration(durationSec: number): string {
  const total = Math.max(0, Math.round(durationSec));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function mapYtDlpSearchEntries(entries: YtDlpSearchEntry[] | undefined, limit: number): SearchResult[] {
  return (entries ?? [])
    .filter((entry): entry is Required<Pick<YtDlpSearchEntry, 'id' | 'title'>> & YtDlpSearchEntry => Boolean(entry.id && entry.title))
    .slice(0, limit)
    .map((entry) => {
      const durationSec = entry.duration ?? 0;
      const url = entry.webpage_url ?? entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`;
      return {
        id: entry.id,
        title: entry.title,
        artist: entry.channel ?? entry.uploader ?? 'Unknown',
        duration: formatDuration(durationSec),
        durationMs: durationSec * 1000,
        thumbnail: entry.thumbnails?.[0]?.url ?? '',
        url,
      };
    });
}

export class YouTubeProvider {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    try {
      const ytsr = await loadYtsr();

      // Fetch extra results to account for non-video items filtered out
      const results = await ytsr(query, { limit: limit + 5, safeSearch: true });
      console.error('[youtube-provider] search complete', { query, total: results.items.length, source: 'ytsr' });

      return results.items
        .filter((item): item is Video => item.type === 'video')
        .slice(0, limit)
        .map(video => ({
          id: video.id,
          title: video.name,
          artist: video.author?.name ?? 'Unknown',
          duration: video.duration ?? '0:00',
          durationMs: video.duration ? parseDuration(video.duration) : 0,
          thumbnail: video.thumbnail ?? '',
          url: video.url,
        }));
    } catch (error) {
      const lastError = error as Error;
      console.error('[youtube-provider] ytsr search failed, falling back to yt-dlp', {
        query,
        message: lastError.message,
      });

      const result = await youtubeDl(`ytsearch${limit}:${query}`, {
        dumpSingleJson: true,
        flatPlaylist: true,
        noWarnings: true,
        callHome: false,
      }) as unknown as YtDlpSearchResult;

      const mapped = mapYtDlpSearchEntries(result.entries, limit);
      console.error('[youtube-provider] search complete', { query, total: mapped.length, source: 'yt-dlp' });
      return mapped;
    }
  }

  async getAudioUrl(videoIdOrUrl: string): Promise<AudioInfo> {
    if (!videoIdOrUrl.trim()) throw new Error('Video ID or URL is required');

    const url = videoIdOrUrl.startsWith('http')
      ? videoIdOrUrl
      : `https://www.youtube.com/watch?v=${videoIdOrUrl}`;

    let info: unknown;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        info = await youtubeDl(url, {
          dumpSingleJson: true,
          format: 'bestaudio[ext=m4a]/bestaudio',
          noWarnings: true,
          callHome: false,
        });
        break;
      } catch (error) {
        lastError = error as Error;
        console.error('[youtube-provider] audio extraction failed', { attempt, message: lastError.message });
      }
    }

    if (!info) {
      throw lastError ?? new Error('Could not extract audio stream URL');
    }

    // yt-dlp puts the selected format's URL at top level when format is specified,
    // but it may also be in the formats array — use top-level .url first
    const payload = info as Record<string, unknown>;
    const streamUrl = (payload.url as string)
      ?? ((payload.formats as Array<{ url: string }>) ?? []).at(-1)?.url;

    if (!streamUrl) throw new Error('Could not extract audio stream URL');

    console.error('[youtube-provider] audio extracted', { title: payload.title, duration: payload.duration });

    return {
      streamUrl,
      title: (payload.title as string) ?? 'Unknown',
      artist: (payload.uploader as string) ?? (payload.channel as string) ?? 'Unknown',
      duration: (payload.duration as number) ?? 0,
      thumbnail: (payload.thumbnail as string) ?? '',
    };
  }
}

// Singleton
let provider: YouTubeProvider | null = null;

export function createYoutubeProvider(): YouTubeProvider {
  if (!provider) {
    provider = new YouTubeProvider();
  }
  return provider;
}

export function getYoutubeProvider(): YouTubeProvider | null {
  return provider;
}
