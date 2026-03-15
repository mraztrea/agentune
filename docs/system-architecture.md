# System Architecture

## High-Level Overview

sbotify is a three-tier system:
1. **Agent Layer** (Claude Code/Cursor) — Sends commands via MCP protocol
2. **Server Layer** (Node.js) — Orchestrates all components
3. **Output Layer** (Audio + Dashboard) — Delivers music + visualization

```
┌──────────────────────────────────────┐
│   Coding Agent (Claude Code/Cursor)  │
│         [write code]                 │
└────────────────┬─────────────────────┘
                 │ MCP Protocol (stdio)
                 ▼
┌──────────────────────────────────────────────────────────┐
│           sbotify MCP Server (Node.js 20+)               │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │  MCP Server (Phase 2)                            │  │
│  │  ├─ Tool Definitions (search, play, skip, ...)  │  │
│  │  └─ stdio Transport (agent ↔ server)            │  │
│  └──────────────────────────────────────────────────┘  │
│          │               │              │               │
│          ▼               ▼              ▼               │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────┐    │
│  │  YouTube    │ │ Queue       │ │ Mood         │    │
│  │  Provider   │ │ Manager     │ │ Presets      │    │
│  │ (Phase 4)   │ │ (Phase 7)   │ │ (Phase 6)    │    │
│  └─────────────┘ └─────────────┘ └──────────────┘    │
│          │               │                              │
│          └───────┬───────┘                              │
│                  ▼                                      │
│  ┌──────────────────────────┐                         │
│  │ mpv Controller (Phase 3) │                         │
│  │ ├─ JSON IPC Protocol     │                         │
│  │ └─ Playback Control      │                         │
│  └──────────────────────────┘                         │
│          │                                             │
│          └──────────────┬──────────────┐              │
│                         │              │              │
└─────────────────────────┼──────────────┼──────────────┘
                          │              │
        ┌─────────────────┘              └────────────────┐
        ▼                                                 ▼
   ┌─────────┐                                    ┌─────────────────┐
   │   mpv   │                                    │  Web Server     │
   │ (audio) │                                    │ (Phase 5)       │
   └─────────┘                                    │                 │
                                                  │ HTTP + WebSocket│
                                                  │ WS (/ws)        │
                                                  │ Static files    │
                                                  └────────┬────────┘
                                                           │
                                                           ▼
                                                    ┌──────────────┐
                                                    │   Browser    │
                                                    │  Dashboard   │
                                                    │   (Phase 5)  │
                                                    └──────────────┘
```

## Component Details

### 1. MCP Server (Phase 2)

**Purpose**: Expose sbotify capabilities as MCP tools for agent invocation.

**Implementation**:
- Initialize `McpServer` from `@modelcontextprotocol/sdk`
- Register tool definitions with Zod schemas
- Handle stdio transport (agent sends JSON → server responds JSON)

**Tools**:
```
Tool: search
  Input: {query: string}
  Output: {isError: boolean, results: SearchResult[]}

Tool: play
  Input: {videoId: string}
  Output: {isError: boolean, nowPlaying: Track}

Tool: skip
  Input: {}
  Output: {isError: boolean, nowPlaying: Track}

Tool: queue_add
  Input: {query: string}
  Output: {isError: boolean, added: Track, position: number}

Tool: queue_list
  Input: {}
  Output: {isError: boolean, nowPlaying: Track | null, queue: Track[], history: Track[]}

Tool: play_mood
  Input: {mood: string}
  Output: {isError: boolean, nowPlaying: Track}
```

**Transport**: stdio (STDIN for input, STDOUT for MCP responses, STDERR for debug logs)

**Error Handling**: All tool results include `isError` flag; never throw.

### 2. YouTube Provider (Phase 4)

**Purpose**: Search YouTube and extract playable stream URLs.

**Dependencies**:
- `@distube/ytsr` — Video metadata search (no API key required)
- `youtube-dl-exec` — Calls yt-dlp binary to extract stream URLs

**Data Flow**:
```
1. search(query: string)
   ├─ @distube/ytsr.search(query)
   ├─ Return: [{videoId, title, duration, thumbnail}, ...]
   └─ Cached in memory (optional)

2. getStreamUrl(videoId: string)
   ├─ youtube-dl-exec fetch stream info
   ├─ Parse m3u8 or direct audio URL
   ├─ Cache for 5 hours (URLs expire)
   └─ Return: m3u8 URL (compatible with mpv)

3. parseMetadata(videoId: string)
   ├─ Extract title, artist (from channel), duration
   └─ Return: {title, artist, duration, thumbnail}
```

**Error Scenarios**:
- Search returns no results → `{isError: true, results: []}`
- Video unavailable → `{isError: true, message: "Video unavailable"}`
- yt-dlp fails → Return cached URL or skip

**Stream URL Cache**:
- TTL: 5 hours (YouTube URLs expire)
- Auto-refresh on 404 during playback
- Key: videoId, Value: {url, expiresAt}

### 3. mpv Controller (Phase 3) ✓ COMPLETE

**Purpose**: Spawn and control headless mpv process via node-mpv library.

**Architecture**:
- `MpvController` singleton class manages mpv lifecycle
- Uses `node-mpv` v1.5.0 for abstracted IPC communication (hides JSON protocol)
- `getIpcPath()` detects platform and returns correct socket/pipe path
- Type definitions (`node-mpv.d.ts`) for typesafe interaction

**IPC Details** (via node-mpv):

| OS | Socket Type | Path |
|----|-------------|------|
| Windows | Named Pipe | `\\.\pipe\sbotify-mpv` |
| macOS/Linux | Unix Socket | `/tmp/sbotify-mpv` |

**Public API**:
```typescript
MpvController.init()              // Start mpv process
MpvController.isReady()           // Check if initialized
MpvController.play(url, meta)     // Load and play
MpvController.pause()             // Pause playback
MpvController.resume()            // Resume playback
MpvController.stop()              // Stop playback
MpvController.setVolume(0-100)    // Set volume level
MpvController.getVolume()         // Read current volume
MpvController.toggleMute()        // Toggle mute state
MpvController.getIsMuted()        // Read mute state
MpvController.getPosition()       // Playback time (seconds)
MpvController.getDuration()       // Track duration
MpvController.getCurrentTrack()   // Track metadata
MpvController.getIsPlaying()      // Playback status
MpvController.getState()          // Snapshot state for dashboard
MpvController.destroy()           // Graceful shutdown
```

**Lifecycle**:
1. Server calls `createMpvController().init()` during bootstrap
2. Detects mpv binary via `which`/`where` (throws error if missing)
3. Cleans up stale Unix socket from previous crashes
4. Spawns mpv with `audio_only: true`, `idle: true`, `no-config` flags
5. Sets volume to 80 default
6. On shutdown, calls `destroy()` to quit mpv gracefully

**Error Handling**:
- mpv binary not found → Caught in index.ts, non-fatal (tools return errors)
- IPC communication failures → Propagated to tool handlers
- Graceful destroy even if already crashed

### 4. Queue Manager (Phase 7)

**Purpose**: Track playback state (now-playing, upcoming queue, history) and expose queue mutations to the rest of the app.

**State Structure**:
```typescript
{
  nowPlaying: Track | null,
  queue: Track[],          // Next to play
  history: Track[]         // Recently played (last 20)
}
```

**Operations**:
```
add(track)     → Push to queue
next()         → Pop queue[0]
setNowPlaying(track)
finishCurrentTrack() → Archive current track into history
clear()        → Empty queue
clearNowPlaying()
getState()     → Snapshot for MCP + dashboard
```

**Persistence**: Session-only (no disk storage in MVP)

**Broadcast**: On state change, notify WebSocket clients (dashboard)

### 4.5 Queue Playback Controller (Phase 7)

**Purpose**: Keep queue transitions correct across manual play, manual skip, and natural end-of-track events.

**Responsibilities**:
- Resolve audio info through the YouTube provider
- Set queue state before calling mpv playback
- Mark manual skip in-flight so mpv `stopped` does not double-advance
- Trigger dashboard auto-open once on first successful playback

### 5. Mood Presets (Phase 6)

**Purpose**: Map mood keywords to YouTube search queries.

**Mapping**:
Each supported mood has a curated pool of 5 queries:
- `focus`
- `energetic`
- `chill`
- `debug`
- `ship`

**Function**:
```typescript
normalizeMood(input: string): Mood | null
getMoodQueries(mood: Mood): string[]
getRandomMoodQuery(mood: Mood): string
```

**Integration**: Agent calls `play_mood("focus")` → normalize mood → pick random curated query → search YouTube → play first result → include `mood` in playback metadata for dashboard state.

### 6. Web Server (Phase 5) ✓ COMPLETE

**Purpose**: HTTP server for browser dashboard + WebSocket for real-time updates.

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| GET | / | Serve index.html |
| GET | /api/status | JSON: {playing, title, artist, thumbnail, position, duration, volume, muted, queue, mood} |
| POST | /api/volume | Set volume (body: {volume: 0-100}) |
| WS | /ws | Real-time push: state updates + volume/mute commands |

**HTTP Server**:
- Listen on localhost:3737, fall back through 3746 if busy
- Serve static files from `public/`
- Return `503` for volume updates when mpv is unavailable instead of crashing the request path

**WebSocket Server**:
- Broadcast playback updates on mpv state changes plus a 1-second position refresh
- Send: `{type: "state", data: {playing, title, artist, thumbnail, position, duration, volume, muted, queue, mood}}`
- Accept: `{type: "volume", level}` and `{type: "mute"}` from browser clients
- Push current state immediately on connect

**Dashboard Features**:
- Now-playing title, artist, album art
- Progress bar (display only)
- Volume slider (0-100)
- Mute toggle
- Queue preview reflects live queue manager state
- Mood badge reflects current track mood metadata when playback starts from `play_mood`
- Auto-refresh on data change
- Auto-opens in the default browser on first successful `play`

### Data Flow Example: "Play focus music"

```
1. Agent sends MCP tool call: {tool: "play_mood", input: {mood: "focus"}}
   └─ MCP Server receives on stdio

2. MCP Server invokes play_mood("focus")
   ├─ Mood Presets: getMoodQuery("focus") → "lofi hip hop beats to study to"
   └─ Invoke: search("lofi hip hop beats to study to")

3. YouTube Provider: search()
   ├─ @distube/ytsr fetches results
   ├─ Returns: [{videoId: "abc123", title: "Lofi Beats...", ...}]
   └─ MCP invokes: play("abc123")

4. MCP Server invokes play("abc123")
   ├─ YouTube Provider: getStreamUrl("abc123")
   │  └─ Returns m3u8 URL from cache or yt-dlp
   ├─ Queue Playback Controller sets Queue Manager nowPlaying state
   ├─ mpv Controller: playback (JSON IPC)
   │  └─ Send: {command: ["loadfile", "https://stream.m3u8"]}
   └─ Return: {isError: false, nowPlaying: {title: "Lofi Beats...", ...}}

5. MCP returns result to agent on stdout
   └─ Agent: "Playing Lofi Beats..."

6. mpv plays audio (headless, independent)

7. Web Server publishes status via WebSocket
   ├─ Browser receives: {type: "state", data: {...}}
   ├─ Dashboard updates:
   │  ├─ Title: "Lofi Beats..."
   │  ├─ Progress: 0:00
   │  └─ Queue: live upcoming tracks
   └─ User sees now-playing info in real-time
```

## Concurrency Model

### Parallel Operations
- **Search + Metadata**: Fetch results and metadata in parallel
- **WebSocket Broadcast**: Non-blocking to all clients
- **IPC Commands**: Queue commands; process sequentially

### Thread Safety
- Single-threaded Node.js; async/await handles concurrency
- Use Promises, not callback hell
- Queue mutations stay centralized in QueueManager + QueuePlaybackController to avoid drift between MCP handlers and WebSocket state

## Deployment Architecture

```
┌─────────────────────────────┐
│   npm install -g sbotify    │
└──────────────┬──────────────┘
               │
               ▼
    ┌──────────────────────┐
    │  ~/.npm-global/bin/  │
    │  └─ sbotify (link)   │
    └──────────────┬───────┘
                   │
                   ▼
    ┌──────────────────────────────┐
    │  node_modules/.bin/sbotify   │
    │  └─ dist/index.js (compiled) │
    └──────────────┬───────────────┘
                   │
                   ▼
    ┌──────────────────────────────┐
    │  sbotify process             │
    │  ├─ stdio: MCP protocol      │
    │  ├─ child: mpv headless      │
    │  └─ port 3737: web server    │
    └──────────────────────────────┘
```

**Cross-Platform Execution**:
- Shebang: `#!/usr/bin/env node` in dist/index.js
- Windows: npm creates wrapper .cmd script
- macOS/Linux: Symlink to executable script

## Scalability & Limits

**Single-Instance Limits**:
- Queue: 1000 tracks max (memory)
- Concurrent WebSocket clients: 100+ (browser tabs)
- Cache size: ~50 MB (100 videos × 500KB metadata)

**Beyond MVP**:
- Multi-instance: Each agent spawns separate sbotify process
- Distributed queue: Share state via Redis (v0.2)
- Load balancing: Not needed for single-user MVP

## Security Boundaries

```
┌─────────────────────────────────────────────────┐
│  Trust Boundary: Agent ↔ MCP Server             │
│  - Agent can request any tool (no auth)         │
│  - Assume agent code is trusted                 │
│  - Validate all input (query length, videoId)  │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Trust Boundary: Web Server ↔ Browser           │
│  - CORS: localhost only                         │
│  - WebSocket: No authentication (local only)    │
│  - Validate all POST data (volume range)        │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Trust Boundary: Server ↔ mpv                   │
│  - IPC socket: Parent process inherited perms   │
│  - Validate all JSON messages                   │
│  - Never execute shell commands with user input │
└─────────────────────────────────────────────────┘
```

## Monitoring & Observability

**Logging** (Phase 2+):
- Only use `console.error()` (never `console.log()`)
- Format: `[component] message {context}`
- Examples:
  ```
  [sbotify] Starting...
  [youtube-provider] search complete {query: "lo-fi", results: 15}
  [mpv-controller] volume set {volume: 75}
  [web-server] client connected {clients: 3}
  ```

**Metrics** (Post-MVP):
- Search latency (agent perspective)
- Playback uptime
- WebSocket reconnects
- Error rates by component

## References

- [MCP Specification](https://modelcontextprotocol.io/)
- [Node.js Child Process](https://nodejs.org/api/child_process.html)
- [mpv JSON IPC](https://mpv.io/manual/master/#json-ipc)
- [WebSocket Protocol (RFC 6455)](https://tools.ietf.org/html/rfc6455)
- [@distube/ytsr Docs](https://github.com/distubejs/ytsr)
- [yt-dlp Docs](https://github.com/yt-dlp/yt-dlp)
