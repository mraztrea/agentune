// MCP server setup — registers tools and handles agent communication via stdio or HTTP

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "crypto";
import { type IncomingMessage, type ServerResponse } from "http";
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
  handleUpdatePersona,
} from "./tool-handlers.js";

/** Register all MCP tools onto a server instance */
export function registerMcpTools(server: McpServer): void {
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
    "Get song suggestions from the current listener state. " +
    "Start with page=1 for a new search. Prefer a specific artist when the user names one. " +
    "Use short, concrete keywords instead of long natural-language prompts. " +
    "When the response includes nextGuide telling you to change page, keep the same input and increment page. " +
    "When nextGuide tells you to improve input, change artist or keywords. " +
    "Deprecated mode and intent inputs are ignored.",
    {
      page: z.number().int().min(1).optional().default(1)
        .describe("Page number for the current discover snapshot. Use page=1 for a new search."),
      limit: z.number().int().min(1).max(50).optional().default(10)
        .describe("Results per page (default 10, max 50)"),
      artist: z.string().max(200).optional()
        .describe("Best seed when the user names a specific artist."),
      keywords: z.array(z.string().max(100)).max(10).optional()
        .describe("Short seed keywords for style, genre, mood, or language hints (max 10)."),
      mode: z.string().optional().describe("Deprecated — ignored."),
      intent: z.unknown().optional().describe("Deprecated — ignored."),
    },
    async (args) => handleDiscover(args),
  );

  server.tool("pause", "Pause the currently playing track", {}, async () => handlePause());
  server.tool("resume", "Resume playback of a paused track", {}, async () => handleResume());
  server.tool("skip", "Skip to the next track in the queue", {}, async () => handleSkip());

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
    "Read the current listener state before choosing music. " +
    "Use this as the source of truth for agent decisions. " +
    "Returns time context, persona.Preferences, recent plays, top artists, and top keywords. " +
    "Read these fields first, then choose a specific artist or concrete keywords for discover(). " +
    "Do not infer hidden preferences beyond the returned state.",
    {},
    async () => handleGetSessionState(),
  );

  server.tool(
    "update_persona",
    "Update the listener's music taste description only. Call this when the user explicitly mentions " +
    "a music preference, or when you want to record taste insights learned from listening patterns. " +
    "The taste text is free-form natural language describing what genres, artists, moods, and " +
    "styles the listener prefers. This persists across sessions.",
    {
      taste: z.string().max(1000).describe(
        "Free text taste description, e.g. 'Likes ambient, piano, post-rock. Evenings prefer acoustic.'. Use an empty string to clear it."
      ),
    },
    async (args) => handleUpdatePersona(args),
  );
}

/** Create MCP server with stdio transport (legacy/direct mode) */
export async function createStdioMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: "sbotify", version: "0.1.0" });
  registerMcpTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sbotify] MCP server started on stdio");
  return server;
}

// --- HTTP MCP handler ---

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((msg) => (msg as Record<string, unknown>)?.method === 'initialize');
  }
  return (body as Record<string, unknown>)?.method === 'initialize';
}

/** Create an HTTP MCP handler for daemon mode — manages per-session transports */
export function createHttpMcpHandler(): {
  handleRequest: (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>;
  close: () => Promise<void>;
} {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  return {
    async handleRequest(req, res, body) {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST' && !sessionId && isInitializeRequest(body)) {
        // New session — create transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, transport);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };
        try {
          const server = new McpServer({ name: 'sbotify', version: '0.1.0' });
          registerMcpTools(server);
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch (err) {
          await transport.close().catch(() => {});
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create session' }));
          }
        }
      } else if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.handleRequest(req, res, body);
      } else if (req.method === 'POST' && sessionId && !sessions.has(sessionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired session' }));
      } else if (req.method === 'POST') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing session ID or initialize request' }));
      } else {
        res.writeHead(405);
        res.end('Method Not Allowed');
      }
    },
    async close() {
      for (const [sid, transport] of sessions) {
        await transport.close();
        sessions.delete(sid);
      }
    },
  };
}
