// MCP tool handler functions — wired to MpvController for audio, stubs for search/queue (phases 4, 7)

import { getMpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import { getAppleSearchProvider } from '../providers/apple-search-provider.js';
import { getYoutubeProvider } from '../providers/youtube-provider.js';
import { resolveSong } from './song-resolver.js';
import { getTasteEngine } from '../taste/taste-engine.js';
import { DiscoverBatchBuilder } from '../taste/discover-batch-builder.js';
import { createDiscoverPipeline, getDiscoverPipeline } from '../taste/discover-pipeline.js';
import { invalidateDiscoverCache } from '../taste/discover-pagination-cache.js';
import { getQueuePlaybackController } from '../queue/queue-playback-controller.js';
import { getQueueManager } from '../queue/queue-manager.js';
import { getWebServer } from '../web/web-server.js';

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handlePlaySong(args: { title: string; artist?: string }): Promise<ToolResult> {
  try {
    const yt = getYoutubeProvider();
    if (!yt) return errorResult('YouTube provider not initialized.');
    const apple = getAppleSearchProvider();
    const queuePlaybackController = getQueuePlaybackController();
    if (!queuePlaybackController) return errorResult('Queue playback controller not initialized.');

    const resolved = await resolveSong(yt, apple, args);
    if (!resolved.matched || !resolved.result) {
      const label = args.artist ? `"${args.title}" by ${args.artist}` : `"${args.title}"`;
      return textResult({
        matched: false,
        canonical: {
          title: resolved.canonicalTitle,
          artist: resolved.canonicalArtist,
          source: resolved.canonicalSource,
        },
        message: `No good match found for ${label}. Top score: ${resolved.matchScore}.`,
        alternatives: resolved.alternatives,
      });
    }

    const nowPlaying = await queuePlaybackController.replaceCurrentTrack(resolved.result.id, {
      canonicalArtist: resolved.canonicalArtist,
      canonicalTitle: resolved.canonicalTitle,
    });
    invalidateDiscoverCache();

    return textResult({
      matched: true,
      action: 'replaced_current',
      nowPlaying,
      canonical: {
        title: resolved.canonicalTitle,
        artist: resolved.canonicalArtist,
        source: resolved.canonicalSource,
      },
      matchScore: resolved.matchScore,
      matchReasons: resolved.matchReasons,
      alternatives: resolved.alternatives,
      message: `Now playing: ${nowPlaying.title} by ${nowPlaying.artist} (match score: ${resolved.matchScore})`,
    });
  } catch (err) {
    return errorResult(`Play song failed: ${(err as Error).message}`);
  }
}

export async function handleAddSong(args: { title: string; artist?: string }): Promise<ToolResult> {
  try {
    const yt = getYoutubeProvider();
    if (!yt) return errorResult('YouTube provider not initialized.');
    const apple = getAppleSearchProvider();
    const queuePlaybackController = getQueuePlaybackController();
    if (!queuePlaybackController) return errorResult('Queue playback controller not initialized.');

    const resolved = await resolveSong(yt, apple, args);
    if (!resolved.matched || !resolved.result) {
      const label = args.artist ? `"${args.title}" by ${args.artist}` : `"${args.title}"`;
      return textResult({
        matched: false,
        canonical: {
          title: resolved.canonicalTitle,
          artist: resolved.canonicalArtist,
          source: resolved.canonicalSource,
        },
        message: `No good match found for ${label}. Top score: ${resolved.matchScore}.`,
        alternatives: resolved.alternatives,
      });
    }

    const addResult = await queuePlaybackController.addById(resolved.result.id, {
      canonicalArtist: resolved.canonicalArtist,
      canonicalTitle: resolved.canonicalTitle,
    });
    const queueManager = getQueueManager();
    const nowPlaying = queueManager?.getNowPlaying() ?? null;
    invalidateDiscoverCache();

    return textResult({
      matched: true,
      action: addResult.action,
      nowPlaying,
      added: addResult.item,
      queuePosition: addResult.position,
      startedPlayback: addResult.startedPlayback,
      canonical: {
        title: resolved.canonicalTitle,
        artist: resolved.canonicalArtist,
        source: resolved.canonicalSource,
      },
      matchScore: resolved.matchScore,
      matchReasons: resolved.matchReasons,
      alternatives: resolved.alternatives,
      message: addResult.startedPlayback
        ? `Added ${addResult.item.title} by ${addResult.item.artist} to queue at position ${addResult.position} and started playback because the queue was idle.`
        : `Added ${addResult.item.title} by ${addResult.item.artist} to queue at position ${addResult.position}.`,
    });
  } catch (err) {
    return errorResult(`Add song failed: ${(err as Error).message}`);
  }
}

export async function handleDiscover(args: {
  page?: number;
  limit?: number;
  artist?: string;
  genres?: string[];
  mode?: unknown;
  intent?: unknown;
}): Promise<ToolResult> {
  try {
    const store = getHistoryStore();
    if (!store) return errorResult('History store not initialized.');
    const apple = getAppleSearchProvider();
    if (!apple) return errorResult('Apple provider not initialized.');
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized.');

    const pipeline = getDiscoverPipeline() ?? createDiscoverPipeline(
      new DiscoverBatchBuilder(apple, store),
      store,
      taste,
    );
    const result = await pipeline.discover(args);
    const { emptyReason, ...response } = result;

    if (response.candidates.length === 0) {
      return textResult({
        ...response,
        message: emptyReason === 'page_exhausted'
          ? 'No more discover candidates in this snapshot. Change artist/genres or go back to page=1.'
          : 'No discover candidates found yet. Play more music first, or pass artist/genres seeds.',
      });
    }

    return textResult({
      ...response,
      tip: response.hasMore
        ? 'Use add_song() or play_song() to pick, then call discover(page=2) for more candidates.'
        : 'Use add_song() or play_song() to pick from these candidates.',
    });
  } catch (err) {
    return errorResult(`Discover failed: ${(err as Error).message}`);
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

export async function handleGetSessionState(): Promise<ToolResult> {
  try {
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized. History store may be unavailable.');
    return textResult(taste.getSummary());
  } catch (err) {
    return errorResult(`Session state failed: ${(err as Error).message}`);
  }
}

export async function handleUpdatePersona(args: { taste: string }): Promise<ToolResult> {
  try {
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized.');

    const text = args.taste.slice(0, 1000);
    taste.saveTasteText(text);
    getWebServer()?.broadcastPersona();

    return textResult({
      updated: true,
      persona: taste.getPersona(),
      message: 'Persona taste updated.',
    });
  } catch (err) {
    return errorResult(`Update persona failed: ${(err as Error).message}`);
  }
}

export async function handleSetPersonaTraits(args: {
  exploration: number;
  variety: number;
  loyalty: number;
}): Promise<ToolResult> {
  try {
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized.');

    const traits = taste.saveTraits(args);
    invalidateDiscoverCache();
    getWebServer()?.broadcastPersona();

    return textResult({
      updated: true,
      persona: {
        traits,
        taste: taste.getTasteText(),
      },
      message: 'Manual persona traits updated.',
    });
  } catch (err) {
    return errorResult(`Set persona traits failed: ${(err as Error).message}`);
  }
}
