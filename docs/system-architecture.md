# System Architecture

## Overview

`sbotify` is a single-user music control system built around one shared daemon per device.

1. Coding agents connect through MCP.
2. The daemon owns playback, queue state, listening history, and the browser dashboard.
3. `mpv` handles audio playback; SQLite stores durable history and persona text.

```
Agent / MCP Client
  -> stdio proxy or HTTP MCP client
  -> sbotify daemon
     -> MCP tools
     -> queue + playback controller
     -> taste engine
     -> history store (SQLite)
     -> web dashboard (:3737)
     -> mpv
```

## Runtime Topology

### Proxy Mode

- `sbotify` without args starts the lightweight stdio proxy.
- The proxy auto-starts the daemon when needed.
- The proxy does not own queue, mpv, or database state.

### Daemon Mode

- `sbotify --daemon` starts the long-lived process.
- The daemon exposes:
  - `/mcp` on the daemon port for MCP traffic
  - `/health` for readiness checks
  - `/shutdown` for graceful stop
  - the dashboard on `http://127.0.0.1:3737` by default, with fallback through the next 9 ports if needed
- One daemon means one shared queue, one shared history DB, and one shared `mpv` process.

## Core Components

### History Store

File: `src/history/history-store.ts`

Responsibilities:

- Persist tracks and play events in SQLite
- Persist free-text persona taste in `session_state.persona_taste_text`
- Expose aggregate history queries for the taste engine and MCP tools
- Keep backward-compatible legacy session columns without using them in the new state model

Tables:

- `tracks`
- `plays`
- `preferences` (legacy, still present)
- `session_state`
- `provider_cache`

Important notes:

- `normalizeTrackId(artist, title)` is the canonical identity key.
- The constructor now performs a runtime migration to add `persona_taste_text` when an older DB is opened.

### Taste Engine

File: `src/taste/taste-engine.ts`

The redesign replaced the older weighted taste model with a smaller agent-first contract:

```ts
{
  context: { hour, period, dayOfWeek },
  persona: {
    traits: { exploration, variety, loyalty },
    taste: string
  },
  history: {
    recent: [...],
    stats: { topArtists, topTags }
  }
}
```

Behavior:

- `exploration`: derived from recent artists with low historical play counts
- `variety`: normalized tag entropy across recent plays
- `loyalty`: ratio of replayed high-completion tracks
- `taste`: editable free-text description stored in SQLite

Important constraints:

- Traits default to `0.5` when history is too small.
- Traits are computed on demand; there is no incremental scoring loop.
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
- `DiscoverBatchBuilder` pulls Apple artist tracks and Apple genre search results only.
- When `artist` and `genres` are both omitted, the builder seeds from the top 3 history artists and top 3 history tags.
- `mergeAndDedup()` removes duplicate `artist + title` pairs and interleaves artists before ranking.
- `rankCandidates()` soft-ranks by tag affinity, artist familiarity, average completion, novelty, recent-repeat penalty, and skip rate.
- `toPublicCandidate()` strips internal Apple IDs before returning results.
- Pagination snapshots are cached in memory per normalized `{ artist, genres }` key, with a 5 minute TTL, 10-entry cap, and no empty-result caching.
- Successful `play_song()` and `add_song()` invalidate the discover cache.
- `update_persona()` does not invalidate the discover cache.

### MCP Surface

Files:

- `src/mcp/mcp-server.ts`
- `src/mcp/tool-handlers.ts`

State-related tools:

- `get_session_state()`
  - returns `context`, `persona`, and `history`
- `discover(page?, limit?, artist?, genres?, mode?, intent?)`
  - returns `{ page, limit, hasMore, candidates }`
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
- `src/web/state-broadcaster.ts`
- `public/index.html`
- `public/app.js`
- `public/style.css`

Endpoints:

- `GET /api/status`
- `GET /api/persona`
- `POST /api/persona`
- `POST /api/volume`
- `WS /ws`

Dashboard features:

- now-playing state
- queue preview
- volume + mute controls
- persona textarea
- read-only trait bars

Important notes:

- The dashboard no longer renders context badges.
- Persona changes can arrive through HTTP or WebSocket and are broadcast to connected clients.

## Main Flows

### Read Session State

1. Agent calls `get_session_state()`.
2. The taste engine reads recent history and aggregate stats from SQLite.
3. The tool returns time context, computed traits, stored taste text, recent plays, top artists, and top tags.

### Discover Music

1. Agent optionally calls `get_session_state()` first.
2. Agent calls `discover(page?, limit?, artist?, genres?)`.
3. `DiscoverPipeline` checks the pagination cache for the normalized `{ artist, genres }` seed set.
4. On cache miss, the pipeline builds Apple-only batches, deduplicates them, soft-ranks them, stores the snapshot, and slices the requested page.
5. Agent chooses a track and calls `add_song()` or `play_song()`.

### Update Persona

1. Agent calls `update_persona({ taste })` or the dashboard posts `/api/persona`.
2. The taste engine writes the value to `session_state.persona_taste_text`.
3. Updated traits + taste are broadcast to dashboard clients.
4. Existing discover snapshots stay cached until TTL expiry, eviction, or a later `play_song()` / `add_song()` invalidation.

### Playback Feedback

1. Queue playback starts and `recordPlay()` inserts a play row.
2. On skip or finish, `updatePlay()` records `played_sec` and `skipped`.
3. Future `get_session_state()` and `discover()` calls read from that raw history.

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
- Keep legacy DB columns only for compatibility, not as active state.
