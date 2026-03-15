// YouTube search + audio URL extraction via @distube/ytsr and yt-dlp

import ytsr, { Video } from '@distube/ytsr';
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

export class YouTubeProvider {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    if (!query.trim()) return [];

    // Fetch extra results to account for non-video items filtered out
    const results = await ytsr(query, { limit: limit + 5, safeSearch: true });
    console.error('[youtube-provider] search complete', { query, total: results.items.length });

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
