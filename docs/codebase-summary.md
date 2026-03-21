# Codebase Summary

## Current Implementation

`agentune` is a shared local daemon for agent-controlled music playback.

- Agents talk to the daemon through MCP.
- The daemon owns queue state, playback, listening history, and the browser dashboard.
- `mpv` handles audio output.
- SQLite stores tracks, play events, provider cache data, and persisted persona taste text.
- Runtime ports, default volume, auto-start policy, and fixed discover ranking live in `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json`.
- The daemon is explicit-lifecycle: no idle auto-shutdown, stop only via CLI or dashboard.
- `agentune stop` now waits for graceful shutdown first and only falls back to a verified process kill.
- The daemon PID file now also carries a per-process control token used by `/mcp` and `/shutdown`.
- The dashboard now bootstraps a per-process session token into HTML and requires that token for local API, artwork-proxy, and WebSocket access.

The active state redesign is agent-first:

```ts
{
  context: { hour, period, dayOfWeek },
  persona: { Preferences: string },
  history: {
    recent: [...],
    stats: { topArtists, topKeywords }
  }
}
```

`discover()` now returns a flat paginated list of Apple candidates. The server builds Apple-only batches, deduplicates them, soft-ranks them from history plus fixed runtime config weights, caches the ranked snapshot, then returns the requested page.

## Project Structure

```text
agentune/
├── src/
│   ├── index.ts
│   ├── audio/
│   │   ├── mpv-controller.ts
│   │   ├── node-mpv-bootstrap.ts
│   │   └── platform-ipc-path.ts
│   ├── cli/
│   │   ├── start-command.ts
│   │   ├── status-command.ts
│   │   └── stop-command.ts
│   ├── daemon/
│   │   ├── daemon-auth.ts
│   │   ├── daemon-server.ts
│   │   ├── health-endpoint.ts
│   │   └── pid-manager.ts
│   ├── history/
│   │   ├── history-schema.ts
│   │   ├── history-store.ts
│   │   ├── history-store-state-redesign.test.ts
│   │   └── history-store.test.ts
│   ├── mcp/
│   │   ├── mcp-server.ts
│   │   ├── song-resolver.ts
│   │   └── tool-handlers.ts
│   ├── providers/
│   │   ├── apple-search-provider.ts
│   │   ├── metadata-normalizer.ts
│   │   ├── search-result-scorer.ts
│   │   └── youtube-provider.ts
│   ├── proxy/
│   │   ├── daemon-launcher.ts
│   │   └── stdio-proxy.ts
│   ├── queue/
│   │   ├── queue-manager.ts
│   │   └── queue-playback-controller.ts
│   ├── taste/
│   │   ├── discover-batch-builder.ts
│   │   ├── discover-merge-and-dedup.ts
│   │   ├── discover-pagination-cache.ts
│   │   ├── discover-pipeline.test.ts
│   │   ├── discover-pipeline.ts
│   │   ├── discover-soft-ranker.test.ts
│   │   ├── discover-soft-ranker.ts
│   │   ├── taste-engine.ts
│   │   └── taste-engine.test.ts
│   ├── types/
│   │   └── node-mpv.d.ts
│   ├── runtime/
│   │   ├── runtime-config.test.ts
│   │   ├── runtime-config.ts
│   │   └── runtime-data-paths.ts
│   └── web/
│       ├── state-broadcaster.ts
│       ├── web-server-auth.ts
│       ├── web-server-artwork-proxy.test.ts
│       ├── web-server-artwork-proxy.ts
│       ├── web-server-database-cleanup.test.ts
│       ├── web-server-database-cleanup.ts
│       ├── web-server-helpers.ts
│       ├── web-server-static-file-path.ts
│       ├── web-server-test-helpers.ts
│       └── web-server.ts
├── public/
│   ├── app.js
│   ├── assets/
│   │   └── agentune-mark.svg
│   ├── dashboard/
│   │   ├── auth.js
│   │   ├── constants.js
│   │   ├── dom.js
│   │   ├── insights.js
│   │   ├── marquee.js
│   │   ├── render.js
│   │   ├── settings-api.js
│   │   └── theme.js
│   ├── favicon.ico
│   ├── index.html
│   ├── style.css
│   └── styles/
│       └── dashboard-settings.css
├── docs/
├── package.json
├── README.md
└── repomix-output.xml
```

## State Redesign

### History Store

Files:

- `src/history/history-schema.ts`
- `src/history/history-store.ts`

Current responsibilities:

- persist `tracks`, `plays`, `provider_cache`, and `session_state`
- store free-text persona taste in `session_state.persona_taste_text`
- migrate old databases to the trimmed schema without legacy session/preference columns
- expose manual cleanup operations for history, provider cache, and full reset
- expose aggregate queries used by the taste engine and discover pipeline:
  - `getRecentPlaysDetailed()`
  - `getTopArtists()`
  - `getTopTags()`
  - `getTrackStats()`
  - `batchGetTrackStats()`

Important details:

- `normalizeTrackId(artist, title)` is the canonical track key.
- The constructor migrates older DBs to schema version 3 and removes `preferences`, `similar_json`, `lane_id`, `persona_traits_json`, and older session-state columns.
- Cleanup actions run `wal_checkpoint(TRUNCATE)`, `VACUUM`, and `PRAGMA optimize`.

### Taste Engine

File: `src/taste/taste-engine.ts`

Current responsibilities:

- expose current time context
- read and persist free-text taste text
- package the agent-facing session summary for MCP and the dashboard

Important details:

- The engine does not run a feedback scoring loop.
- There is no active weighted taste runtime outside the returned summary.

### Discovery

Files:

- `src/taste/discover-batch-builder.ts`
- `src/taste/discover-merge-and-dedup.ts`
- `src/taste/discover-soft-ranker.ts`
- `src/taste/discover-pagination-cache.ts`
- `src/taste/discover-pipeline.ts`

Current responsibilities:

- build Apple candidate batches from explicit `artist` / `keywords` seeds
- fall back to top 3 history artists and top 3 history keywords when no seeds are provided
- deduplicate repeated `artist + title` pairs, interleave artists, and break adjacent same-artist clusters after ranking
- soft-rank candidates from top artists, top stored track tags, per-track completion, skip rate, and recent-repeat penalty
- cache ranked snapshots for pagination

Important details:

- Public output is flat and paginated: `{ page, limit, hasMore, candidates[], nextGuide }`.
- `DiscoverBatchBuilder` only calls Apple artist-track and Apple genre search APIs; public candidates always return `provider: "apple"`.
- Internal Apple IDs stay on internal candidates only; `toPublicCandidate()` strips them before the MCP response.
- The pagination cache is in-memory, keyed by normalized `{ artist, keywords }`, uses a 5 minute TTL, keeps up to 10 snapshots, and does not cache empty results.
- If no explicit seeds exist and history has no top artists or keywords, `discover()` returns an empty candidate list.

## MCP Surface

Files:

- `src/mcp/mcp-server.ts`
- `src/mcp/tool-handlers.ts`

State-related MCP tools:

- `get_session_state()`
  - returns `context`, `persona`, and `history`
- `discover(page?, limit?, artist?, keywords?, mode?, intent?)`
  - returns `{ page, limit, hasMore, candidates, nextGuide }`
- `update_persona({ taste })`
  - persists free-text taste text
  - empty string is allowed to clear it

Playback-related MCP tools:

- `play_song(title, artist?)`
- `add_song(title, artist?)`
- `pause()`
- `resume()`
- `skip()`
- `queue_list()`
- `now_playing()`
- `volume(level?)`
- `history(limit?, query?)`

Important details:

- `play_song` and `add_song` are Apple-first for canonical metadata.
- `discover()` returns a flat page plus `nextGuide`, which tells the agent whether to keep paging or improve `artist` / `keywords`.
- `mode` and `intent` remain in the MCP schema for compatibility, but the current discover pipeline ignores them.
- Successful `play_song()` and `add_song()` clear the discover pagination cache.
- `update_persona()` persists taste text and broadcasts persona updates, but does not clear the discover pagination cache.
- Discover ranking is internal only; the public MCP response does not expose scores.

## Queue and Playback

Files:

- `src/queue/queue-manager.ts`
- `src/queue/queue-playback-controller.ts`
- `src/audio/mpv-controller.ts`
- `src/audio/node-mpv-bootstrap.ts`

Current responsibilities:

- `QueueManager` owns `nowPlaying`, queued items, and playback history.
- `QueuePlaybackController` resolves audio, starts playback, records plays, updates skip/completion status, and advances the queue.
- `MpvController` owns the actual audio engine and emits playback state.

Important details:

- Raw history is recorded with `recordPlay()` on start and `updatePlay()` on skip/finish.
- Playback feedback remains as raw history rows; there is no secondary taste-update path.
- The controller still enriches track tags from Apple after playback begins.
- The next queued track can be prefetched for smoother transitions.
- On Windows, `node-mpv` is bootstrapped through a small spawn patch so managed `mpv` children start hidden, and the launcher prefers `mpv.exe` when available to avoid blank console windows.

## Web Dashboard

Files:

- `src/web/web-server.ts`
- `src/web/web-server-auth.ts`
- `src/web/state-broadcaster.ts`
- `src/web/web-server-helpers.ts`
- `src/web/web-server-static-file-path.ts`
- `public/dashboard/auth.js`
- `public/index.html`
- `public/app.js`
- `public/style.css`

Current HTTP and WebSocket surface:

- `GET /api/status`
- `GET /api/persona`
- `GET /api/artwork?src=...`
- `POST /api/persona`
- `POST /api/volume`
- `POST /api/daemon/stop`
- `GET /api/database/stats`
- `POST /api/database/clear-history`
- `POST /api/database/clear-provider-cache`
- `POST /api/database/full-reset`
- `WS /ws`

Current behavior:

- `StateBroadcaster` publishes playback snapshots: playing, title, artist, thumbnail, position, duration, volume, muted, queue.
- `GET /` serves dashboard HTML dynamically and injects a session token into a `<meta>` tag.
- Persona data is fetched separately from `/api/persona`.
- Artwork is fetched through `/api/artwork`, so the browser can render and sample thumbnails from a same-origin URL.
- If `/api/artwork` fails, the dashboard image element falls back to the raw remote thumbnail URL so album art still renders on older daemons or proxy failures.
- When no track artwork exists yet, the dashboard falls back to the local `public/assets/agentune-mark.svg` logo instead of a remote placeholder service.
- Persona changes are broadcast separately over WebSocket as `{ type: "persona", data: { taste } }`.
- The dashboard includes:
  - centered player shell with full-screen `Queue / Now Playing / Settings` tabs
  - artwork-first now-playing view with marquee-on-overflow title
  - artwork-driven ambient gradient theming for page background and glass surfaces
  - pause, next, and volume controls
  - read-only queue view
  - top-of-settings `Dashboard` heading with a curved 7-day line chart
  - asymmetric dashboard grid with 7-day `Plays`, 7-day `Tracks`, `Most artists`, and `Most tags`
  - persona textarea below the dashboard block
  - advanced maintenance section with DB path, provider-cache count, cleanup buttons, and explicit daemon stop

Important details:

- Runtime config file now stores exact `dashboardPort`, `daemonPort`, `defaultVolume`, and fixed `discoverRanking` weights.
- Runtime config also stores `autoStartDaemon`, which controls whether proxy sessions may auto-spawn the daemon.
- The daemon is not tied to the proxy terminal anymore; explicit stop only.
- `GET` / `POST` `/api/*` require `X-Agentune-Dashboard-Token`.
- `GET /api/artwork` and `WS /ws` require `dashboardToken`, and mutating browser requests must come from the same dashboard origin.
- `/api/artwork` now resolves DNS before fetch, validates redirects, and rejects blocked private/loopback/link-local targets.
- Static assets are resolved against the real `public/` root instead of relying on prefix string checks.
- The dashboard ships a local SVG logo plus `favicon.ico`; no external placeholder artwork request is needed for the empty state anymore.
- The old dashboard context badge is gone.
- `POST /api/persona` accepts only `taste`.
- Dashboard JSON body reads are bounded instead of buffering untrusted request bodies without a size cap.
- `POST /api/volume` rejects non-finite values and clamps accepted input into `0..100`.
- WebSocket volume updates also reject non-finite values.
- `GET /api/database/stats` now returns raw counts plus a smaller `insights` block sourced from SQLite aggregates: `plays7d`, `tracks7d`, `skipRate`, `activity7d`, top 3 artists, and enough top tags to fill the 2-row dashboard block.
- `public/app.js` loads initial playback and persona state with HTTP, listens for live `state` and `persona` messages, and refetches dashboard stats when the Settings view needs a fresher snapshot.
- `/api/artwork` only proxies remote `http` / `https` image responses, blocks loopback/private/link-local hosts, and caps proxied artwork size.
- Database cleanup actions stop playback, clear runtime queue state, then mutate SQLite.
- Destructive cleanup actions are serialized so overlapping dashboard requests cannot race each other.

## Tests and Validation

Current state-redesign coverage lives in:

- `src/history/history-store-state-redesign.test.ts`
- `src/taste/taste-engine.test.ts`
- `src/taste/discover-pipeline.test.ts`
- `src/taste/discover-soft-ranker.test.ts`

`package.json` currently defines:

```json
"test": "npm run build && node --test dist/**/*.test.js"
```

That means every test run compiles first, then runs the built Node test suite from `dist/`.

## Not Current Anymore

These are no longer current behavior:

- grouped 4-lane `discover()` responses
- `discover` modes changing lane ratios
- `intent.allowed_tags` / `intent.avoid_tags` shaping discover results
- Smart Search participation in the discover pipeline
- the older weighted taste runtime
- lane-based state summaries
- dashboard context badges

Historical changelog entries may still mention those older designs, but the active implementation does not.
