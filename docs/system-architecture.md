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
│  │  ├─ Tool Definitions (get_session_state, discover, play_song, add_song, ...)  │  │
│  │  └─ stdio Transport (agent ↔ server)            │  │
│  └──────────────────────────────────────────────────┘  │
│          │               │              │       │       │
│          ▼               ▼              ▼       ▼       │
│  ┌─────────────┐ ┌─────────────┐ ┌──────────────────┐ │
│  │  YouTube    │ │ Queue       │ │ Discovery        │ │
│  │  Provider   │ │ Manager     │ │ Pipeline (Ph. 5) │ │
│  │ (Phase 4)   │ │ (Phase 7)   │ │ ├─ Candidate Gen │ │
│  └─────────────┘ └─────────────┘ │ └─ Candidate Scr │ │
│         ▲                          └──────────────────┘ │
│         │                               │                │
│  ┌──────┴──────────┬──────────────┐    │                │
│  │                 │              │    │                │
│  ▼                 ▼              ▼    ▼                │
│ ┌────────┐ ┌──────────────────┐ ┌────────────────┐     │
│ │ Apple  │ │ Smart Search     │ │ Taste Engine   │     │
│ │ Search │ │ Provider         │ │ (Phase 4)      │     │
│ │ (Ph.1) │ │ (Phase 1)        │ ├─ Implicit      │     │
│ └────────┘ └──────────────────┘ │   feedback     │     │
│  │                 │             ├─ Session lanes │     │
│  │                 │             ├─ Agent persona │     │
│  └─────────┬───────┘             └────────────────┘     │
│            ▼                                             │
│                  ▼                    ▼                 │
│  ┌──────────────────────────────────────────────┐     │
│  │ mpv Controller (Phase 3)                     │     │
│  │ ├─ JSON IPC Protocol                        │     │
│  │ ├─ Playback Control                         │     │
│  │ └─ Feedback signals (skip, finish) → Taste  │     │
│  └──────────────────────────────────────────────┘     │
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

### 0. History Store (Phase 1+)

**Purpose**: Persistent SQLite-backed database for listening history, play statistics, and session state.

**Implementation**:
- `HistoryStore` class wraps `better-sqlite3` with WAL mode enabled for concurrent access
- Database location: `~/.sbotify/history.db` (configurable via `SBOTIFY_DATA_DIR` env var)
- Auto-creates tables on first run via schema definition

**Tables**:
```
tracks          — Denormalized track metadata + play counts + provider-enriched tags
plays           — Individual play events (started_at, played_sec, skipped, context)
preferences     — Key-value user preferences (weight, boredom scores)
session_state   — Singleton row: lane, taste state, agent persona, current intent
provider_cache  — Provider response cache with TTL (cache_key, response_json, fetched_at)
```

**Key Methods**:
- `recordPlay(track, context?, canonicalOverride?)` → Play ID; upserts track + inserts play event
- `updatePlay(playId, {played_sec?, skipped?})` → Mark play as completed or skipped
- `getRecent(limit?, query?)` → Recent plays with optional text search
- `getTrackStats(trackId)` → Play count, avg completion rate, skip rate
- `getTopTracks(limit?)` → Most played tracks
- `getSessionState() / saveSessionState(state)` → Persistent session data
- `close()` → Graceful database shutdown

**Track ID Strategy**:
- Normalized key: `normalizeTrackId(artist, title)` → `"artist::title"` (lowercase, whitespace collapsed)
- Enables accurate dedup across multiple plays of the same song

**Lifecycle**:
1. Server calls `createHistoryStore()` during bootstrap (non-fatal if fails)
2. DB initialized with schema on first run
3. Play records inserted via `recordPlay()` when tracks start playing
4. Play records updated via `updatePlay()` when tracks finish or are skipped
5. Server calls `getHistoryStore()?.close()` during shutdown

### 1. MCP Server (Phase 2)

**Purpose**: Expose sbotify capabilities as MCP tools for agent invocation.

**Implementation**:
- Initialize `McpServer` from `@modelcontextprotocol/sdk`
- Register tool definitions with Zod schemas
- Handle stdio transport (agent sends JSON → server responds JSON)

**Tools**:
```
Tool: add_song
  Input: {title: string, artist?: string}
  Output: {isError: boolean, action: "queued", added: Track, queuePosition: number, startedPlayback: boolean}

Tool: play_song
  Input: {title: string, artist?: string}
  Output: {isError: boolean, action: "replaced_current", nowPlaying: Track}

Tool: skip
  Input: {}
  Output: {isError: boolean, nowPlaying: Track}

Tool: queue_list
  Input: {}
  Output: {isError: boolean, nowPlaying: Track | null, queue: Track[], history: Track[]}

Tool: discover
  Input: {mode?: "focus"|"balanced"|"explore", intent?: {energy?, valence?, novelty?, allowed_tags?, avoid_tags?}}
  Output: {isError: boolean, candidates: ScoredCandidate[], modeUsed: string}

Tool: get_session_state
  Input: {}
  Output: {isError: boolean, taste: TasteState, persona: AgentPersona, sessionLane: SessionLane | null, recentPlays: TrackRecord[]}

Tool: history
  Input: {limit?: number (1-50, default 20), query?: string}
  Output: {isError: boolean, history: Array<{title, artist, playedAt, playedSec, skipped, playCount, ytVideoId}>, total: number, message: string}
```

**Transport**: stdio (STDIN for input, STDOUT for MCP responses, STDERR for debug logs)

**Error Handling**: All tool results include `isError` flag; never throw.

### 1.5 Discovery Providers (Phase 1) — Apple iTunes Search + Smart Search

**Purpose**: Query music metadata and discovery APIs for clean catalog candidates, genre information, and limited query expansion.

**Providers**:

#### Apple iTunes Search Provider
- Zero API key required
- Queries official Apple iTunes Search API via HTTPS
- Methods:
  - `searchTracks(query, limit)` — Search iTunes catalog
  - `getArtistTracks(artist, limit)` — Fetch artist discography
  - `getTrackGenre(artist, title)` — Extract genre metadata
  - `searchByGenre(genre, limit)` — Genre-based discovery
- Cache: 7-day TTL in `provider_cache` table
- Rate limit: ~20 calls/min (cached aggressively to stay under limit)
- Non-fatal: Returns empty array on failure (5s timeout)

#### Smart Search Provider (ytsr-based)
- Zero API key required
- Uses existing `@distube/ytsr` for query expansion only
- Methods:
  - `getRelatedTracks(artist, title, limit)` — Discover similar tracks via smart queries
  - `searchByMood(mood, limit)` — Mood-based discovery (e.g., "chill music")
  - `getArtistSuggestions(artist, limit)` — Find similar artists
- Cache: 3-day TTL in `provider_cache` table (for query freshness)
- Deduplicates results; excludes current track; includes videoId for direct playback
- Non-fatal: Returns empty array on failure

#### Metadata Normalizer (Shared Utility)
- Cleans YouTube metadata before API queries
- Removes quality suffixes: "(Official Audio)", "[HD]", "(lyrics)", "[live]", etc.
- Removes channel markers: "- Topic", "VEVO"
- Prevents cache poisoning from format variations

**Cache Details**:
- Storage: `provider_cache` table (cache_key: "apple:...", "smart:...", response_json, fetched_at)
- Cache keys include method name + normalized query for deduplication
- Eviction: Expired rows deleted on startup
- Both providers share same table; TTL varies by provider (7 days Apple, 3 days Smart)

**Integration with Discovery Pipeline**:
- Lane A (continuation): `apple.getArtistTracks(artist)` with Smart Search fallback
- Lane C (context-fit): `apple.searchByGenre(tag)` and Apple catalog search first, Smart Search fallback second
- Lane D (wildcard): `smartSearch.getArtistSuggestions(artist)` to suggest artists, then Apple catalog search for clean tracks
- Tag enrichment: `apple.getTrackGenre(artist, title)`

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

### 1.6 Apple Search + Smart Search Providers (Phase 1)

**Purpose**: Zero-config discovery metadata and smart search without API keys.

Implementation combines official Apple iTunes catalog with intelligent YouTube queries.

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

### 4.6 Taste Engine (Phase 4) — NEW

**Purpose**: Track user taste preferences through implicit feedback signals and manage session lanes for mood continuity.

**Key Components**:
- **Taste State**: Obsessions (artist/tag affinity 0-1), boredom (fatigue 0-1), cravings (active tag interests), novelty appetite, repeat tolerance
- **Agent Persona**: Separate from user preferences; controls playback style (curiosity, dramatic transition, callback love, anti-monotony)
- **Session Lanes**: Groups 2-5 consecutive songs by tag overlap; pivots when mood shifts significantly
- **Time-based Decay**: Values decay via `value * 0.95^hours` for natural preference evolution

**Data Flow**:
```
1. Track finishes or is skipped
   └─ QueuePlaybackController calls taste.processFeedback(track, playedSec, totalSec, skipped)

2. TasteEngine updates:
   ├─ Apply time decay to obsessions/boredom
   ├─ Adjust artist/tag obsession/boredom based on completion ratio
   ├─ Update cravings from top tags
   ├─ Update session lane based on tag overlap (30% threshold)
   ├─ Evolve agent persona (+1% per play)
   └─ Persist state to session_state table

3. MCP tool get_session_state returns:
   ├─ Top 5 obsessions + boredom entries
   ├─ Current cravings + appetite/tolerance values
   ├─ Agent persona snapshot
   ├─ Active session lane (description, tags, song count)
   └─ Recent 5 plays with completion metrics
```

**Persistence**: All state persisted to `session_state` table on every feedback event (non-blocking)

### 4.7 Discovery Pipeline (Phase 5) — NEW

**Purpose**: Generate intelligent song suggestions from 4 independent candidate lanes, score with 8-term weighting, and enable agent-driven exploration.

**Components**:
- **CandidateGenerator**: Produces candidates from 4 lanes (continuation, comfort, context-fit, wildcard)
- **CandidateScorer**: Ranks candidates using 8 weighted terms + softmax sampling

**Lanes**:
```
Continuation  — Same-artist / near-lane tracks from Apple catalog (current track context)
Comfort       — Most-played tracks from history (familiar favorites)
Context-fit   — Apple genre/catalog matches for intent or session lane tags
Wildcard      — Exploration via Smart Search artist suggestions + Apple catalog
```

**Discover Modes** (control lane ratios):
```
focus   → 50% continuation, 30% comfort (deterministic, low novelty)
balanced → 40% continuation, 30% comfort, 20% context-fit (default)
explore  → 20% continuation, 15% comfort, 30% context-fit, 35% wildcard (high novelty)
```

**Scoring Formula** (8 weighted terms sum to 1.0):
```
+0.32 context_match      — Fits music intent or session lane
+0.24 taste_match        — Aligned with artist obsessions
+0.18 transition_quality — Smooth from current track
+0.10 familiarity_fit    — Repeat tolerance + callback love
+0.08 exploration_bonus  — Novelty appetite + persona curiosity
+0.08 freshness_bonus    — Never-played bonus (1/(1+playCount))
-0.22 repetition_penalty — Recently played, scaled by antiMonotony
-0.18 boredom_penalty    — From taste boredom scores
```

**Data Flow**:
```
Agent calls get_session_state() → understand taste context
  ↓
Agent constructs optional MusicIntent {energy, valence, novelty, allowed_tags, avoid_tags}
  ↓
Agent calls discover(mode, intent) → CandidateGenerator produces 4 lanes
  ↓
CandidateScorer ranks candidates (8-term formula) → returns ScoredCandidate[]
  ↓
Agent selects candidate → calls add_song(title, artist) or play_song(title, artist)
  ↓
TasteEngine.processFeedback() on finish/skip → updates taste state for next discovery cycle
```

**Integration with Taste Engine**:
- Uses taste obsessions + boredom for scoring weights
- Uses agent persona (curiosity, antiMonotony, callbackLove) for term application
- Uses session lane tags for context matching
- Feeds play/skip events back into taste state via queue playback controller

### 5. Mood Presets (Phase 6) — DEPRECATED

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

**Status**: Deprecated in Phase 5; functionality replaced by discovery pipeline.

**Integration**: Still available for backward compatibility; `play_mood("focus")` normalizes mood → picks random curated query → searches YouTube → plays first result. However, new agent workflows should use `discover()` for intelligent recommendations.

### 6. Web Server (Phase 5) ✓ COMPLETE

**Purpose**: HTTP server for browser dashboard + WebSocket for real-time updates.

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| GET | / | Serve index.html |
| GET | /api/status | JSON: {playing, title, artist, thumbnail, position, duration, volume, muted, queue, context} |
| POST | /api/volume | Set volume (body: {volume: 0-100}) |
| WS | /ws | Real-time push: state updates + volume/mute commands |

**HTTP Server**:
- Listen on localhost:3737, fall back through 3746 if busy
- Serve static files from `public/`
- Return `503` for volume updates when mpv is unavailable instead of crashing the request path

**WebSocket Server**:
- Broadcast playback updates on mpv state changes plus a 1-second position refresh
- Send: `{type: "state", data: {playing, title, artist, thumbnail, position, duration, volume, muted, queue, context}}`
- Accept: `{type: "volume", level}` and `{type: "mute"}` from browser clients
- Push current state immediately on connect

**Dashboard Features**:
- Now-playing title, artist, album art
- Progress bar (display only)
- Volume slider (0-100)
- Mute toggle
- Queue preview reflects live queue manager state
- Context badge reflects current track context (e.g., session lane tag info)
- Auto-refresh on data change
- Auto-opens in the default browser on first successful `play`

### Data Flow Example: Intelligent Discovery

```
1. Agent calls get_session_state() to understand current taste + session context
   ├─ Taste Engine returns: obsessions, boredom, cravings, novelty appetite, repeat tolerance
   ├─ Agent Persona returned: curiosity, dramaticTransition, callbackLove, antiMonotony
   ├─ Session Lane returned: current tag context (e.g., "dark minimal instrumental")
   └─ Recent 5 plays with completion metrics returned

2. Agent optionally constructs a MusicIntent
   ├─ Intent: {energy?: 0–1, valence?: 0–1, novelty?: 0–1, allowed_tags?, avoid_tags?}
   └─ Or calls discover() with no intent (uses session lane as context)

3. Agent calls discover(mode: "balanced", intent: {...})
   ├─ MCP Server creates CandidateGenerator + CandidateScorer

4. CandidateGenerator produces 4 lanes of candidates
   ├─ Lane A (Continuation): Similar tracks from SmartSearchProvider (current track context)
   ├─ Lane B (Comfort): Most-played tracks from history
   ├─ Lane C (Context-fit): Tracks matching intent.allowed_tags or session lane tags via SmartSearchProvider.searchByMood() + Apple fallback
   ├─ Lane D (Wildcard): Exploration via SmartSearchProvider.getArtistSuggestions()
   └─ Deduplicates + filters intent.avoid_tags

5. CandidateScorer scores candidates using 8 weighted terms
   ├─ Context match (0.32): fits intent/session lane
   ├─ Taste match (0.24): artist obsessions
   ├─ Transition quality (0.18): smooth from current track
   ├─ Familiarity fit (0.10): repeat tolerance + callback love
   ├─ Exploration bonus (0.08): novelty appetite
   ├─ Freshness bonus (0.08): never-played bonus
   ├─ Repetition penalty (-0.22): antiMonotony scaling
   └─ Boredom penalty (-0.18): artist boredom scores

6. Softmax sampling with mode-based temperature
   ├─ focus mode: temp=0.3 (deterministic, top candidates)
   ├─ balanced mode: temp=0.7 (default)
   ├─ explore mode: temp=1.2 (high entropy, more diversity)
   └─ Returns top-k candidates with scores + reasons

7. Agent selects a candidate and calls add_song(title, artist)
   ├─ Apple Search canonicalizes the track identity
   ├─ YouTube Provider resolves to stream URL only after canonicalization
   ├─ If nothing is currently playing, queue auto-starts from the queued item
   ├─ Queue Playback Controller: recordPlay() + updatePlay() on finish
   ├─ Taste Engine: processFeedback() on skip/finish (updates taste state)
   └─ Dashboard updates in real-time via WebSocket

8. User sees now-playing info + session lane context in browser
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
