// MCP server setup — registers tools and handles agent communication via stdio

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleSearch,
  handlePlay,
  handlePlaySong,
  handleDiscover,
  handlePause,
  handleResume,
  handleSkip,
  handleQueueAdd,
  handleQueueList,
  handleNowPlaying,
  handleVolume,
  handleHistory,
  handleGetSessionState,
} from "./tool-handlers.js";

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "sbotify",
    version: "0.1.0",
  });

  // --- Tool Registrations ---

  server.tool(
    "search",
    "Search YouTube for music. Returns multiple results — pick the best match based on title/artist accuracy, prefer 'official audio' or 'topic' versions.",
    {
      query: z.string().describe("Search query for YouTube music"),
      limit: z.number().min(1).max(10).optional().default(10).describe("Max results to return (1-10)"),
    },
    async (args) => handleSearch(args),
  );

  server.tool(
    "play",
    "Play a specific track by its video ID",
    {
      id: z.string().describe("YouTube video ID to play"),
    },
    async (args) => handlePlay(args),
  );

  server.tool(
    "play_song",
    "Play a specific song by title and artist. Resolves to the best YouTube version automatically. " +
    "Always include artist for accuracy. " +
    "The resolver validates title/artist match and prefers official audio versions.",
    {
      title: z.string().min(1).describe("Song title"),
      artist: z.string().optional().describe("Artist name — strongly recommended for accuracy"),
    },
    async (args) => handlePlaySong(args),
  );

  server.tool(
    "discover",
    "Get intelligent song suggestions based on your taste and current session. " +
    "Call get_session_state() first to understand your taste, then optionally pass a music intent. " +
    "Returns scored candidates from 4 sources: continuation, comfort, context-fit, wildcard. " +
    "Pick from suggestions and use play_song() to play your choice.",
    {
      mode: z.enum(["focus", "balanced", "explore"]).optional().default("balanced")
        .describe("focus=predictable, balanced=default, explore=adventurous"),
      intent: z.object({
        energy: z.number().min(0).max(1).optional().describe("0=calm, 1=energetic"),
        valence: z.number().min(0).max(1).optional().describe("0=dark, 1=bright"),
        novelty: z.number().min(0).max(1).optional().describe("0=familiar, 1=new"),
        allowed_tags: z.array(z.string()).optional().describe("Tags to favor"),
        avoid_tags: z.array(z.string()).optional().describe("Tags to avoid"),
      }).optional().describe("Music intent — omit to auto-infer from taste state"),
    },
    async (args) => handleDiscover(args),
  );

  server.tool(
    "pause",
    "Pause the currently playing track",
    {},
    async () => handlePause(),
  );

  server.tool(
    "resume",
    "Resume playback of a paused track",
    {},
    async () => handleResume(),
  );

  server.tool(
    "skip",
    "Skip to the next track in the queue",
    {},
    async () => handleSkip(),
  );

  server.tool(
    "queue_add",
    "Add a track to the play queue. Provide either a search query or a video ID.",
    {
      query: z.string().optional().describe("Search query to find and queue a track"),
      id: z.string().optional().describe("YouTube video ID to queue directly"),
    },
    async (args) => handleQueueAdd(args),
  );

  server.tool(
    "queue_list",
    "List all tracks currently in the play queue",
    {},
    async () => handleQueueList(),
  );

  server.tool(
    "now_playing",
    "Get info about the currently playing track",
    {},
    async () => handleNowPlaying(),
  );

  server.tool(
    "volume",
    "Get or set the playback volume (0-100)",
    {
      level: z.number().min(0).max(100).optional().describe("Volume level 0-100. Omit to get current volume."),
    },
    async (args) => handleVolume(args),
  );

  server.tool(
    "history",
    "View your listening history. Shows recently played tracks with play counts and skip rates. Use this to understand listening patterns before choosing what to play next.",
    {
      limit: z.number().min(1).max(50).optional().default(20).describe("Max results to return (1-50)"),
      query: z.string().optional().describe("Filter by track title or artist name"),
    },
    async (args) => handleHistory(args),
  );

  server.tool(
    "get_session_state",
    "Read your current taste profile, persona, and session state. " +
    "Call this before deciding what to play next — it tells you what you're into, " +
    "what you're bored of, and what vibe the current session is in. " +
    "Use this context to inform your music intent when calling discover().",
    {},
    async () => handleGetSessionState(),
  );

  // --- Connect stdio transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sbotify] MCP server started on stdio");

  return server;
}
