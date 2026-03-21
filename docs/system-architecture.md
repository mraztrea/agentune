# System Architecture

## Overview

`agentune` is a single-user music control system built around one shared daemon per device.

1. Coding agents connect through MCP.
2. The daemon owns playback, queue state, listening history, and the browser dashboard.
3. `mpv` handles audio playback; SQLite stores durable history and persona taste text.

```
Agent / MCP Client
  -> stdio proxy or HTTP MCP client
  -> agentune daemon
     -> MCP tools
     -> queue + playback controller
     -> taste engine
     -> history store (SQLite)
     -> web dashboard (:dashboardPort from config)
     -> mpv
```

## Runtime Topology

### Proxy Mode

- `agentune` without args starts the lightweight stdio proxy.
- The proxy reads `autoStartDaemon` from `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json`.
- If `autoStartDaemon` is `true`, the proxy auto-starts the daemon when needed.
- If `autoStartDaemon` is `false`, the proxy only connects to an already-running daemon and fails fast with a manual-start hint if none exists.
- The proxy does not own queue, mpv, or database state.
- Closing the proxy session does not stop the daemon.

### Daemon Mode

- `agentune --daemon` starts the long-lived process.
- `agentune start` starts the same daemon in the background and exits after readiness succeeds.
- Runtime config lives at `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json`.
- The daemon exposes:
  - `/mcp` on the configured daemon port for MCP traffic
  - `/health` for readiness checks
  - `/shutdown` for graceful stop
  - the dashboard on `http://127.0.0.1:{dashboardPort}` from config
- The daemon PID file now stores `pid`, `port`, `started`, and a per-process control token.
- `/mcp` and `/shutdown` require `X-Agentune-Daemon-Token`; `/health` stays unauthenticated so proxy discovery and `agentune status` can probe readiness without extra bootstrap.
- Both ports are exact; no automatic fallback is used anymore.
- One daemon means one shared queue, one shared history DB, and one shared `mpv` process.
- The daemon stays alive until an explicit stop request arrives from `agentune stop` or the dashboard stop button.
- `agentune stop` waits for graceful shutdown first and only falls back to a verified process kill.

## Core Components

### History Store

File: `src/history/history-store.ts`

Responsibilities:

- Persist tracks and play events in SQLite
- Persist free-text persona taste in `session_state.persona_taste_text`
- Expose manual cleanup operations for history and provider cache
- Expose aggregate history queries for the taste engine and MCP tools

Tables:

- `tracks`
- `plays`
- `session_state`
- `provider_cache`

Important notes:

- `normalizeTrackId(artist, title)` is the canonical identity key.
- The constructor now migrates older databases to schema version 3, dropping unused legacy columns/tables including `persona_traits_json`.
- Cleanup actions run `wal_checkpoint(TRUNCATE)`, `VACUUM`, and `PRAGMA optimize`.

### Taste Engine

File: `src/taste/taste-engine.ts`

The redesign replaced the older weighted taste model with a smaller agent-first contract:

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

Behavior:

- `Preferences`: editable free-text description stored in SQLite
- `history`: still returned as context for the agent
- discover ranking weights now come from runtime config, not persona state

Important constraints:

- Older structured persona/session objects are no longer part of the active runtime contract.

### Discovery Pipeline

Files:

- `src/taste/discover-batch-builder.ts`
- `src/taste/discover-merge-and-dedup.ts`
- `src/taste/discover-soft-ranker.ts`
- `src/taste/discover-pagination-cache.ts`
- `src/taste/discover-pipeline.ts`

Behavior:

- `discover()` is a flat paginated API: `{ page, limit, hasMore, candidates[] }`.
- `discover()` also returns `nextGuide` so the agent knows whether to change page or improve the search input.
- `DiscoverBatchBuilder` pulls Apple artist tracks and Apple genre search results only.
- When `artist` and `keywords` are both omitted, the builder seeds from the top 3 history artists and top 3 history keywords.
- `mergeAndDedup()` removes duplicate `artist + title` pairs and interleaves artists before ranking.
- `rankCandidates()` soft-ranks by tag affinity, artist familiarity, average completion, novelty, recent-repeat penalty, and skip rate.
- `toPublicCandidate()` strips internal Apple IDs before returning results.
- Pagination snapshots are cached in memory per normalized `{ artist, keywords }` key, with a 5 minute TTL, 10-entry cap, and no empty-result caching.
- Successful `play_song()` and `add_song()` invalidate the discover cache.
- `update_persona()` does not invalidate the discover cache.
- The reranker uses fixed `discoverRanking` values from runtime config.

### MCP Surface

Files:

- `src/mcp/mcp-server.ts`
- `src/mcp/tool-handlers.ts`

State-related tools:

- `get_session_state()`
  - returns `context`, `persona`, and `history`
- `discover(page?, limit?, artist?, keywords?, mode?, intent?)`
  - returns `{ page, limit, hasMore, candidates, nextGuide }`
- `update_persona({ taste })`
  - persists free-text taste text
  - empty string is allowed to clear the value

Playback tools remain queue-first:

- `play_song`
- `add_song`
- `skip`
- `queue_list`
- `now_playing`
- `volume`
- `history`

Important notes:

- `mode` and `intent` are accepted by the tool schema for compatibility, but ignored by the current discover pipeline.
- Discover ordering is server-side, but the response surface does not expose raw scores.

### Queue and Playback

Files:

- `src/queue/queue-manager.ts`
- `src/queue/queue-playback-controller.ts`
- `src/audio/mpv-controller.ts`

Behavior:

- `QueueManager` owns now playing, queued items, and playback history.
- `QueuePlaybackController` resolves audio, records plays, updates completion/skip status, and advances the queue.
- Track feedback is stored as raw history updates only.
- Playback feedback now stays in raw history rows; there is no secondary taste update loop.
- Apple genre enrichment still runs after playback starts and updates track tags asynchronously.

### Web Dashboard

Files:

- `src/web/web-server.ts`
- `src/web/web-server-auth.ts`
- `src/web/web-server-artwork-proxy.ts`
- `src/web/web-server-static-file-path.ts`
- `src/web/state-broadcaster.ts`
- `public/index.html`
- `public/app.js`
- `public/style.css`
- `public/dashboard/*`
- `public/styles/*`

Endpoints:

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

Dashboard features:

- artwork-first now-playing shell
- full-screen `Queue / Now Playing / Settings` tabs
- read-only queue preview
- pause, next, and volume controls
- minimal `Dashboard` block at the top of `Settings`
- curved 7-day line chart
- asymmetric grid with `Plays`, `Tracks`, `Most artists`, and `Most tags`
- persona textarea below the insights block
- database stats and derived SQLite insights from `GET /api/database/stats`
- manual cleanup buttons for history, provider cache, and full reset
- explicit daemon stop button
- same-origin artwork proxy for local rendering and palette extraction

Important notes:

- `GET /` serves the dashboard HTML dynamically and injects a per-process session token into a `<meta>` tag.
- `GET` / `POST` `/api/*` require `X-Agentune-Dashboard-Token`.
- `GET /api/artwork` and `WS /ws` require a `dashboardToken` query param because the browser bootstrap path cannot rely on custom headers for artwork/image requests.
- Dashboard `POST` routes and `WS /ws` also require a same-origin browser request (`Origin` must match the dashboard host).
- The dashboard no longer renders context badges.
- `POST /api/persona` accepts only `taste`.
- artwork theming reads proxied thumbnails instead of sampling remote image URLs directly.
- Dashboard JSON body reads are size-bounded.
- `POST /api/volume` rejects non-finite input and clamps accepted values into `0..100`.
- WebSocket volume updates also reject non-finite input.
- `/api/artwork` only proxies remote `http` / `https` image responses, blocks loopback/private/link-local targets, resolves hostnames before fetch, validates redirect targets, and caps proxied artwork size.
- Static assets are resolved relative to the real `public/` root instead of relying on prefix string checks.
- Persona changes are broadcast to connected clients over WebSocket.
- Dashboard taste edits can arrive through WebSocket or `POST /api/persona`.
- `GET /api/database/stats` returns both raw counts and a smaller `insights` block with `plays7d`, `tracks7d`, skip rate, 7-day activity, top artists, and top tags. The dashboard uses the 7-day insight metrics, while the lower advanced section still shows raw DB counts.
- Cleanup actions stop playback, clear runtime queue state, invalidate discover cache, then mutate SQLite.
- Cleanup actions are serialized so overlapping destructive requests cannot run concurrently.
- `POST /api/daemon/stop` returns success first, then schedules the same shutdown path used by `agentune stop`.
- After a dashboard stop, the page stops reconnecting until agentune is started again.

## Main Flows

### Read Session State

1. Agent calls `get_session_state()`.
2. The taste engine reads stored taste text plus recent history and aggregate stats from SQLite.
3. The tool returns time context, `persona.Preferences`, recent plays, top artists, and top keywords.

### Discover Music

1. Agent optionally calls `get_session_state()` first.
2. Agent calls `discover(page?, limit?, artist?, keywords?)`.
3. `DiscoverPipeline` checks the pagination cache for the normalized `{ artist, keywords }` seed set.
4. On cache miss, the pipeline builds Apple-only batches, deduplicates them, soft-ranks them from history plus fixed runtime config weights, stores the snapshot, slices the requested page, and returns `nextGuide`.
5. Agent chooses a track and calls `add_song()` or `play_song()`.

### Update Persona

1. Agent calls `update_persona({ taste })` or the dashboard posts `/api/persona`.
2. The taste engine writes taste text to `session_state.persona_taste_text`.
3. Updated persona state is broadcast to dashboard clients.
4. Taste updates do not invalidate discover snapshots.

### Playback Feedback

1. Queue playback starts and `recordPlay()` inserts a play row.
2. On skip or finish, `updatePlay()` records `played_sec` and `skipped`.
3. Future `get_session_state()` and `discover()` calls read from that raw history.

### Manual Database Cleanup

1. User opens the dashboard database section.
2. User confirms `clear-history`, `clear-provider-cache`, or `full-reset`.
3. The server stops playback and clears runtime queue state before touching SQLite.
4. The history store performs the selected cleanup, keeps persona state intact, and runs DB maintenance.
5. Updated state is pushed back to the dashboard.

## Build and Validation

- `npm run build` cleans `dist/` before compiling so deleted test files do not leak into later runs.
- `npm test` currently validates:
  - history store behavior
  - queue behavior
  - resolver/provider behavior
  - discover pipeline and soft ranking
  - taste engine redesign

## Design Rules

- Never write to stdout from server internals; MCP stdio must stay clean.
- Keep queue state authoritative in one place.
- Prefer raw data plus agent reasoning over server-side taste prediction.
- Keep runtime settings in `config.json`; keep user history and persona taste text in SQLite.
