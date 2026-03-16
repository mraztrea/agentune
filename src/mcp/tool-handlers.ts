// MCP tool handler functions — wired to MpvController for audio, stubs for search/queue (phases 4, 7)

import { getMpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import { getLastFmProvider } from '../providers/lastfm-provider.js';
import { scoreSearchResults } from '../providers/search-result-scorer.js';
import { getYoutubeProvider } from '../providers/youtube-provider.js';
import { CandidateGenerator, type MusicIntent } from '../taste/candidate-generator.js';
import { CandidateScorer, TEMPERATURE } from '../taste/candidate-scorer.js';
import { getTasteEngine } from '../taste/taste-engine.js';
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

async function playResolvedTrack(id: string, extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string }): Promise<{
  meta: {
    id: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
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

export async function handlePlaySong(args: { title: string; artist?: string }): Promise<ToolResult> {
  try {
    const yt = getYoutubeProvider();
    if (!yt) return errorResult('YouTube provider not initialized.');

    const { title, artist } = args;
    const MIN_SCORE = 0.2;

    // Build primary query: prefer "artist - title official audio" when artist given
    const primaryQuery = artist ? `${artist} - ${title} official audio` : `${title} official audio`;
    let results = await yt.search(primaryQuery, 10);
    let scored = scoreSearchResults(results, title, artist);

    // Fallback query if top score too low and artist was provided
    if ((scored.length === 0 || scored[0].score < MIN_SCORE) && artist) {
      const fallbackQuery = `${artist} ${title}`;
      results = await yt.search(fallbackQuery, 10);
      scored = scoreSearchResults(results, title, artist);
    }

    if (scored.length === 0 || scored[0].score < MIN_SCORE) {
      const label = artist ? `"${title}" by ${artist}` : `"${title}"`;
      return textResult({
        matched: false,
        message: `No good match found for ${label}. Top score: ${scored[0]?.score ?? 0}.`,
        alternatives: scored.slice(0, 3).map((s) => ({
          id: s.result.id,
          title: s.result.title,
          artist: s.result.artist,
          score: s.score,
          reasons: s.reasons,
        })),
      });
    }

    const best = scored[0];
    const { meta } = await playResolvedTrack(best.result.id, {
      canonicalArtist: artist,
      canonicalTitle: title,
    });

    return textResult({
      matched: true,
      nowPlaying: meta,
      matchScore: best.score,
      matchReasons: best.reasons,
      alternatives: scored.slice(1, 4).map((s) => ({
        id: s.result.id,
        title: s.result.title,
        artist: s.result.artist,
        score: s.score,
      })),
      message: `Now playing: ${meta.title} by ${meta.artist} (match score: ${best.score})`,
    });
  } catch (err) {
    return errorResult(`Play song failed: ${(err as Error).message}`);
  }
}

export async function handleDiscover(args: { mode?: string; intent?: MusicIntent }): Promise<ToolResult> {
  try {
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized.');
    const store = getHistoryStore();
    if (!store) return errorResult('History store not initialized.');

    const mode = (args.mode ?? 'balanced') as 'focus' | 'balanced' | 'explore';

    const lastFm = getLastFmProvider();
    const generator = new CandidateGenerator(lastFm, store, taste);
    const scorer = new CandidateScorer(taste, store);

    // Get current track for continuation lane
    const queueManager = getQueueManager();
    const nowPlaying = queueManager?.getNowPlaying() ?? null;
    const currentTrack = nowPlaying
      ? { artist: nowPlaying.artist, title: nowPlaying.title, duration: nowPlaying.duration }
      : null;

    const candidates = await generator.generate(currentTrack, args.intent, mode);
    if (candidates.length === 0) {
      return textResult({
        suggestions: [],
        message: 'No candidates found. Try playing a track first so discover has context to work with.',
      });
    }

    const scored = scorer.score(candidates, currentTrack, args.intent);
    const temperature = TEMPERATURE[mode];
    const suggestions = scorer.topKSample(scored, 5, temperature);

    const lane = taste.getSessionLane();

    return textResult({
      basedOn: currentTrack ? { title: currentTrack.title, artist: currentTrack.artist } : null,
      mode,
      suggestions: suggestions.map(s => ({
        title: s.title,
        artist: s.artist,
        score: s.score,
        source: s.source,
        reasons: s.reasons,
        hint: `play_song({ title: '${s.title.replace(/'/g, "\\'")}', artist: '${s.artist.replace(/'/g, "\\'")}' })`,
      })),
      lane: lane ? { description: lane.description, songCount: lane.songCount } : null,
      tip: 'Pick one and use play_song(). Call discover() again after a few tracks.',
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

export async function handleQueueAdd(args: { query?: string; id?: string }): Promise<ToolResult> {
  try {
    if (!args.query && !args.id) {
      return errorResult('Provide either a search query or a video ID.');
    }

    const queuePlaybackController = getQueuePlaybackController();
    if (!queuePlaybackController) return errorResult('Queue playback controller not initialized.');

    // Queue by video ID directly
    if (args.id) {
      const queueManager = getQueueManager();
      if (!queueManager) return errorResult('Queue manager not initialized.');

      const yt = getYoutubeProvider();
      if (!yt) return errorResult('YouTube provider not initialized.');

      const audio = await yt.getAudioUrl(args.id);
      const item = {
        id: args.id,
        title: audio.title,
        artist: audio.artist,
        duration: audio.duration,
        thumbnail: audio.thumbnail,
        url: `https://www.youtube.com/watch?v=${args.id}`,
      };
      const position = queueManager.add(item);
      return textResult({
        added: item,
        position,
        message: `Added ${item.title} by ${item.artist} to queue.`,
      });
    }

    // Queue by search query
    const { item, position } = await queuePlaybackController.queueByQuery(args.query!);
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

export async function handleGetSessionState(): Promise<ToolResult> {
  try {
    const taste = getTasteEngine();
    if (!taste) return errorResult('Taste engine not initialized. History store may be unavailable.');
    return textResult(taste.getSummary());
  } catch (err) {
    return errorResult(`Session state failed: ${(err as Error).message}`);
  }
}
