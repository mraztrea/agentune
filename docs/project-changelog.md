# Project Changelog

## 2026-03-21 (Default Artwork Flicker Fix)

### Root Cause + Fix
- Fixed the empty-state dashboard artwork jitter in:
  - `src/web/web-server-helpers.ts`
  - `public/dashboard/render.js`
  - `src/web/web-server-playback-controls.test.ts`
- Root cause:
  - local `.svg` assets were being served as `application/octet-stream` instead of `image/svg+xml`
  - the artwork fallback guard compared an absolute browser URL with a relative placeholder path, which could reassign the same fallback source repeatedly on image errors
- The dashboard now serves local SVG artwork with the correct MIME type and avoids placeholder reassign loops.

## 2026-03-21 (Dashboard Favicon + Local Default Artwork)

### Asset Update
- Added a reusable local logo asset in:
  - `public/assets/agentune-mark.svg`
- Replaced the initial local placeholder mark with a lighter SVG waveform logo based on the provided dashboard brand image.
- Removed the SVG background fill so the default artwork now renders with transparency.
- Updated the browser favicon in:
  - `public/favicon.ico`
- The dashboard favicon now uses the provided `ChatGPT Image Mar 21, 2026, 08_30_12 PM.ico` asset.
- Replaced the remote `placehold.co` fallback image in:
  - `public/index.html`
  - `public/dashboard/constants.js`
- The dashboard now uses the local logo asset as its default artwork, which removes an unnecessary external request and shrinks the placeholder payload substantially.
- `index.html` now points favicon loading directly at `/favicon.ico`.

## 2026-03-21 (Local Web Hardening + Safer Daemon Stop)

### Web Hardening
- Hardened dashboard request handling in:
  - `src/web/web-server-helpers.ts`
  - `src/web/web-server-auth.ts`
  - `src/web/web-server-static-file-path.ts`
  - `src/web/web-server.ts`
  - `src/web/web-server-artwork-proxy.ts`
  - `src/web/web-server-database-cleanup.ts`
  - `public/dashboard/auth.js`
  - `public/dashboard/settings-api.js`
  - `public/dashboard/theme.js`
  - `public/dashboard/render.js`
  - `public/app.js`
- `GET /` now serves dashboard HTML with a per-process session token injected into a `<meta>` tag.
- Dashboard routes now require local session auth:
  - `GET` / `POST` `/api/*` require `X-Agentune-Dashboard-Token`
  - `GET /api/artwork` and `WS /ws` require `dashboardToken`
  - mutating `POST` routes and `WS /ws` also require same-origin browser requests
- Old dashboard tabs now fail closed after daemon restart and render a refresh-required state instead of reconnecting forever.
- Added bounded request-body reads for dashboard JSON posts.
- Tightened `/api/volume` validation:
  - rejects non-finite input
  - clamps accepted values into `0..100`
  - applies the same finite-number guard to WebSocket volume messages
- Tightened `/api/artwork`:
  - still only accepts `http` / `https`
  - now rejects loopback, private-network, and link-local targets
  - now resolves hostnames and rejects DNS results that land on blocked IP ranges
  - now validates redirect targets instead of following them blindly
  - now requires upstream `image/*` content
  - now caps proxied artwork size instead of buffering unbounded responses
- Replaced static file prefix checks with resolved-path validation so Windows `public` / `publicity` prefix collisions cannot escape the real `public/` root.
- Serialized destructive dashboard database actions so concurrent cleanup clicks cannot overlap server-side reset work.

### Daemon Lifecycle Hardening
- Hardened daemon entrypoint resolution in:
  - `src/proxy/daemon-launcher.ts`
- The detached launcher now resolves the compiled daemon entrypoint from module location instead of relying on `process.argv[1]`, which is safer for global install and shimmed invocation paths.
- Added daemon control-token auth in:
  - `src/daemon/daemon-auth.ts`
  - `src/daemon/daemon-server.ts`
  - `src/daemon/pid-manager.ts`
  - `src/proxy/stdio-proxy.ts`
  - `src/cli/stop-command.ts`
  - `src/index.ts`
- The PID file now stores a daemon control token.
- `/mcp` and `/shutdown` now require `X-Agentune-Daemon-Token`; `/health` stays unauthenticated for readiness checks.
- Hardened `agentune stop` in:
  - `src/cli/stop-command.ts`
- Stop now:
  - waits for graceful daemon shutdown after `/shutdown`
  - only falls back to process kill after verifying the target still looks like an `agentune` daemon
  - refuses blind PID kills when identity cannot be verified
- Hardened daemon shutdown cleanup in:
  - `src/index.ts`
- Shutdown is now idempotent and best-effort across queue cleanup, HTTP servers, SQLite close, mpv teardown, and PID-file removal.

### Regression Coverage
- Added daemon stop coverage in:
  - `src/cli/stop-command.test.ts`
  - `src/daemon/daemon-server.test.ts`
- Expanded dashboard hardening coverage in:
  - `src/web/web-server-artwork-proxy.test.ts`
  - `src/web/web-server-database-cleanup.test.ts`
  - `src/web/web-server-playback-controls.test.ts`
  - `src/web/web-server-persona-sync.test.ts`
  - `src/web/web-server-test-helpers.ts`
  - `src/proxy/daemon-launcher.test.ts`

### Validation
- `npm test`: 126 passed, 0 failed

## 2026-03-21 (Ambient Background Theme Transition Smoothing)

### Dashboard Background Motion
- Smoothed dashboard ambient color changes on track switch in:
  - `public/style.css`
- Registered the artwork-driven background color tokens with `@property` so the gradient can interpolate instead of snapping when a new palette arrives.
- Limited the motion change to the background color treatment only:
  - artwork swap behavior stays unchanged
  - title and metadata updates stay immediate

### Validation
- `npm run build`: passed

## 2026-03-21 (Concurrent add_song Queue Race Fix)

### Root Cause + Fix
- Fixed a queue race where multiple `add_song` calls arriving at nearly the same time could all observe `nowPlaying === null`, then each independently drain one item from the queue and trigger competing playback starts.
- The result was lost queue entries in practice: one later start would replace an earlier one, so several requested songs disappeared from the visible queue and never got a real turn.
- Serialized playback and queue mutations in:
  - `src/queue/queue-playback-controller.ts`
- `addById()` now reuses the already-resolved audio for the same song when it is the track that should start from an idle queue, instead of re-resolving and racing a second queue drain.
- Applied the same mutation lock to skip, replace-current, natural stop handling, and runtime reset so queue/playback state advances linearly.

### Regression Coverage
- Added concurrent queue coverage in:
  - `src/queue/queue-playback-controller.test.ts`
- Locked the bulk-add guarantee:
  - 20 concurrent `addById()` calls keep exactly 1 track playing and 19 still queued
  - only 1 playback start is issued for the idle-transition path

### Validation
- `npm run build`: passed
- `npm test`: 109 passed, 0 failed

## 2026-03-21 (Queue Auto-Advance After Natural Track End)

### Root Cause + Fix
- Fixed a startup-timing bug where the first playback command could reach `node-mpv` before the idle IPC warmup completed, which caused later EOF stop events to be missed and left the queue stuck until a manual skip.
- Added an mpv startup warmup gate in:
  - `src/audio/mpv-controller.ts`
  - `src/index.ts`
- The daemon now waits briefly after `mpv.init()` before it starts serving playback commands, so natural track end can advance the queue reliably.

### Regression Coverage
- Added queue-controller coverage for natural stop-driven advancement in:
  - `src/queue/queue-playback-controller.test.ts`

### Validation
- `npm test`: 108 passed, 0 failed
- Runtime probe with real `mpv` + two 1-second WAV files:
  - first track ended naturally
  - next track started automatically
  - queue drained into history without manual skip

## 2026-03-21 (Paused Playback Visual Effects)

### Dashboard Pause State
- Added a dedicated playback visual-state mapper in:
  - `public/dashboard/playback-visual-state.js`
- Dashboard render now writes `data-playback-visual-state` to the document root so the paused look stays driven by playback state instead of ad-hoc DOM styling in:
  - `public/dashboard/render.js`

### Pause/Resume Motion + Tone Shift
- Added paused-state transitions in:
  - `public/style.css`
- Locked the paused visual treatment to:
  - slightly larger play icon while paused
  - main artwork and queue-current artwork scaling down toward center
  - artwork shifting to a near-monochrome, desaturated look
  - ambient background desaturating and dimming while paused
  - full color and scale restoring on resume
- Adjusted the paused artwork zoom so the frame components scale instead of only the inner image, preventing exposed frame background during pause.

### Regression Coverage
- Added playback visual-state coverage in:
  - `src/web/playback-visual-state.test.ts`
- Locked these mappings:
  - no track -> `idle`
  - active track + playing -> `playing`
  - active track + paused -> `paused`

### Validation
- `node --check public/dashboard/render.js`: passed
- `node --check public/dashboard/playback-visual-state.js`: passed
- `npm test`: 107 passed, 0 failed

## 2026-03-21 (Dashboard Pause/Resume Control Fix)

### Playback Control Fix
- Fixed the dashboard primary transport button so it now sends WebSocket `playback-toggle` instead of the old pause-only event in:
  - `public/app.js`
- Updated dashboard playback rendering so the primary transport button:
  - stays enabled while a track exists, even when paused
  - swaps between pause and play icons based on playback state
  - updates its `aria-label` to `Pause playback` or `Resume playback` in:
    - `public/dashboard/render.js`

### Regression Coverage
- Expanded WebSocket playback control coverage in:
  - `src/web/web-server-playback-controls.test.ts`
- Locked these behaviors:
  - pause-only messages still remain one-way
  - `playback-toggle` resumes paused playback
  - `playback-toggle` can pause again before resuming and skipping forward

### State Sync Hardening
- Removed direct pause/play icon flipping from:
  - `public/app.js`
- Let dashboard render state remain the single source of truth for the primary transport icon.
- Ignored stale `/api/status` bootstrap data once live socket state or a playback control action already exists in:
  - `public/app.js`
- Dropped older in-flight dashboard refreshes so a slower pre-pause refresh cannot overwrite a newer paused snapshot in:
  - `src/web/state-broadcaster.ts`
- Added overlap coverage in:
  - `src/web/state-broadcaster.test.ts`

### Skip From Pause
- Fixed queue playback so skipping while paused clears mpv's lingering pause flag before the next track starts in:
  - `src/queue/queue-playback-controller.ts`
- Added regression coverage for:
  - queue-level pause-then-skip playback recovery in `src/queue/queue-playback-controller.test.ts`
  - dashboard WebSocket pause-then-next behavior in `src/web/web-server-playback-controls.test.ts`

### Transport Icon Rendering
- Fixed the dashboard transport icon toggle to update the real `hidden` attribute on inline SVG nodes instead of writing the non-reflected `.hidden` property in:
  - `public/dashboard/render.js`
  - `public/dashboard/toggle-hidden-attribute.js`
- Added regression coverage for the attribute-based SVG visibility path in:
  - `src/web/toggle-hidden-attribute.test.ts`

### Validation
- `npm run build`: passed
- `node --check public/app.js`: passed
- `node --check public/dashboard/render.js`: passed
- `npm test`: 103 passed, 0 failed

## 2026-03-21 (Minimal Dashboard Layout Revision)

### Dashboard Layout
- Simplified the Settings analytics surface into a more minimal `Dashboard` block
- Reduced copy so the top of the view now starts with a single `Dashboard` heading
- Kept only `Dashboard` at the top of the analytics block and moved `Settings` into its own lower section heading, using the same compact label style as `Playing` / `Up next`
- Removed card chrome from the lower `Settings` content too, so `Taste` and `Advanced` now read as frameless sections
- Renamed the lower section label from `Settings` to `Preferences`, added more vertical separation from the dashboard block, and renamed the maintenance section to `Advanced Settings`
- Flattened the `Taste` textarea itself as well: no border, no background, and no resize handle
- Replaced the `Taste` save CTA with a minimal circular outline button using a gray checkmark icon
- Centered the `Taste` save button and the `Persona saved.` feedback line in the frameless settings area
- Restyled the four maintenance buttons into a cleaner 2-column outline grid with softer surfaces and red-tinted emphasis only on destructive actions
- Moved `Clear cache` ahead of `Clear history` and aligned both to the same neutral outline style
- Removed fill and hover styling from all four maintenance buttons so the group now reads as pure border-only controls
- Added interactive count tooltips to the `Last 7 days` chart: hover/focus on desktop, tap on mobile, with a minimal numeric-only bubble per point
- Removed the tooltip bubble chrome from the `Last 7 days` chart so hover/tap now shows only the white count text
- Removed the mobile-only single-column fallback for the dashboard grid so the current asymmetric composition stays intact on narrow screens too
- Changed the `Taste` textarea to auto-grow with its content, including initial persona load and live typing
- Fixed the hidden-settings regression where `Taste` could render at `0px` height after persona preload by re-syncing textarea height when the `Preferences` view becomes visible
- Scoped dashboard `Plays`, `Tracks`, `Most artists`, and `Most tags` to the same trailing 7-day window as the chart while keeping raw DB counts intact for `Advanced Settings`
- Reworked the dashboard area into:
  - one full-width `Last 7 days` card
  - an asymmetric grid below it
  - `Plays` and `Tracks` on the top-left row
  - `Most artists` pinned on the right across two rows
  - `Most tags` spanning the lower-left row
- Removed the old `Avg completion` and `Recent plays` dashboard blocks
- Hid the Settings scrollbar chrome while keeping scroll behavior intact
- Removed card chrome from the chart, `Plays`, and `Tracks` so the top dashboard area reads more like a layout than stacked panels
- Made `Most artists` and `Most tags` frameless too, removed artist meter bars, and changed tags into plain outlined chips without counts
- Centered `Plays` and `Tracks`, then removed the tag chip borders and lifted the 3-tag cap so the tag block can fill two wrapped rows
- Synced frameless tag text and the `Most artists` heading to the same muted label color used by `Plays` and `Tracks`
- Kept the `Most tags` heading aligned with `Most artists`, but restored the tag values themselves to bright white
- Decoupled the dashboard line chart from artwork theming so the line, points, and area tint stay white

### Chart + Data Contract
- Replaced the old bar-style activity view with a curved SVG line chart in `public/dashboard/insights.js`
- Trimmed `GET /api/database/stats` insights to:
  - `skipRate`
  - `activity7d`
  - top 3 artists
  - top tags for the 2-row dashboard block
- Kept raw DB `counts` intact for maintenance UI compatibility

### Validation
- Updated coverage in:
  - `src/history/history-store.test.ts`
  - `src/web/web-server-database-cleanup.test.ts`
- Validation:
  - `npm run build`: passed
  - `npm test`: 99 passed, 0 failed
  - `node --check public/app.js`: passed
  - `node --check public/dashboard/insights.js`: passed
  - `node --check public/dashboard/dom.js`: passed

## 2026-03-21 (Settings Refresh + SQLite Listening Insights)

### Settings Layout + Front-End Structure
- Rebuilt the `Settings` view into a clearer vertical hierarchy:
  - `Listening insights`
  - `Your taste`
  - `Advanced`
- Added a dedicated settings stylesheet in:
  - `public/styles/dashboard-settings.css`
- Added focused dashboard modules for settings data and insights rendering in:
  - `public/dashboard/insights.js`
  - `public/dashboard/settings-api.js`
- Updated:
  - `public/index.html`
  - `public/app.js`
  - `public/dashboard/dom.js`
  - `public/dashboard/render.js`
  - `public/style.css`

### Dashboard Insights
- Expanded `GET /api/database/stats` to return:
  - raw counts
  - avg completion
  - skip rate
  - 7-day activity buckets
  - top artists
  - top keywords
  - recent plays
- Added lightweight Settings analytics UI:
  - KPI cards
  - clean 7-day activity chart
  - ranked artist meters
  - keyword chips
  - recent-play list
- Refreshed Settings stats on:
  - initial load
  - Settings tab open
  - cleanup actions
  - current-track changes while Settings is open

### History Store + Validation
- Extended `src/history/history-store.ts` so dashboard stats derive from real SQLite aggregates instead of maintenance counts only
- Added/updated coverage in:
  - `src/history/history-store.test.ts`
  - `src/web/web-server-database-cleanup.test.ts`
- Validation:
  - `npm run build`: passed
  - `npm test`: 98 passed, 0 failed
  - `node --check public/app.js`: passed
  - `node --check public/dashboard/insights.js`: passed
  - `node --check public/dashboard/settings-api.js`: passed

## 2026-03-20 (Dashboard Playback Controls + Client Mapping Fix)

### Dashboard Controls
- Moved the primary `Pause` control above the volume row and centered it in the player layout
- Added a dedicated `Next track` control beside `Pause` in:
  - `public/index.html`
  - `public/style.css`
- Added a playback duration row above the transport controls with:
  - elapsed time on the left
  - full track duration on the right
  - a slim progress bar synced to current playback position
- Reworked the `Queue` view so the current track appears in a dedicated artwork + metadata row above a flat queue list without card borders/backgrounds
- Moved playback controls into one shared dashboard block so `Playing` and `Queue` keep the same duration / transport / volume positions, and made the `Up next` list independently scrollable
- Added a smooth shared-element artwork transition between `Now Playing` and `Queue` when switching tabs in browsers that support View Transitions
- Corrected transport semantics so the dashboard `Pause` control sends pause-only behavior while `Next` remains skip
- Removed the mute button from the player strip
- Replaced the mute button and volume percentage with decorative speaker icons on both sides of the volume slider
- Removed background chrome from the `Pause` and `Next` buttons so transport controls render as plain icons
- Reconnected dashboard background and glass surfaces to the extracted artwork palette instead of fixed gradient values

### Client/Server Mapping Fix
- Re-aligned the browser dashboard modules with the current `public/index.html` selectors in:
  - `public/app.js`
  - `public/dashboard/dom.js`
  - `public/dashboard/marquee.js`
  - `public/dashboard/render.js`
- Reworked overflow title animation so text scrolls inside its own viewport in stepped motion instead of translating the whole heading block
- Restored working dashboard playback actions by wiring WebSocket control messages for:
  - pause/resume toggle
  - next/skip
- Added album-art fallback logic so the dashboard uses the raw thumbnail URL if `/api/artwork` fails on an older running daemon
- Updated `public/dashboard/theme.js` to sample artwork from the proxy first, then fall back to the raw thumbnail URL
- Fixed the remaining palette extraction blocker by loading remote artwork with `crossOrigin = 'anonymous'` before canvas sampling
- Added WebSocket playback control coverage in:
  - `src/web/web-server-playback-controls.test.ts`

### Docs + Validation
- Synced `README.md` and `docs/codebase-summary.md` to the current dashboard control surface
- Validation:
  - `npm run build`: passed
  - `npm test`: 96 passed, 0 failed

## 2026-03-20 (Apple-Music-Inspired Dashboard Redesign)

### Dashboard UX + Front-End Structure
- Rebuilt the browser dashboard into a player-first shell with full-screen `Queue / Now Playing / Settings` tabs
- Replaced the old multi-card layout in:
  - `public/index.html`
  - `public/style.css`
  - `public/app.js`
- Split dashboard front-end code into focused browser modules and CSS partials under:
  - `public/dashboard/`
  - `public/styles/`
- Added marquee-on-overflow title handling and a centered 1:1 artwork presentation
- Moved maintenance controls into an `Advanced` settings section while keeping persona editing on the main settings surface

### Artwork Proxy + Ambient Theming
- Added `GET /api/artwork?src=...` in:
  - `src/web/web-server.ts`
  - `src/web/web-server-artwork-proxy.ts`
- Dashboard artwork now renders through a same-origin proxy so the browser can safely sample colors for ambient gradient theming
- Added artwork proxy coverage in:
  - `src/web/web-server-artwork-proxy.test.ts`

### Docs + Validation
- Added `docs/design-guidelines.md` for the current dashboard visual system and interaction rules
- Synced `docs/codebase-summary.md`, `docs/system-architecture.md`, roadmap, and changelog to the redesigned dashboard surface
- Validation:
  - `npm run build`: passed
  - `npm test`: 95 passed, 0 failed

## 2026-03-20 (Optional Auto-Start + Manual Start Command)

### Daemon Startup Control
- Extended `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json` with `autoStartDaemon`
- Default remains `true`, so existing users keep the same proxy auto-start behavior
- Runtime config loading now validates `autoStartDaemon` as a boolean
- Runtime config loading now writes normalized defaults back to disk when older config files are missing new fields

### CLI + Proxy Behavior
- Added `src/cli/start-command.ts` for `agentune start`
- `agentune start` now ensures the daemon is running in the background and exits after readiness succeeds
- Updated `src/index.ts` so proxy mode reads `autoStartDaemon` before deciding whether it may spawn the daemon
- Updated `src/proxy/daemon-launcher.ts` so launcher flows now support:
  - connect to a healthy running daemon without spawning
  - fail fast with a manual-start message when spawning is disabled
  - report whether the daemon was newly started or already running

### Dashboard Copy + Tests + Docs
- Updated dashboard stop messaging to point users to `agentune start` while still mentioning new-session auto-start when enabled
- Added launcher coverage in `src/proxy/daemon-launcher.test.ts`
- Updated runtime config tests to cover `autoStartDaemon` defaults, validation, and config write-back
- Synced README, system architecture, codebase summary, roadmap, and changelog to the optional auto-start flow

### Validation
- `npm run build`: passed
- `npm test`: 92 passed, 0 failed

## 2026-03-20 (Hide Windows MPV Console Window)

### Windows Playback Startup
- Updated `src/audio/mpv-controller.ts` and added `src/audio/node-mpv-bootstrap.ts`
- Windows `mpv` startup now prefers `mpv.exe` over the console wrapper when available
- `node-mpv` is now loaded through a Windows-specific spawn patch so its child `mpv` process starts with `windowsHide: true`
- Added `--terminal=no` to the managed `mpv` args to suppress terminal output noise
- Result: the blank Windows console window should no longer appear when a coding session auto-starts `agentune`

### Tests
- Added coverage for the Windows launch helpers in `src/audio/node-mpv-bootstrap.test.ts`

## 2026-03-20 (Explicit Daemon Stop Only)

### Daemon Lifecycle
- Removed daemon idle auto-shutdown from `src/daemon/daemon-server.ts`
- Proxy-spawned daemon now detaches on Windows too in `src/proxy/daemon-launcher.ts`, so playback survives terminal closure
- Daemon now stops only through explicit shutdown paths:
  - `agentune stop`
  - daemon `/shutdown`
  - dashboard `Stop daemon`

### Dashboard Stop Control
- Added `POST /api/daemon/stop` in `src/web/web-server.ts`
- Wired dashboard stop requests to the same daemon shutdown path used by the CLI via `src/index.ts`
- Added `Stop daemon` button and stopped-state UX in:
  - `public/index.html`
  - `public/app.js`
  - `public/style.css`
- After a dashboard stop, the page shows a stopped state, disables controls, and stops reconnecting until agentune is started again

### Tests + Docs
- Added web coverage for the explicit daemon stop route in `src/web/web-server-database-cleanup.test.ts`
- Synced README, system architecture, codebase summary, roadmap, and changelog to the explicit-stop lifecycle
- Validation:
  - `npm run build`: passed
  - `npm test`: 86 passed, 0 failed

## 2026-03-20 (Agent-Facing Discover Guidance Cleanup)

### MCP Contract Cleanup
- Tightened the agent-facing state/discover surface to reduce ambiguous field names and follow-up hallucination:
  - `src/taste/taste-engine.ts`
  - `src/mcp/mcp-server.ts`
  - `src/mcp/tool-handlers.ts`
  - `src/taste/discover-batch-builder.ts`
  - `src/taste/discover-pagination-cache.ts`
  - `src/taste/discover-pipeline.ts`
- `get_session_state()` now returns:
  - `persona: { Preferences }`
  - `history.stats.topKeywords`
- `discover()` now accepts `keywords` instead of `genres`
- public discover candidates now return `keywords` instead of `tags`
- `discover()` now always returns `nextGuide` so the agent knows whether to:
  - keep the same search and change page
  - or improve `artist` / `keywords`
- Removed the old discover success `tip` field from MCP output

### Tests + Docs
- Updated discover pipeline tests and persona sync cache tests to the new `keywords` contract
- Synced README, codebase summary, system architecture, and roadmap to the new agent-facing field names
- Validation:
  - `npm run build`: passed
  - `npm test`: 85 passed, 0 failed

## 2026-03-20 (Config-Driven Ranking + Default Volume)

### Persona Surface Simplification
- Removed manual persona traits from the active runtime contract:
  - `src/taste/taste-engine.ts`
  - `src/history/history-schema.ts`
  - `src/history/history-store.ts`
  - `src/history/history-store-migrations.ts`
- `session_state` now keeps only `persona_taste_text`
- `get_session_state()` now returns `persona: { taste }`
- Removed MCP tool `set_persona_traits` and updated dashboard `/api/persona` to accept only `taste`

### Runtime Config Expansion
- Extended `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json` with:
  - `defaultVolume`
  - `discoverRanking`
- Default runtime config is now:
  - `dashboardPort: 3737`
  - `daemonPort: 3747`
  - `defaultVolume: 80`
  - `discoverRanking: { exploration: 0.35, variety: 0.55, loyalty: 0.65 }`
- `src/audio/mpv-controller.ts` now starts mpv with configured `defaultVolume`
- `src/taste/discover-pipeline.ts` and `src/taste/discover-soft-ranker.ts` now read fixed ranking weights from runtime config instead of persona state

### Dashboard + Tests + Validation
- Removed dashboard trait sliders and rewired the persona editor to taste-only updates
- Updated state-redesign tests, persona sync tests, runtime config tests, and discover pipeline tests to the new contract
- Validation:
  - `npm run build`: passed
  - `npm test`: 85 passed, 0 failed

## 2026-03-20 (Runtime Config + DB Cleanup)

### Exact Port Config + Shared Data Dir
- Added shared runtime path/config modules:
  - `src/runtime/runtime-data-paths.ts`
  - `src/runtime/runtime-config.ts`
- `config.json` is now created automatically in `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json`
- Runtime config currently supports:
  - `dashboardPort`
  - `daemonPort`
- Updated daemon, proxy, PID, log, DB, and web startup paths to read from the shared data-dir/config layer
- Removed dashboard port fallback behavior; dashboard and daemon now bind exact configured ports and fail fast if occupied
- Added `src/runtime/runtime-config.test.ts` to lock default-file creation and config validation

### SQLite Schema Cleanup + Maintenance
- Refactored `src/history/history-schema.ts` to the trimmed active schema:
  - kept `tracks`, `plays`, `session_state`, `provider_cache`
  - removed legacy `preferences`
  - removed legacy `tracks.similar_json`
  - removed legacy `plays.lane_id`
  - removed legacy session-state JSON columns
- Added migration layer in:
  - `src/history/history-store-migrations.ts`
  - `src/history/history-store-maintenance.ts`
- History store now migrates older DBs to schema version 2 and adds current indexes for:
  - `plays(track_id, started_at DESC)`
  - `tracks(play_count DESC) WHERE play_count > 0`
  - `provider_cache(fetched_at)`
- Added history-store cleanup operations:
  - `clearHistory()`
  - `clearProviderCache()`
  - `fullReset()`
- Cleanup now runs `wal_checkpoint(TRUNCATE)`, `VACUUM`, and `PRAGMA optimize`

### Dashboard Database Controls
- Added dashboard database routes in `src/web/web-server.ts`:
  - `GET /api/database/stats`
  - `POST /api/database/clear-history`
  - `POST /api/database/clear-provider-cache`
  - `POST /api/database/full-reset`
- Added cleanup helper module `src/web/web-server-database-cleanup.ts`
- Added database section to dashboard UI in:
  - `public/index.html`
  - `public/app.js`
  - `public/style.css`
- Cleanup actions now:
  - require 2-step confirm in the dashboard
  - stop active playback
  - clear runtime queue state
  - invalidate discover cache
  - keep persona taste intact

### Tests + Validation
- Rewrote history-store tests around the trimmed API in:
  - `src/history/history-store.test.ts`
  - `src/history/history-store-state-redesign.test.ts`
- Added web cleanup coverage in:
  - `src/web/web-server-database-cleanup.test.ts`
- Updated `src/web/web-server-persona-sync.test.ts` for exact-port server startup
- Validation:
  - `npm run build`: passed
  - `npm test`: 85 passed, 0 failed

## 2026-03-19 (Hard Manual Persona Traits)

### Manual Persona Traits Are Now the Source of Truth
- Added durable `session_state.persona_traits_json` storage in:
  - `src/history/history-schema.ts`
  - `src/history/history-store.ts`
- Added runtime migration and strict `0..1` validation for persisted traits
- Refactored `src/taste/taste-engine.ts` so `get_session_state()` now returns stored manual traits instead of history-derived traits
- Added MCP tool `set_persona_traits({ exploration, variety, loyalty })` in:
  - `src/mcp/mcp-server.ts`
  - `src/mcp/tool-handlers.ts`
- Kept `update_persona({ taste })` taste-only and confirmed it no longer changes traits
- Updated dashboard persona flow in:
  - `src/web/web-server.ts`
  - `public/index.html`
  - `public/app.js`
  - `public/style.css`
- Dashboard `/api/persona` now accepts `taste`, `traits`, or both in one validated request
- Persona WebSocket broadcasts now send stored traits, not computed trait snapshots

### Discover Ranking + Cache Behavior
- Updated `src/taste/discover-pipeline.ts` to read stored traits via `getTraits()`
- Updated `src/taste/discover-soft-ranker.ts` so `variety` has a real but light nearby diversity effect
- Trait changes now invalidate discover pagination snapshots immediately
- Taste-only persona edits still leave discover cache intact

### Tests + Docs
- Updated tests to lock manual-trait behavior in:
  - `src/history/history-store-state-redesign.test.ts`
  - `src/taste/taste-engine.test.ts`
  - `src/taste/discover-soft-ranker.test.ts`
  - `src/taste/discover-pipeline.test.ts`
  - `src/web/web-server-persona-sync.test.ts`
- Synced manual-trait wording in `README.md`, `docs/codebase-summary.md`, `docs/system-architecture.md`, and `docs/project-roadmap.md`

### Validation
- `npm run build`: passed
- `npm test`: 97 passed, 0 failed

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
- Removed the orphan Smart Search bootstrap and deleted `src/providers/smart-search-provider.ts`
- Startup logs now reflect the Apple-only discover runtime
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
  - `persona` with `traits` plus persisted free-text `taste`
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
- Added `src/daemon/pid-manager.ts` — Manage PID file at `~/.agentune/daemon.pid` for inter-process discovery
- Added `src/daemon/health-endpoint.ts` — `/health` HTTP endpoint for daemon readiness polling
- Added `src/daemon/daemon-server.ts` — HTTP server on port 3747 with `/health`, `/mcp`, `/shutdown` routes
  - Mounts `StreamableHTTPServerTransport` from MCP SDK for stateful session management
  - Each proxy client gets unique `Mcp-Session-Id` header
  - Shares tool handlers with stdio transport (same singleton accessors)
- Added `src/proxy/daemon-launcher.ts` — Auto-spawn detached daemon if not running; poll health endpoint for readiness
- Added `src/proxy/stdio-proxy.ts` — Default proxy mode: stdio↔HTTP relay using MCP SDK client/server transports
- Added `src/cli/status-command.ts` — `agentune status` subcommand to print daemon info
- Added `src/cli/stop-command.ts` — `agentune stop` subcommand to POST `/shutdown` to daemon
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
- PID file at `~/.agentune/daemon.pid` is single source of truth for proxy discovery
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
- Database location: `~/.agentune/history.db` (configurable via `AGENTUNE_DATA_DIR` env var); auto-created on first run with WAL mode for concurrent safety
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
