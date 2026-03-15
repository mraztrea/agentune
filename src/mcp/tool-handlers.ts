// MCP tool handler functions — stub implementations, wired to real services in phases 3-4

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
    // TODO: Wire to MpvController + YouTubeProvider in phases 3-4
    return textResult({
      nowPlaying: { id: args.id, title: "Stub Track", artist: "Unknown", duration: 240 },
      message: "Playback started (stub). Wire MpvController for real audio.",
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
    // TODO: Wire to MpvController in Phase 3
    return textResult({ status: "paused", message: "Playback paused (stub)." });
  } catch (err) {
    return errorResult(`Pause failed: ${(err as Error).message}`);
  }
}

export async function handleResume(): Promise<ToolResult> {
  try {
    // TODO: Wire to MpvController in Phase 3
    return textResult({ status: "playing", message: "Playback resumed (stub)." });
  } catch (err) {
    return errorResult(`Resume failed: ${(err as Error).message}`);
  }
}

export async function handleSkip(): Promise<ToolResult> {
  try {
    // TODO: Wire to QueueManager + MpvController in phases 3, 7
    return textResult({ message: "Skipped to next track (stub). Queue is empty." });
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
    // TODO: Wire to MpvController + QueueManager in phases 3, 7
    return textResult({ nowPlaying: null, message: "Nothing is currently playing (stub)." });
  } catch (err) {
    return errorResult(`Now playing failed: ${(err as Error).message}`);
  }
}

export async function handleVolume(args: { level?: number }): Promise<ToolResult> {
  try {
    // TODO: Wire to MpvController in Phase 3
    if (args.level !== undefined) {
      return textResult({ volume: args.level, message: `Volume set to ${args.level}% (stub).` });
    }
    return textResult({ volume: 80, message: "Current volume: 80% (stub)." });
  } catch (err) {
    return errorResult(`Volume failed: ${(err as Error).message}`);
  }
}
