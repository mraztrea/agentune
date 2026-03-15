# Project Changelog

## 2026-03-15

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
