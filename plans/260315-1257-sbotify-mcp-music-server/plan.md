---
name: sbotify MCP Music Server
status: in-progress
created: 2026-03-15
phases: 7
blockedBy: []
blocks: []
---

# sbotify — MCP Music Server Implementation Plan

## Overview
Build an MCP server that lets coding agents (Claude Code, Cursor, Codex) play music as a DJ. Agent controls playback (search, play, skip, mood); user has a browser dashboard for volume + now-playing display. Audio via mpv headless, YouTube as MVP source.

## Architecture
```
Agent (Claude Code/Cursor)
    │ MCP Protocol (stdio)
    ▼
sbotify MCP Server (TypeScript, Node.js)
    ├── YouTube Search (@distube/ytsr)
    ├── Audio extraction (youtube-dl-exec → yt-dlp)
    ├── mpv headless (audio playback via JSON IPC)
    └── HTTP + WebSocket (localhost:3737)
          └── Browser dashboard (volume + now-playing)
```

## Tech Stack
- **Runtime**: Node.js 20+, TypeScript 5+
- **MCP**: `@modelcontextprotocol/sdk` v1.x + `zod` v4
- **Search**: `@distube/ytsr`
- **Audio extraction**: `youtube-dl-exec` (auto-installs yt-dlp)
- **Playback**: `node-mpv` (wraps mpv JSON IPC)
- **Web**: `ws` (WebSocket) + Node.js built-in `http` (static serving)
- **System deps**: mpv, yt-dlp (installed by youtube-dl-exec)

## Key Research Insights
- MCP SDK: Use `server.tool()` with Zod schemas. **Never `console.log()`** — corrupts stdio protocol. Use `console.error()` for debug.
- mpv IPC: Windows uses named pipes (`\\.\pipe\sbotify`), Unix uses sockets (`/tmp/sbotify-mpv`). Node.js `net.Socket` handles both.
- YouTube search: `@distube/ytsr` is actively maintained, no API key needed. YouTube stream URLs expire after ~6 hours.
- Return `isError: true` in tool results instead of throwing errors.

## Phases

| # | Phase | Status | Priority | Effort |
|---|-------|--------|----------|--------|
| 1 | [Project Setup](phase-01-project-setup.md) | complete | P0 | S |
| 2 | [MCP Server + Tool Definitions](phase-02-mcp-server-tools.md) | complete | P0 | M |
| 3 | [Audio Engine (mpv)](phase-03-audio-engine-mpv.md) | complete | P0 | M |
| 4 | [YouTube Provider](phase-04-youtube-provider.md) | complete | P0 | M |
| 5 | [Browser Dashboard](phase-05-browser-dashboard.md) | complete | P1 | M |
| 6 | [Mood Mode](phase-06-mood-mode.md) | complete | P1 | S |
| 7 | [Queue + Polish + Publish](phase-07-queue-polish-publish.md) | complete | P1 | M |

## Dependencies
```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5
                                  ↓
                              Phase 6
                              Phase 7
```
Phases 5, 6, 7 can run in parallel after Phase 4.

## Reports
- [Brainstorm](../reports/brainstorm-260315-1156-sbotify-music-mcp-server.md)
- [Market Research](../reports/researcher-260315-1218-existing-music-agent-tools.md)
- [MCP SDK Research](../reports/researcher-260315-1257-mcp-sdk-typescript.md)
- [mpv IPC Research](../reports/researcher-260315-1257-mpv-ipc-nodejs.md)
- [YouTube Search Research](../reports/researcher-260315-1257-youtube-search-nodejs.md)

## Success Criteria
- Agent can search, play, skip, queue songs without human intervention
- Browser dashboard shows now-playing + volume slider
- Audio plays independently of browser tab (mpv headless)
- < 3 seconds from agent "play" command to audio output
- Works on Windows, macOS, Linux
- Installable via `npm install -g sbotify`
