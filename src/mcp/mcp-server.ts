// MCP server setup — registers tools and handles agent communication via stdio

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleAddSong,
  handlePlaySong,
  handleDiscover,
  handlePause,
  handleResume,
  handleSkip,
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
    "play_song",
    "Play a specific song immediately using title and artist. " +
    "Apple Search API is used first to clean up the canonical song identity, then YouTube resolves a playable version. " +
    "This replaces the current song right away.",
    {
      title: z.string().min(1).describe("Song title"),
      artist: z.string().optional().describe("Artist name — strongly recommended for accuracy"),
    },
    async (args) => handlePlaySong(args),
  );

  server.tool(
    "add_song",
    "Add a specific song to the queue using title and artist. " +
    "Apple Search API is used first to clean up the canonical song identity, then YouTube is used only to resolve a playable version. " +
    "If nothing is currently playing, the queued song starts automatically.",
    {
      title: z.string().min(1).describe("Song title"),
      artist: z.string().optional().describe("Artist name — strongly recommended for accuracy"),
    },
    async (args) => handleAddSong(args),
  );

  server.tool(
    "discover",
    "Get intelligent song suggestions based on your taste and current session. " +
    "Call get_session_state() first to understand your taste, then optionally pass a music intent. " +
    "Returns scored candidates from 4 sources: continuation, comfort, context-fit, wildcard. " +
    "Pick from suggestions and use add_song() to queue one, or play_song() to replace the current track.",
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
    "queue_list",
    "List all tracks currently in the play queue and the current now-playing track",
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
