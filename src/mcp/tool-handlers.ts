// MCP tool handler functions — wired to MpvController for audio, stubs for search/queue (phases 4, 7)

import { getMpvController } from '../audio/mpv-controller.js';

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

function textResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export async function handleSearch(args: { query: string; limit: number }): Promise<ToolResult> {
  try {
    // TODO: Wire to YouTubeProvider in Phase 4
    return textResult({
      results: [
        { title: `"${args.query}" - Top Result`, artist: "Unknown", id: "stub-1", duration: 210 },
      ],
      message: `Found results for "${args.query}" (limit: ${args.limit}). Wire YouTubeProvider to get real results.`,
    });
  } catch (err) {
    return errorResult(`Search failed: ${(err as Error).message}`);
  }
}

export async function handlePlay(args: { id: string }): Promise<ToolResult> {
  try {
    // TODO: Wire to YouTubeProvider for URL extraction in Phase 4
    // For now, id is treated as a direct URL if it starts with http
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');

    const isUrl = args.id.startsWith('http');
    if (!isUrl) {
      return textResult({
        nowPlaying: { id: args.id, title: "Stub Track", artist: "Unknown", duration: 240 },
        message: "Play by video ID requires YouTubeProvider (Phase 4). Pass a direct URL to test audio.",
      });
    }

    const meta = { id: args.id, title: "Direct URL", artist: "Unknown" };
    await mpv.play(args.id, meta);
    return textResult({
      nowPlaying: meta,
      message: "Playback started.",
    });
  } catch (err) {
    return errorResult(`Play failed: ${(err as Error).message}`);
  }
}

export async function handlePlayMood(args: { mood: "focus" | "energetic" | "chill" | "debug" | "ship" }): Promise<ToolResult> {
  try {
    // TODO: Wire to MoodPresets + YouTubeProvider in Phase 6
    return textResult({
      mood: args.mood,
      nowPlaying: { title: `${args.mood} vibes`, artist: "Auto DJ", id: "stub-mood", duration: 200 },
      message: `Playing ${args.mood} mood (stub). Wire MoodPresets for curated queries.`,
    });
  } catch (err) {
    return errorResult(`Play mood failed: ${(err as Error).message}`);
  }
}

export async function handlePause(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');
    await mpv.pause();
    return textResult({ status: "paused", message: "Playback paused." });
  } catch (err) {
    return errorResult(`Pause failed: ${(err as Error).message}`);
  }
}

export async function handleResume(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');
    await mpv.resume();
    return textResult({ status: "playing", message: "Playback resumed." });
  } catch (err) {
    return errorResult(`Resume failed: ${(err as Error).message}`);
  }
}

export async function handleSkip(): Promise<ToolResult> {
  try {
    // TODO: Wire to QueueManager in Phase 7
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');
    await mpv.stop();
    return textResult({ message: "Skipped current track. Queue not yet implemented (Phase 7)." });
  } catch (err) {
    return errorResult(`Skip failed: ${(err as Error).message}`);
  }
}

export async function handleQueueAdd(args: { query: string }): Promise<ToolResult> {
  try {
    // TODO: Wire to QueueManager + YouTubeProvider in phases 4, 7
    return textResult({
      added: { title: `"${args.query}"`, artist: "Unknown", id: "stub-q1", duration: 195 },
      position: 1,
      message: `Added "${args.query}" to queue (stub).`,
    });
  } catch (err) {
    return errorResult(`Queue add failed: ${(err as Error).message}`);
  }
}

export async function handleQueueList(): Promise<ToolResult> {
  try {
    // TODO: Wire to QueueManager in Phase 7
    return textResult({ queue: [], message: "Queue is empty (stub)." });
  } catch (err) {
    return errorResult(`Queue list failed: ${(err as Error).message}`);
  }
}

export async function handleNowPlaying(): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');

    const track = await mpv.getCurrentTrack();
    if (!track) {
      return textResult({ nowPlaying: null, message: "Nothing is currently playing." });
    }

    const position = await mpv.getPosition();
    const duration = await mpv.getDuration();
    const isPlaying = await mpv.getIsPlaying();
    const volume = await mpv.getVolume();

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

export async function handleVolume(args: { level?: number }): Promise<ToolResult> {
  try {
    const mpv = getMpvController();
    if (!mpv || !mpv.isReady()) return errorResult('Audio engine not initialized. Is mpv installed?');

    if (args.level !== undefined) {
      const actual = await mpv.setVolume(args.level);
      return textResult({ volume: actual, message: `Volume set to ${actual}%.` });
    }
    const current = await mpv.getVolume();
    return textResult({ volume: current, message: `Current volume: ${current}%.` });
  } catch (err) {
    return errorResult(`Volume failed: ${(err as Error).message}`);
  }
}
