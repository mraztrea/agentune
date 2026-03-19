# Project Changelog

## 2026-03-19 (Discover Rewrite)

### Flat Apple-Only Discover Pipeline
- Confirmed the grouped discover lanes are replaced by the new flat flow:
  - `src/taste/discover-batch-builder.ts`
  - `src/taste/discover-merge-and-dedup.ts`
  - `src/taste/discover-soft-ranker.ts`
  - `src/taste/discover-pagination-cache.ts`
  - `src/taste/discover-pipeline.ts`
  - `src/mcp/mcp-server.ts`
  - `src/mcp/tool-handlers.ts`
- Confirmed public discover contract is now `discover(page?, limit?, artist?, genres?)`
- Confirmed default discover seeds come from top history artists + top history tags only
- Confirmed internal Apple IDs stay internal and are stripped before MCP output
- Confirmed successful `play_song()` / `add_song()` invalidate discover snapshots; `update_persona()` does not
- Synced plan + roadmap tracking docs to reflect the shipped discover rewrite instead of the older grouped-lane state

### Validation
- `npm run build`: passed
- `npm test`: 93 passed, 0 failed
- Discover rewrite test state:
  - `src/taste/discover-pipeline.test.ts`: passing
  - `src/taste/discover-soft-ranker.test.ts`: passing
- Built-handler smoke:
  - `handleDiscover({ artist: 'Nils Frahm', limit: 1 })` returned `{ page: 1, limit: 1, hasMore: true, candidates: [...] }`
- Remaining validation gap:
  - no full daemon/MCP smoke result recorded yet

## 2026-03-18 (Agent-First State Redesign Sync)

### Verified Current State Contract
- Re-verified the active state redesign against current source:
  - `src/history/history-schema.ts`
  - `src/history/history-store.ts`
  - `src/mcp/mcp-server.ts`
  - `src/mcp/tool-handlers.ts`
  - `src/queue/queue-playback-controller.ts`
  - `src/taste/candidate-generator.ts`
  - `src/taste/taste-engine.ts`
  - `src/web/state-broadcaster.ts`
  - `src/web/web-server-helpers.ts`
  - `src/web/web-server.ts`
  - `public/app.js`
  - `public/index.html`
  - `public/style.css`
  - `package.json`
- Confirmed `get_session_state()` now returns the agent-facing summary:
  - `context` with hour, period, and day of week
  - `persona` with computed `traits` plus persisted free-text `taste`
  - `history` with recent plays and top artists/tags
- Confirmed `update_persona({ taste })` is part of the MCP surface and persists `session_state.persona_taste_text`
- Confirmed `discover()` now returns grouped raw candidates from `continuation`, `comfort`, `contextFit`, and `wildcard`
- Confirmed the dashboard now exposes a persona editor through `GET /api/persona`, `POST /api/persona`, and `persona` WebSocket broadcasts

### Documentation Sync
- Updated `docs/system-architecture.md` to describe the current agent-first contract, grouped discover lanes, and dashboard persona editor
- Rewrote `docs/codebase-summary.md` from current source and refreshed repo context with `repomix-output.xml`
- Updated `README.md` wording where it still implied continuous session-lane state or server-side reranking
- Left older historical changelog entries intact as historical record; they no longer describe the current runtime

### Validation
- `npm test`
- Current local result: 77 passed, 0 failed
- State redesign coverage includes:
  - `src/history/history-store-state-redesign.test.ts`
  - `src/taste/taste-engine.test.ts`
  - `src/taste/candidate-generator.test.ts`

## 2026-03-17 (Daemon UX — Terminal Hide + Auto-Shutdown)

### Auto-Shutdown on Idle + Transparent Windows Daemon
- Updated `src/proxy/daemon-launcher.ts` — Added `windowsHide: true` to daemon spawn options
  - Prevents visible terminal window popup when daemon auto-starts on Windows
  - Daemon process now completely transparent to user
- Updated `src/daemon/daemon-server.ts` — Added session lifecycle callbacks with 5-second grace timer
  - `onSessionCreated()` callback: cancels pending idle shutdown when agent reconnects
  - `onAllSessionsClosed()` callback: triggers idle shutdown timer
  - 5-second idle grace period (configurable via `IDLE_GRACE_PERIOD`)
  - If no new session connects during grace period, daemon exits gracefully
  - Cleans up mpv, web dashboard, PID file on idle shutdown
- Updated `src/mcp/mcp-server.ts` — `createHttpMcpHandler()` now accepts callbacks
  - Constructor signature: `createHttpMcpHandler({ onSessionCreated?, onAllSessionsClosed? })`
  - Enables daemon to react to session lifecycle events
  - Tracks active sessions via `hadSession` flag for onAllSessionsClosed precision

### Benefits
- Windows users no longer see console window when daemon auto-starts
- Daemon no longer persists indefinitely after final agent session closes
- Resource cleanup happens automatically (mpv, web server, temp files)
- Seamless experience: agent closes → 5s grace period → daemon exits if idle

### Docs Updated
- Updated `docs/system-architecture.md` — Daemon Architecture section: idle timeout, auto-shutdown behavior, callback mechanism

## 2026-03-17 (Singleton Daemon + Stdio Proxy)

### Daemon Architecture for Stateful Session Sharing
- Added `src/daemon/pid-manager.ts` — Manage PID file at `~/.sbotify/daemon.pid` for inter-process discovery
- Added `src/daemon/health-endpoint.ts` — `/health` HTTP endpoint for daemon readiness polling
- Added `src/daemon/daemon-server.ts` — HTTP server on port 3747 with `/health`, `/mcp`, `/shutdown` routes
  - Mounts `StreamableHTTPServerTransport` from MCP SDK for stateful session management
  - Each proxy client gets unique `Mcp-Session-Id` header
  - Shares tool handlers with stdio transport (same singleton accessors)
- Added `src/proxy/daemon-launcher.ts` — Auto-spawn detached daemon if not running; poll health endpoint for readiness
- Added `src/proxy/stdio-proxy.ts` — Default proxy mode: stdio↔HTTP relay using MCP SDK client/server transports
- Added `src/cli/status-command.ts` — `sbotify status` subcommand to print daemon info
- Added `src/cli/stop-command.ts` — `sbotify stop` subcommand to POST `/shutdown` to daemon
- Updated `src/index.ts` — CLI routing: `--daemon` mode, `status` subcommand, `stop` subcommand, default proxy mode
- Updated `src/mcp/mcp-server.ts` — Extracted `registerMcpTools()` to share tool definitions between stdio and HTTP transports
- Updated `docs/system-architecture.md` — New "Daemon Architecture" section with proxy pattern diagram and mode documentation
- Updated `docs/codebase-summary.md` — New daemon/, proxy/, cli/ module documentation; updated src/ directory structure

### Architecture Benefits
- Single daemon per device (stateful: 1 mpv, 1 queue, 1 taste engine, 1 web server)
- Multiple agents can connect via proxy; all share playback state
- Daemon auto-starts on first proxy invocation (seamless experience)
- PID file enables proxy port discovery without hardcoding
- `/health` endpoint + polling ensures daemon readiness before relaying requests
- Graceful shutdown via `/shutdown` endpoint

### Test Results
- All 107 unit tests passing
- Code review score: 7.5/10 (all high-priority issues fixed)
- Build clean: `npm run build` produces dist/ with no errors

### Known Considerations
- PID file at `~/.sbotify/daemon.pid` is single source of truth for proxy discovery
- Daemon port (3747) separate from web dashboard (3737) to avoid conflicts
- Proxy is completely stateless; all logic in daemon singleton
- Multiple proxies can connect to same daemon; state is shared (not isolated per-session)

## 2026-03-16 (Apple-First MCP Flow)

### Discovery-First Public Tool Surface
- Removed public MCP tools that let agents bypass the intended flow: `search`, `play`, `queue_add`
- Restored public MCP tool `play_song(title, artist?)`
  - resolves canonical metadata via Apple Search API
  - replaces the current song immediately
- Added public MCP tool `add_song(title, artist?)`
  - Apple Search API canonicalizes track identity first
  - Queue-only behavior: always adds to queue
  - If queue is idle, starts playback by draining the queue instead of bypassing queue semantics
  - Returns canonical metadata, match score, queue position, and alternatives
- Updated `discover()` MCP responses to point agents to `add_song(...)` while also exposing `play_song(...)` as the replace-current action
- Updated `queue_list()` docs/wording to emphasize read-only queue inspection

### Apple-First Resolution + Queue Preservation
- Added `src/mcp/song-resolver.ts` to centralize song resolution
  - Apple Search API is primary source for canonical title/artist cleanup
  - YouTube search is now an internal playback fallback only
  - Resolver tries multiple YouTube queries sequentially, so one failed query no longer aborts the whole add flow
- Updated `src/queue/queue-playback-controller.ts`
  - Added `addById()` for queue-only add with auto-start when idle
  - Added `replaceCurrentTrack()` for `play_song` immediate replacement behavior
  - Preserves canonical artist/title when queued tracks later become now-playing
- Updated `src/taste/candidate-generator.ts`
  - Apple artist/genre catalog is now primary for continuation + context-fit lanes
  - Smart Search is demoted to expansion/fallback behavior instead of acting like the main recommendation graph

### Validation
- `npm run build`
- `npm test`
- 104/104 tests passing
- Docs impact: minor

## 2026-03-16 (Provider Replacement: Last.fm → Apple + Smart Search)

### Replaced Last.fm Provider with Apple iTunes Search + Smart Search Discovery
- Removed `src/providers/lastfm-provider.ts` — eliminates `LASTFM_API_KEY` dependency
- Added `src/providers/apple-search-provider.ts` — zero-key Apple iTunes Search API integration
  - `searchTracks(query, limit)` for catalog search
  - `getArtistTracks(artist, limit)` for artist discography
  - `getTrackGenre(artist, title)` for metadata enrichment
  - `searchByGenre(genre, limit)` for genre-based discovery
  - 7-day TTL cache to respect 20 calls/min rate limit
- Added `src/providers/smart-search-provider.ts` — intelligent ytsr-based query discovery
  - `getRelatedTracks(artist, title)` replaces Last.fm getSimilarTracks()
  - `searchByMood(mood, limit)` replaces Last.fm getTopTracksByTag()
  - `getArtistSuggestions(artist)` replaces Last.fm getSimilarArtists()
  - 3-day TTL cache for query freshness
  - Uses existing @distube/ytsr; zero new dependencies
- Added `src/providers/metadata-normalizer.ts` — shared YouTube metadata cleanup utility
- Updated `src/taste/candidate-generator.ts` — new provider integration
  - Lane A (continuation): `smartSearch.getRelatedTracks()` replaces `lastfm.getSimilarTracks()`
  - Lane C (context-fit): `smartSearch.searchByMood()` with Apple fallback
  - Lane D (wildcard): `smartSearch.getArtistSuggestions()` replaces artist exploration
- Updated `src/queue/queue-playback-controller.ts` — tag enrichment via Apple genre
  - Async `enrichTrackTags()` now uses `apple.getTrackGenre()` instead of `lastfm.getTopTags()`
  - Synthetic tag enrichment: appends discovery query keywords to genre tags
- Updated `src/index.ts` — removed Last.fm bootstrap, added dual provider init (zero config)
  - Both providers initialize without environment variables
  - Graceful: both providers are optional; app runs without them
- Updated `src/history/history-schema.ts` — renamed cache table `lastfm_cache` → `provider_cache`
- Updated docs to reflect architecture changes (zero API keys required for discovery)
- Build: Clean compile, 100/100 tests pass
- Docs impact: minor

## 2026-03-16 (Runtime Compatibility)

### Node 25 Compatibility Fix
- Updated `src/providers/youtube-provider.ts` to lazy-load `@distube/ytsr` instead of importing it at module load time
- Added a small Node 25 compatibility shim before loading `@distube/ytsr`
  - Maps legacy `fs.rmdirSync(..., { recursive: true })` behavior to `fs.rmSync(..., { recursive: true })`
  - Avoids startup crash on Node.js v25 while leaving `node_modules/` untouched
- Verified build + test still pass after the runtime fix
- Startup path can now reach MCP bootstrap on local Node 25 installs
- Docs impact: minor
- Unresolved questions:
  - None
## 2026-03-16 (Phase 5.5: Discovery Pipeline)

### Phase 5.5: Discovery Pipeline — 4-Lane Generation + 8-Term Scoring
- Added `src/taste/candidate-generator.ts` — CandidateGenerator class with 4 independent lanes
  - Continuation lane: Similar tracks from Last.fm (current track context)
  - Comfort lane: Most-played tracks from history (familiar favorites)
  - Context-fit lane: Tracks matching music intent tags or session lane tags
  - Wildcard lane: Exploration via similar artists (novelty discovery)
  - Lane ratios configurable by discover mode (focus/balanced/explore)
  - Automatic deduplication + tag filtering
- Added `src/taste/candidate-scorer.ts` — CandidateScorer class with 8-term scoring formula
  - Context match (0.32): Fits intent/session lane
  - Taste match (0.24): Aligned with artist obsessions
  - Transition quality (0.18): Smooth from current track
  - Familiarity fit (0.10): Repeat tolerance + callback love
  - Exploration bonus (0.08): Novelty appetite + persona curiosity
  - Freshness bonus (0.08): Never-played tracks
  - Repetition penalty (-0.22): antiMonotony scaling
  - Boredom penalty (-0.18): Artist boredom scores
  - Softmax sampling with mode-based temperature (focus: 0.3, balanced: 0.7, explore: 1.2)
- Added `src/taste/candidate-scorer.test.ts` with unit tests for scoring algorithm
- Added new MCP tool `discover(mode?, intent?)` to `src/mcp/mcp-server.ts`
  - Mode: "focus" (deterministic), "balanced" (default), "explore" (high entropy)
  - Intent: optional {energy?, valence?, novelty?, allowed_tags?, avoid_tags?}
  - Returns: array of ScoredCandidate with score + reasons
- Added new MCP tool `get_session_state()` to `src/mcp/mcp-server.ts`
  - Returns: full taste profile + agent persona + current session lane + recent 5 plays
  - Enables agent to understand taste context before calling discover()
- Updated `src/mcp/tool-handlers.ts` with handleDiscover + handleGetSessionState
  - handleDiscover instantiates CandidateGenerator + CandidateScorer
  - handleGetSessionState returns taste summary for agent context
- Updated `src/queue/queue-manager.ts` — QueueItem.context field (replaces deprecated mood field)
- Updated `src/web/state-broadcaster.ts` — Dashboard broadcasts context instead of mood
- Deprecated `play_mood` tool; agents should use discover() + play() instead
- Updated `README.md` — Features section now references discovery pipeline, removed mood references
- Updated `docs/codebase-summary.md` — Removed mood section, added candidate-generator + candidate-scorer
- Updated `docs/system-architecture.md` — New Discovery Pipeline component section with full data flow
- All 90+ unit tests passing; build clean; zero new external dependencies

## 2026-03-16 (Continued)

### Phase 4: Taste Intelligence + Session Lanes
- Added `src/taste/taste-engine.ts` — TasteEngine class with taste state, agent persona, and session lanes
  - Taste state: obsessions (artist/tag affinity 0-1), boredom (fatigue 0-1), cravings (active tag interests), noveltyAppetite, repeatTolerance
  - Agent persona: curiosity, dramaticTransition, callbackLove, antiMonotony (evolved separately from user prefs)
  - Session lanes: groups 2-5 songs by tag overlap (30% threshold); pivots on mood shift
  - Time-based decay: `value * 0.95^hours` for natural preference evolution
  - Implicit feedback processing: skip ratio + completion rate → obsession/boredom adjustments
- Added new MCP tool `get_session_state` to `src/mcp/mcp-server.ts` — returns taste profile + persona + current lane + recent plays
- Integrated feedback wiring into `src/queue/queue-playback-controller.ts` — calls `taste.processFeedback()` on skip and natural finish events
- Extended `src/history/history-store.ts` with `getTrackTags()` method to support tag-level feedback from Last.fm cache
- All state persisted to `session_state` table in SQLite (non-blocking)
- Added `src/taste/taste-engine.test.ts` with unit tests for taste state transitions
- All 60+ unit tests passing; build clean; zero new external dependencies

### Phase 3: Last.fm Provider + Cache
- Added `src/providers/lastfm-provider.ts` — Last.fm API client with 7-day SQLite cache
  - 4 endpoints: `getSimilarArtists(artist, limit?)`, `getSimilarTracks(artist, track, limit?)`, `getTopTags(artist, track?)`, `getTopTracksByTag(tag, limit?)`
  - Cache eviction on startup: deletes expired rows with 7-day TTL
  - YouTube metadata normalization: `normalizeForQuery()` strips official/lyric/live/ft. suffixes before querying Last.fm
  - Graceful degradation: returns empty arrays if API call fails or times out (5s timeout)
  - Singleton pattern: `createLastFmProvider(apiKey, db)` + `getLastFmProvider()`
- Extended `src/history/history-store.ts` with two new methods:
  - `getDatabase(): Database.Database` — Direct DB access for external providers (e.g., Last.fm)
  - `updateTrackTags(trackId: string, tags: string[]): void` — Store Last.fm tags in track record
- Updated `src/queue/queue-playback-controller.ts` — Async tag enrichment on every play (fire-and-forget)
  - After playback starts, fetches `getTopTags()` from Last.fm provider and stores in history DB
  - Does not block audio playback; runs in background
- Updated `src/index.ts` — Optional Last.fm provider init gated by `LASTFM_API_KEY` env var
  - Non-fatal: provider gracefully disabled if env var missing or API key invalid
- All 60+ unit tests passing; build clean; no new external dependencies (Last.fm API is free, no auth)

## 2026-03-16

### Phase 2: Smart Play (play_song + Search Result Scorer)
- Added `src/providers/search-result-scorer.ts` — fuzzy-match scoring module for YouTube search results
  - Scores titles, artists, duration, and applies quality penalties (live, remix, slowed, 8d) and bonuses (official audio, topic/auto-generated)
  - Returns scored results sorted by confidence (0–2 scale)
  - Strips quality suffixes and normalizes for robust comparison
- Added new MCP tool `play_song(title, artist?)` to `src/mcp/mcp-server.ts` and `handlePlaySong` to `src/mcp/tool-handlers.ts`
  - Primary query: `"{artist} - {title} official audio"` (searches 10 results)
  - Fallback query: `"{artist} {title}"` if top score below 0.2 minimum
  - Returns `{matched, nowPlaying, matchScore, matchReasons, alternatives}` for transparency
  - Uses canonical artist/title overrides to ensure accurate history recording
- Updated `queue_add` tool to accept optional `id` parameter for direct video ID queuing (alongside existing `query` parameter)
- Updated `YouTube` search default limit from 5 to 10 when used in play_song flow for better match options
- Extended `playById` in queue-playback-controller to accept optional `canonicalArtist` and `canonicalTitle` for override history recording
- All 60 unit tests passing; build clean; no new dependencies added

## 2026-03-15

### Phase 1+: SQLite History Foundation
- Added `src/history/history-store.ts` with `HistoryStore` class backed by better-sqlite3; singleton pattern via `createHistoryStore()` and `getHistoryStore()`
- Added `src/history/history-schema.ts` with SQLite table definitions (tracks, plays, preferences, session_state, lastfm_cache) and `normalizeTrackId()` for consistent track dedup
- Database location: `~/.sbotify/history.db` (configurable via `SBOTIFY_DATA_DIR` env var); auto-created on first run with WAL mode for concurrent safety
- Added MCP tool `history` to `src/mcp/mcp-server.ts` — enables agent to query recent plays with play counts and skip rates
- Integrated history recording into `src/queue/queue-playback-controller.ts` — `recordPlay()` called when track starts, `updatePlay()` called on finish/skip
- Updated `src/index.ts` to initialize history store on startup (non-fatal) and close DB gracefully on shutdown
- Added `src/history/history-store.test.ts` with unit tests for recordPlay, updatePlay, getRecent, getTrackStats
- New dependency: better-sqlite3 v12.8.0 (+ @types/better-sqlite3 dev dependency)
- Backward compatible with existing queue/MCP workflow; history persistence is a new feature layer

## Earlier Updates (Phase 7 and prior)

### Phase 7: Queue + Polish
- Replaced the queue placeholder with a real `QueueManager` in `src/queue/queue-manager.ts` that tracks now playing, upcoming queue, and playback history.
- Added `src/queue/queue-playback-controller.ts` to coordinate queue advancement, manual skip, YouTube stream resolution, and mpv playback without duplicating tool logic.
- Updated `src/mcp/tool-handlers.ts`, `src/index.ts`, and `src/audio/mpv-controller.ts` so `queue_add`, `queue_list`, `skip`, graceful shutdown, and natural track-end auto-advance all run through the same playback path.
- Updated `src/web/state-broadcaster.ts` and `src/web/web-server.ts` so the browser dashboard receives live queue state instead of placeholder data.
- Hardened `src/providers/youtube-provider.ts` with a retry path for transient `yt-dlp` extraction failures.
- Added `src/queue/queue-manager.test.ts`, `src/queue/queue-playback-controller.test.ts`, `.npmignore`, and the `npm test` script for Phase 7 verification and release prep.
- Updated README, roadmap, architecture docs, and plan files to mark MVP feature work complete while explicitly deferring the actual npm publish step.

### Phase 6: Mood Mode
- Replaced the mood stub in `src/mood/mood-presets.ts` with 5 curated mood pools and random query selection helpers.
- Wired `play_mood` in `src/mcp/tool-handlers.ts` to normalize user mood input, select a curated search query, search YouTube, and reuse the existing playback flow.
- Updated `src/mcp/mcp-server.ts` to accept case-insensitive mood input at the tool boundary instead of rejecting non-lowercase variants.
- Extended `src/audio/mpv-controller.ts` and `src/web/state-broadcaster.ts` so active mood metadata flows into dashboard state.

### Phase 5: Browser Dashboard
- Added `src/web/web-server.ts` with static file serving, `/api/status`, `/api/volume`, WebSocket upgrade handling, and one-time browser auto-open on first successful play.
- Added `src/web/state-broadcaster.ts` and `src/web/web-server-helpers.ts` to push 1-second playback snapshots and keep the HTTP/WebSocket layer modular.
- Extended `src/audio/mpv-controller.ts` with state-change events, mute tracking, and a readable state snapshot for the dashboard.
- Updated `src/index.ts` and `src/mcp/tool-handlers.ts` to initialize the dashboard with the mpv controller and open the browser on first play.
- Replaced placeholder dashboard assets in `public/index.html`, `public/style.css`, and `public/app.js` with a responsive dark UI, reconnecting WebSocket client, progress bar, volume slider, and mute toggle.
- Hardened degraded-mode behavior so `/api/volume` returns `503` instead of crashing when mpv is unavailable, while `/api/status` and WebSocket state remain available.
- Added a Phase 5 journal entry in `docs/journals/2026-03-15-phase-05-browser-dashboard.md`.

### Validation
- `npm test`
- `npm run build`
- Queue manager unit tests
- Queue playback controller unit tests
- Local queue broadcaster smoke: queue + mood appear in dashboard state snapshot
- Local mood helper smoke: normalization, query pool size, random query selection
- Local handler smoke: invalid mood returns MCP error result
- Local broadcaster smoke: mood metadata appears in dashboard state
- Smoke test: `GET /`
- Smoke test: `GET /api/status`
- Smoke test: `WS /ws` initial state message
- Smoke test: `POST /api/volume` returns safe `503` when mpv is unavailable
