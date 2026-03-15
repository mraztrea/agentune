// MCP server setup — registers tools and handles agent communication via stdio

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  handleSearch,
  handlePlay,
  handlePlayMood,
  handlePause,
  handleResume,
  handleSkip,
  handleQueueAdd,
  handleQueueList,
  handleNowPlaying,
  handleVolume,
} from "./tool-handlers.js";

export const MOOD_VALUES = ["focus", "energetic", "chill", "debug", "ship"] as const;
export type Mood = (typeof MOOD_VALUES)[number];

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "sbotify",
    version: "0.1.0",
  });

  // --- Tool Registrations ---

  server.tool(
    "search",
    "Search YouTube for music tracks",
    {
      query: z.string().describe("Search query for YouTube music"),
      limit: z.number().min(1).max(10).optional().default(5).describe("Max results to return (1-10)"),
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
    "play_mood",
    "Play music matching a mood preset",
    {
      mood: z.enum(MOOD_VALUES).describe("Mood preset: focus, energetic, chill, debug, or ship"),
    },
    async (args) => handlePlayMood(args),
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
    "Search for a track and add it to the play queue",
    {
      query: z.string().describe("Search query to find and queue a track"),
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

  // --- Connect stdio transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sbotify] MCP server started on stdio");

  return server;
}
