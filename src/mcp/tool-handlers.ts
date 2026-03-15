// MCP tool handler functions — wired to MpvController for audio, stubs for search/queue (phases 4, 7)

import { getMpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import type { Mood } from '../mood/mood-presets.js';
import { getRandomMoodQuery, getMoodQueries, MOOD_VALUES, normalizeMood } from '../mood/mood-presets.js';
import { getYoutubeProvider } from '../providers/youtube-provider.js';
import { getQueuePlaybackController } from '../queue/queue-playback-controller.js';
import { getQueueManager } from '../queue/queue-manager.js';

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function playResolvedTrack(id: string, extraMeta?: { mood?: Mood }): Promise<{
  meta: {
    id: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
    mood?: Mood;
  };
}> {
  const queuePlaybackController = getQueuePlaybackController();
  if (!queuePlaybackController) {
    throw new Error('Queue playback controller not initialized.');
  }

  const mpv = getMpvController();
  if (!mpv || !mpv.isReady()) {
    throw new Error('Audio engine not initialized. Is mpv installed?');
  }
  const meta = await queuePlaybackController.playById(id, extraMeta);
  return { meta };
}

export async function handleSearch(args: { query: string; limit: number }): Promise<ToolResult> {
  try {
    const yt = getYoutubeProvider();
    if (!yt) return errorResult('YouTube provider not initialized.');

    const results = await yt.search(args.query, args.limit);
    if (results.length === 0) {
      return textResult({ results: [], message: `No results found for "${args.query}".` });
    }

    return textResult({
      results: results.map(r => ({
        id: r.id,
        title: r.title,
        artist: r.artist,
        duration: r.duration,
        thumbnail: r.thumbnail,
        url: r.url,
      })),
      message: `Found ${results.length} result(s) for "${args.query}".`,
    });
  } catch (err) {
    return errorResult(`Search failed: ${(err as Error).message}`);
  }
}

export async function handlePlay(args: { id: string }): Promise<ToolResult> {
  try {
    const { meta } = await playResolvedTrack(args.id);

    return textResult({
      nowPlaying: meta,
      message: `Now playing: ${meta.title} by ${meta.artist}`,
    });
  } catch (err) {
    return errorResult(`Play failed: ${(err as Error).message}`);
  }
}

export async function handlePlayMood(args: { mood: string }): Promise<ToolResult> {
  try {
    const mood = normalizeMood(args.mood);
    if (!mood) {
      return errorResult(`Unknown mood "${args.mood}". Available moods: ${MOOD_VALUES.join(', ')}.`);
    }

    const yt = getYoutubeProvider();
    if (!yt) return errorResult('YouTube provider not initialized.');

    const query = getRandomMoodQuery(mood);
    const results = await yt.search(query, 1);
    if (results.length === 0) {
      return errorResult(`No results found for mood "${mood}" using query "${query}".`);
    }

    const topResult = results[0];
    const { meta } = await playResolvedTrack(topResult.id, { mood });

    return textResult({
      mood,
      query,
      availableQueries: getMoodQueries(mood),
      nowPlaying: meta,
      message: `Playing ${meta.title} for ${mood} mood.`,
    });
  } catch (err) {
    return errorResult(`Play mood failed: ${(err as Error).message}`);
  }
}

export async function handlePause(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');
    mpv.pause();
    return textResult({ status: "paused", message: "Playback paused." });
  } catch (err) {
    return errorResult(`Pause failed: ${(err as Error).message}`);
  }
}

export async function handleResume(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');
    mpv.resume();
    return textResult({ status: "playing", message: "Playback resumed." });
  } catch (err) {
    return errorResult(`Resume failed: ${(err as Error).message}`);
  }
}

export async function handleSkip(): Promise<ToolResult> {
  try {
    const queuePlaybackController = getQueuePlaybackController();
    if (!queuePlaybackController) return errorResult('Queue playback controller not initialized.');

    const nextTrack = await queuePlaybackController.skip();
    if (!nextTrack) {
      return textResult({ nowPlaying: null, message: 'Skipped current track. Queue is now empty.' });
    }

    return textResult({
      nowPlaying: nextTrack,
      message: `Skipped to ${nextTrack.title} by ${nextTrack.artist}.`,
    });
  } catch (err) {
    return errorResult(`Skip failed: ${(err as Error).message}`);
  }
}

export async function handleQueueAdd(args: { query: string }): Promise<ToolResult> {
  try {
    const queuePlaybackController = getQueuePlaybackController();
    if (!queuePlaybackController) return errorResult('Queue playback controller not initialized.');

    const { item, position } = await queuePlaybackController.queueByQuery(args.query);
    return textResult({
      added: item,
      position,
      message: `Added ${item.title} by ${item.artist} to queue.`,
    });
  } catch (err) {
    return errorResult(`Queue add failed: ${(err as Error).message}`);
  }
}

export async function handleQueueList(): Promise<ToolResult> {
  try {
    const queueManager = getQueueManager();
    if (!queueManager) return errorResult('Queue manager not initialized.');

    const state = queueManager.getState();
    return textResult({
      nowPlaying: state.nowPlaying,
      queue: state.queue,
      history: state.history,
      message: state.queue.length === 0 ? 'Queue is empty.' : `Queue has ${state.queue.length} track(s).`,
    });
  } catch (err) {
    return errorResult(`Queue list failed: ${(err as Error).message}`);
  }
}

export async function handleNowPlaying(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');

    const track = mpv.getCurrentTrack();
    if (!track) {
      return textResult({ nowPlaying: null, message: "Nothing is currently playing." });
    }

    const position = await mpv.getPosition();
    const duration = await mpv.getDuration();
    const isPlaying = mpv.getIsPlaying();
    const volume = mpv.getVolume();

    return textResult({
      nowPlaying: {
        ...track,
        position: Math.round(position),
        duration: Math.round(duration),
        isPlaying,
        volume,
      },
    });
  } catch (err) {
    return errorResult(`Now playing failed: ${(err as Error).message}`);
  }
}

export async function handleHistory(args: { limit: number; query?: string }): Promise<ToolResult> {
  try {
    const store = getHistoryStore();
    if (!store) return errorResult('History store not initialized.');

    const plays = store.getRecent(args.limit, args.query);
    if (plays.length === 0) {
      return textResult({
        history: [],
        message: args.query
          ? `No history found matching "${args.query}".`
          : 'No listening history yet. Play some tracks first!',
      });
    }

    const history = plays.map((p) => ({
      title: p.title,
      artist: p.artist,
      playedAt: new Date(p.started_at).toISOString(),
      playedSec: p.played_sec,
      skipped: p.skipped === 1,
      playCount: p.play_count,
      ytVideoId: p.yt_video_id,
    }));

    return textResult({
      history,
      total: history.length,
      message: `Showing ${history.length} recent play(s).`,
    });
  } catch (err) {
    return errorResult(`History failed: ${(err as Error).message}`);
  }
}

export async function handleVolume(args: { level?: number }): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');

    if (args.level !== undefined) {
      const actual = mpv.setVolume(args.level);
      return textResult({ volume: actual, message: `Volume set to ${actual}%.` });
    }
    const current = mpv.getVolume();
    return textResult({ volume: current, message: `Current volume: ${current}%.` });
  } catch (err) {
    return errorResult(`Volume failed: ${(err as Error).message}`);
  }
}
