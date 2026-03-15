// MCP server setup — registers tools and handles agent communication via stdio

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MOOD_VALUES } from "../mood/mood-presets.js";
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
  handleHistory,
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
      mood: z.string().min(1).describe(`Mood preset: ${MOOD_VALUES.join(', ')}`),
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

  server.tool(
    "history",
    "View your listening history. Shows recently played tracks with play counts and skip rates. Use this to understand listening patterns before choosing what to play next.",
    {
      limit: z.number().min(1).max(50).optional().default(20).describe("Max results to return (1-50)"),
      query: z.string().optional().describe("Filter by track title or artist name"),
    },
    async (args) => handleHistory(args),
  );

  // --- Connect stdio transport ---
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sbotify] MCP server started on stdio");

  return server;
}
