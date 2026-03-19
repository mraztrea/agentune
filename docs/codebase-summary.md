# Codebase Summary

## Current Implementation

`sbotify` is a shared local daemon for agent-controlled music playback.

- Agents talk to the daemon through MCP.
- The daemon owns queue state, playback, listening history, and the browser dashboard.
- `mpv` handles audio output.
- SQLite stores tracks, play events, provider cache data, persisted persona taste text, and persisted manual persona traits.

The active state redesign is agent-first:

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

`discover()` now returns a flat paginated list of Apple candidates. The server builds Apple-only batches, deduplicates them, soft-ranks them from history plus stored manual persona traits, caches the ranked snapshot, then returns the requested page.

## Project Structure

```text
sbotify/
├── src/
│   ├── index.ts
│   ├── audio/
│   │   ├── mpv-controller.ts
│   │   └── platform-ipc-path.ts
│   ├── cli/
│   │   ├── status-command.ts
│   │   └── stop-command.ts
│   ├── daemon/
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
│   └── web/
│       ├── state-broadcaster.ts
│       ├── web-server-helpers.ts
│       └── web-server.ts
├── public/
│   ├── app.js
│   ├── index.html
│   └── style.css
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
- store manual persona traits in `session_state.persona_traits_json`
- keep older `lane_json`, `taste_state_json`, `agent_persona_json`, and `current_intent_json` columns for compatibility
- expose aggregate queries used by the taste engine and discover pipeline:
  - `getRecentPlaysDetailed()`
  - `getTopArtists()`
  - `getTopTags()`
  - `getTrackStats()`
  - `batchGetTrackStats()`

Important details:

- `normalizeTrackId(artist, title)` is the canonical track key.
- The constructor performs runtime migrations to add `persona_taste_text` and `persona_traits_json` when an older database is opened.
- `preferences` still exists in schema, but it is not the active persona model.

### Taste Engine

File: `src/taste/taste-engine.ts`

Current responsibilities:

- expose current time context
- read and persist manual persona traits
- read and persist free-text taste text
- package the agent-facing session summary for MCP and the dashboard

Important details:

- Traits default to `{ exploration: 0.5, variety: 0.5, loyalty: 0.5 }`.
- Traits stay fixed until the agent or dashboard updates them.
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

- build Apple candidate batches from explicit `artist` / `genres` seeds
- fall back to top 3 history artists and top 3 history tags when no seeds are provided
- deduplicate repeated `artist + title` pairs, interleave artists, and break adjacent same-artist clusters after ranking
- soft-rank candidates from top artists, top tags, per-track completion, skip rate, and recent-repeat penalty
- cache ranked snapshots for pagination

Important details:

- Public output is flat and paginated: `{ page, limit, hasMore, candidates[] }`.
- `DiscoverBatchBuilder` only calls Apple artist-track and Apple genre search APIs; public candidates always return `provider: "apple"`.
- Internal Apple IDs stay on internal candidates only; `toPublicCandidate()` strips them before the MCP response.
- The pagination cache is in-memory, keyed by normalized `{ artist, genres }`, uses a 5 minute TTL, keeps up to 10 snapshots, and does not cache empty results.
- If no explicit seeds exist and history has no top artists or tags, `discover()` returns an empty candidate list.

## MCP Surface

Files:

- `src/mcp/mcp-server.ts`
- `src/mcp/tool-handlers.ts`

State-related MCP tools:

- `get_session_state()`
  - returns `context`, `persona`, and `history`
- `discover(page?, limit?, artist?, genres?, mode?, intent?)`
  - returns `{ page, limit, hasMore, candidates }`
- `update_persona({ taste })`
  - persists free-text taste text
  - empty string is allowed to clear it
- `set_persona_traits({ exploration, variety, loyalty })`
  - persists the full manual trait object
  - invalidates discover pagination snapshots

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
- `discover()` returns a flat page plus a tip to call `add_song()` / `play_song()`, and to use `discover(page=2)` when `hasMore` is true.
- `mode` and `intent` remain in the MCP schema for compatibility, but the current discover pipeline ignores them.
- Successful `play_song()` and `add_song()` clear the discover pagination cache.
- `update_persona()` persists taste text and broadcasts persona updates, but does not clear the discover pagination cache.
- `set_persona_traits()` persists traits, broadcasts persona updates, and clears the discover pagination cache.
- Discover ranking is internal only; the public MCP response does not expose scores.

## Queue and Playback

Files:

- `src/queue/queue-manager.ts`
- `src/queue/queue-playback-controller.ts`
- `src/audio/mpv-controller.ts`

Current responsibilities:

- `QueueManager` owns `nowPlaying`, queued items, and playback history.
- `QueuePlaybackController` resolves audio, starts playback, records plays, updates skip/completion status, and advances the queue.
- `MpvController` owns the actual audio engine and emits playback state.

Important details:

- Raw history is recorded with `recordPlay()` on start and `updatePlay()` on skip/finish.
- Playback feedback remains as raw history rows; there is no secondary taste-update path.
- The controller still enriches track tags from Apple after playback begins.
- The next queued track can be prefetched for smoother transitions.

## Web Dashboard

Files:

- `src/web/web-server.ts`
- `src/web/state-broadcaster.ts`
- `src/web/web-server-helpers.ts`
- `public/index.html`
- `public/app.js`
- `public/style.css`

Current HTTP and WebSocket surface:

- `GET /api/status`
- `GET /api/persona`
- `POST /api/persona`
- `POST /api/volume`
- `WS /ws`

Current behavior:

- `StateBroadcaster` publishes playback snapshots: playing, title, artist, thumbnail, position, duration, volume, muted, queue.
- Persona data is fetched separately from `/api/persona`.
- Persona changes are broadcast separately over WebSocket as `{ type: "persona", data: { traits, taste } }`.
- The dashboard includes:
  - now-playing card
  - queue preview
  - volume and mute controls
  - persona textarea
  - editable manual trait sliders

Important details:

- The old dashboard context badge is gone.
- `POST /api/persona` accepts `taste`, `traits`, or both in one validated payload.
- `public/app.js` loads initial playback and persona state with HTTP, then listens for live `state` and `persona` messages.

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
