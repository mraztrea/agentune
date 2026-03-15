# Project Roadmap

## Overview

sbotify is a 7-phase project delivering an MCP music server by end of Phase 7. This roadmap tracks milestones, dependencies, and progress toward MVP completion and eventual npm publication.

## Phase Dependencies

```
Phase 1 (Setup)
    │
    ├─→ Phase 2 (MCP Server)
    │       │
    │       ├─→ Phase 3 (Audio Engine)
    │       │       │
    │       │       ├─→ Phase 4 (YouTube)
    │       │       │       │
    │       │       │       ├─→ Phase 5 (Dashboard) ─┐
    │       │       │       ├─→ Phase 6 (Mood)      │
    │       │       │       └─→ Phase 7 (Queue)     │ (can run in parallel)
    │       │       │               │                │
    │       │       │               └────────────────┘
    │       │       └─ Required before Phase 5,6,7
    │       └─ Required before Phase 3
    └─ Required before Phase 2
```

**Critical Path**: 1 → 2 → 3 → 4 → (5, 6, 7 in parallel)
**Minimum for MVP**: Phases 1–4 complete (Agent can search, play, skip)
**P1 features**: Phases 5–7 (Dashboard, moods, queue)

## Timeline Estimate

| Phase | Duration | Status | Start | End |
|-------|----------|--------|-------|-----|
| 1. Setup | 1 day | ✓ COMPLETE | Mar 15 | Mar 15 |
| 2. MCP Server | 3 days | → IN PROGRESS | Mar 16 | Mar 18 |
| 3. Audio Engine | 3 days | ⏳ PENDING | Mar 19 | Mar 21 |
| 4. YouTube | 3 days | ⏳ PENDING | Mar 22 | Mar 24 |
| 5. Dashboard | 3 days | ⏳ PENDING | Mar 25 | Mar 27 |
| 6. Mood Mode | 2 days | ⏳ PENDING | Mar 25 | Mar 26 |
| 7. Queue + Polish | 3 days | ⏳ PENDING | Mar 25 | Mar 27 |
| **Total** | **~18 days** | | **Mar 15** | **Mar 27** |

**Notes**:
- Phases 5, 6, 7 can start once Phase 4 completes (parallelizable)
- Polish includes: npm publish setup, README polish, test suite
- 18 days = 3.6 weeks of continuous development

## Phase 1: Project Setup (COMPLETE)

**Status**: ✓ COMPLETE (Mar 15)

**Objectives**:
- [x] Initialize Node.js + TypeScript project
- [x] Configure tsconfig.json (ESM, strict mode)
- [x] Set up package.json with dependencies
- [x] Create project structure (src/, public/, docs/)
- [x] Create placeholder module files
- [x] Write initial documentation (README, docs/)

**Deliverables**:
- [x] Git repo initialized
- [x] package.json with all dependencies
- [x] tsconfig.json (ES2022, Node16, strict)
- [x] Placeholder modules in src/
- [x] README.md at project root
- [x] docs/ with 5 documentation files

**Files Modified**:
- `README.md` (created)
- `docs/project-overview-pdr.md` (created)
- `docs/codebase-summary.md` (created)
- `docs/code-standards.md` (created)
- `docs/system-architecture.md` (created)
- `docs/project-roadmap.md` (created) — this file

**Success Criteria**:
- [x] `npm run build` compiles without errors
- [x] All import paths use ESM syntax + .js extensions
- [x] TypeScript strict mode passes
- [x] No TODO markers in documentation

---

## Phase 2: MCP Server & Tool Definitions (IN PROGRESS)

**Status**: → IN PROGRESS (Est. Mar 16–18)

**Objectives**:
- Implement `McpServer` initialization
- Define all MCP tool schemas (Zod)
- Implement tool request handling (search, play, skip, queue, status, mood)
- Ensure stdio safety (no console.log())
- Add graceful error handling for all tools

**Deliverables**:
- `src/mcp/mcp-server.ts` — Full implementation (~150 LOC)
- Tool definitions for: search, play, skip, queue, status, mood
- Error handling with `{isError, message, data}` structure
- Zod schemas for all tool inputs
- Integration tests (isolated from providers)

**Key Functions**:
```typescript
export function createMcpServer(): void
export async function handleSearchTool(req: SearchRequest): Promise<ToolResult>
export async function handlePlayTool(req: PlayRequest): Promise<ToolResult>
export async function handleSkipTool(): Promise<ToolResult>
export async function handleQueueTool(req: QueueRequest): Promise<ToolResult>
export async function handleStatusTool(): Promise<ToolResult>
export async function handleMoodTool(req: MoodRequest): Promise<ToolResult>
```

**Dependencies**:
- Phase 1 (Setup) — COMPLETE
- @modelcontextprotocol/sdk v1.x
- zod v4.x

**Acceptance Criteria**:
- [ ] McpServer initializes on startup
- [ ] All 6 tools register with correct schemas
- [ ] Tool results always include `{isError: boolean, message: string, data?: any}`
- [ ] No `console.log()` calls (only `console.error()`)
- [ ] Tests verify tool registration + error handling
- [ ] Agent can invoke tools via stdio (manual smoke test)
- [ ] Zod validation rejects invalid inputs
- [ ] `npm run build` passes without errors

**Files to Create/Modify**:
- `src/mcp/mcp-server.ts` (full implementation)
- `src/index.ts` (update initialization)
- `src/queue/queue-manager.ts` (stub: export state interface)
- `src/mood/mood-presets.ts` (stub: export getMoodQuery())

**Testing Strategy**:
- Unit: Test each tool function in isolation (mock providers)
- Integration: Test tool registration + stdio transport
- Smoke: Manual Agent invocation via Claude Code

**Unresolved Questions**:
- Should mood tool auto-play or just return search results?
  → Decision: auto-play first result (matches Agent UX expectation)

---

## Phase 3: Audio Engine (mpv) (PENDING)

**Status**: ⏳ PENDING (Est. Mar 19–21)

**Objectives**:
- Spawn headless mpv process with JSON IPC
- Implement play, pause, skip, volume commands
- Subscribe to property changes (playback-time, duration)
- Handle errors and auto-recovery
- Cross-platform IPC (Windows named pipes, Unix sockets)

**Deliverables**:
- `src/audio/mpv-controller.ts` — Full implementation (~200 LOC)
- JSON IPC message queue
- Property listener (playback-time, duration, pause)
- Error recovery with exponential backoff
- Auto-recovery on mpv crash

**Key Functions**:
```typescript
export function createMpvController(): MpvController
export class MpvController {
  async play(url: string): Promise<void>
  async pause(): Promise<void>
  async setVolume(volume: number): Promise<void>
  async stop(): Promise<void>
  onPropertyChange(callback: (prop, value) => void): void
  async shutdown(): Promise<void>
}
```

**Dependencies**:
- Phase 1 (Setup) — COMPLETE
- Phase 2 (MCP Server) — IN PROGRESS
- node-mpv v1.5.0
- System: mpv binary installed

**Acceptance Criteria**:
- [ ] mpv spawns on startup (verify via `ps aux | grep mpv`)
- [ ] JSON IPC socket created (verify `/tmp/sbotify-mpv` or Windows pipe)
- [ ] `play(url)` streams audio within 2 seconds
- [ ] `setVolume()` adjusts volume 0–100 smoothly
- [ ] Property changes (playback-time) broadcast to listeners
- [ ] `stop()` gracefully terminates playback
- [ ] mpv crash detected + auto-restart within 5s
- [ ] Socket timeout handled (5s timeout, 3 retries)
- [ ] Works on Windows, macOS, Linux
- [ ] No hanging processes on shutdown
- [ ] Tests verify command queueing + error recovery

**Files to Create/Modify**:
- `src/audio/mpv-controller.ts` (full implementation)
- `src/index.ts` (update initialization)
- `src/queue/queue-manager.ts` (add state broadcaster)

**Testing Strategy**:
- Unit: Test JSON message formatting, property parsing
- Integration: Verify mpv playback, volume control
- Stress: Rapid play/skip/stop commands
- Error: Force socket disconnection, verify recovery

---

## Phase 4: YouTube Provider (PENDING)

**Status**: ⏳ PENDING (Est. Mar 22–24)

**Objectives**:
- Implement YouTube search via @distube/ytsr
- Extract stream URLs via youtube-dl-exec (yt-dlp)
- Cache URLs with 5-hour TTL
- Handle no-results and unavailable videos gracefully
- Target < 1s search latency, < 2s URL extraction

**Deliverables**:
- `src/providers/youtube-provider.ts` — Full implementation (~150 LOC)
- Search function with result parsing
- Stream URL extraction with caching
- Metadata parsing (title, artist, duration, thumbnail)
- Error handling for all failure modes

**Key Functions**:
```typescript
export async function search(query: string): Promise<SearchResult[]>
export async function getStreamUrl(videoId: string): Promise<string>
export async function parseMetadata(videoId: string): Promise<TrackMetadata>
export function clearUrlCache(): void
export function getCacheStats(): {size: number, entries: number}
```

**Data Structures**:
```typescript
export type SearchResult = {
  videoId: string;
  title: string;
  channel: string;
  duration: number; // seconds
  thumbnail: string; // URL
  viewCount: number;
};

export type TrackMetadata = {
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
};
```

**Dependencies**:
- Phase 1 (Setup) — COMPLETE
- Phase 2 (MCP Server) — IN PROGRESS
- Phase 3 (Audio Engine) — IN PROGRESS
- @distube/ytsr v2.0.4
- youtube-dl-exec v3.1.3
- System: yt-dlp binary installed

**Acceptance Criteria**:
- [ ] `search(query)` returns results within 1s
- [ ] `search("")` returns `{isError: true}`
- [ ] `search(query)` returns ≥5 results for common queries
- [ ] `getStreamUrl(videoId)` returns valid m3u8 URL within 2s
- [ ] Stream URLs cached; second call returns cached URL instantly
- [ ] Cache TTL enforced (5-hour expiration)
- [ ] `getStreamUrl(invalidId)` returns `{isError: true}`
- [ ] `parseMetadata()` extracts title, artist, duration correctly
- [ ] Thumbnail URLs are valid (can be loaded in browser)
- [ ] No API keys required (purely scraping-based)
- [ ] Handles rate limiting gracefully (fallback to direct yt-dlp)
- [ ] Tests verify search results, URL validity, caching behavior

**Files to Create/Modify**:
- `src/providers/youtube-provider.ts` (full implementation)
- `src/index.ts` (update initialization)

**Testing Strategy**:
- Unit: Mock @distube/ytsr + youtube-dl-exec
- Integration: Real search against YouTube (1–2 live tests)
- Performance: Measure search + URL extraction latency
- Error: Handle no results, unavailable videos, rate limits

**Unresolved Questions**:
- Should we cache search results or only URLs?
  → Decision: Cache URLs only (search results change rapidly)
- How to handle @distube/ytsr if it breaks?
  → Decision: Monitor; fallback to yt-dlp --dump-json if needed

---

## Phase 5: Browser Dashboard (PENDING)

**Status**: ⏳ PENDING (Est. Mar 25–27, parallel with 6 & 7)

**Objectives**:
- Implement HTTP server (localhost:3737)
- Serve static HTML/CSS/JS dashboard
- Implement WebSocket for real-time updates
- Display now-playing info (title, artist, progress, thumbnail)
- Implement volume slider
- Show next-track queue preview

**Deliverables**:
- `src/web/web-server.ts` — Full implementation (~180 LOC)
- `public/index.html` — Dashboard template (~100 LOC)
- `public/app.js` — Client-side logic (~100 LOC)
- `public/style.css` — Responsive styling (~80 LOC)

**Key Functions**:
```typescript
export function createWebServer(): void
export function broadcastStatus(status: QueueStatus): void
```

**Endpoints**:
```
GET /               → index.html
GET /api/status     → {nowPlaying, progress, queue}
POST /api/volume    → {volume: 0–100}
WS /ws              → Real-time updates
```

**Dashboard Features**:
- Now-playing: Title, artist, album art, duration
- Progress bar (clickable for seek — Phase 7)
- Volume slider (0–100, real-time control)
- Queue preview (next 3 tracks)
- Connected status indicator
- Responsive mobile design

**Dependencies**:
- Phase 3 (Audio Engine) — COMPLETE
- Phase 4 (YouTube) — COMPLETE
- ws v8.19.0 (WebSocket)
- Node.js built-in http module

**Acceptance Criteria**:
- [ ] Server starts on localhost:3737
- [ ] GET / returns valid HTML
- [ ] GET /api/status returns correct JSON
- [ ] WebSocket connects; broadcasts updates
- [ ] Dashboard shows now-playing title in real-time
- [ ] Progress bar updates every 100ms
- [ ] Volume slider adjusts volume 0–100
- [ ] Mobile responsive (works on phone browser)
- [ ] Auto-reconnect on WebSocket disconnect
- [ ] CORS configured for localhost only
- [ ] Tests verify endpoints + WebSocket messaging

**Files to Create/Modify**:
- `src/web/web-server.ts` (full implementation)
- `public/index.html` (template)
- `public/app.js` (client logic)
- `public/style.css` (styling)
- `src/index.ts` (update initialization)

**Testing Strategy**:
- Unit: Test endpoint handlers + WebSocket logic
- Integration: Manual browser test (open localhost:3737)
- Performance: Measure WebSocket latency (target < 100ms)
- Mobile: Test responsive design on phone

---

## Phase 6: Mood Mode (PENDING)

**Status**: ⏳ PENDING (Est. Mar 25–26, parallel with 5 & 7)

**Objectives**:
- Implement mood-to-query mapping
- Support 7+ mood keywords (focus, chill, hype, workout, sleep, relaxation, productivity)
- Integrate with Agent tool (mood tool auto-plays)
- Curate quality search queries for each mood

**Deliverables**:
- `src/mood/mood-presets.ts` — Mapping + function (~50 LOC)
- 7+ mood presets with tested queries
- Mood query validation

**Key Functions**:
```typescript
export function getMoodQuery(mood: string): string
export const MOOD_PRESETS: Record<string, string>
```

**Mood Presets** (curated):
```typescript
{
  "focus": "lofi hip hop beats to study to",
  "chill": "chill jazz vibes",
  "hype": "best hip hop 2024",
  "workout": "pump up workout music",
  "sleep": "ambient sleep music 8 hours",
  "relaxation": "spa relaxation music",
  "productivity": "focus music for work",
  "afternoon": "lo-fi afternoon vibes",
  "evening": "indie music evening",
  "party": "best party hits 2024"
}
```

**Integration**:
- MCP tool `mood(keyword)` calls `getMoodQuery(keyword)`
- Then invokes `search()` and `play()`
- Returns now-playing metadata to Agent

**Dependencies**:
- Phase 2 (MCP Server) — COMPLETE
- Phase 4 (YouTube) — COMPLETE

**Acceptance Criteria**:
- [ ] All 10+ moods map to valid search queries
- [ ] Agent can invoke `mood("focus")` successfully
- [ ] Song plays within 3s of mood command
- [ ] getMoodQuery() handles unknown moods (fallback to literal query)
- [ ] Case-insensitive mood matching (mood("FOCUS") works)
- [ ] Tests verify all mood presets return valid results

**Files to Create/Modify**:
- `src/mood/mood-presets.ts` (full implementation)
- `src/mcp/mcp-server.ts` (update mood tool handler)

**Testing Strategy**:
- Unit: Test mood mapping + query generation
- Integration: Invoke mood tool, verify play
- Manual: Test each mood keyword in Agent

---

## Phase 7: Queue + Polish + Publish (PENDING)

**Status**: ⏳ PENDING (Est. Mar 25–27, parallel with 5 & 6)

**Objectives**:
- Implement queue operations (add, skip, remove, shuffle, clear)
- Auto-advance to next track when current finishes
- Polish documentation (update README, add examples)
- Set up npm publish (package.json metadata, .npmignore)
- Full test suite (unit, integration, E2E)
- Fix any lingering bugs from Phases 2–6

**Deliverables**:
- `src/queue/queue-manager.ts` — Full implementation (~150 LOC)
- Auto-advance logic (on mpv "end-file" event)
- Queue operations (add, skip, remove, shuffle, clear)
- Persistence placeholder (for v0.2)
- Test suite (~200 LOC, 80%+ coverage)
- npm publish checklist + verification
- Updated documentation

**Key Functions**:
```typescript
export class QueueManager {
  add(track: Track): void
  skip(): Track | null
  remove(index: number): void
  shuffle(): void
  clear(): void
  now(): Track | null
  getQueue(): Track[]
  getHistory(): Track[]
}
```

**Auto-Advance Logic**:
```
1. mpv emits "end-file" event
2. Queue Manager detects (via listener)
3. Pop next track from queue
4. Invoke play(videoId)
5. Update dashboard
6. Repeat
```

**Queue Operations**:
- `add(track)`: Append to queue (UI: "queue this song")
- `skip()`: Pop current, play next
- `remove(index)`: Remove from queue at index
- `shuffle()`: Randomize queue
- `clear()`: Empty queue (stop playback)

**Dependencies**:
- Phase 3 (Audio Engine) — COMPLETE
- Phase 4 (YouTube) — COMPLETE
- Phase 5 (Dashboard) — COMPLETE (for state broadcast)

**Acceptance Criteria**:
- [ ] Queue operations work correctly (add, skip, remove)
- [ ] Auto-advance to next track on song finish
- [ ] Shuffle correctly randomizes queue
- [ ] Dashboard shows queue updates in real-time
- [ ] Agent can queue multiple tracks + skip through them
- [ ] Full E2E test: Agent plays → skips → queues → plays mood
- [ ] Test coverage ≥ 80% (P0 paths 100%)
- [ ] npm publish metadata complete (name, version, keywords, author)
- [ ] README updated with usage examples
- [ ] .npmignore excludes src/, tests/, docs/
- [ ] `npm install -g ./` works locally
- [ ] `sbotify` command works from anywhere
- [ ] No console.log() calls anywhere
- [ ] All TypeScript strict

**Files to Create/Modify**:
- `src/queue/queue-manager.ts` (full implementation)
- `src/index.ts` (update initialization + shutdown)
- `src/audio/mpv-controller.ts` (add end-file listener)
- `tests/` (new directory with test files)
- `package.json` (update metadata, add .npmignore)
- `.npmignore` (new file)
- `README.md` (update with examples + Phase 7 completion)
- `docs/project-roadmap.md` (mark complete)

**Testing Strategy**:
- Unit: Test each queue operation + auto-advance logic
- Integration: E2E flow (search → play → skip → queue → mood)
- Performance: Measure skip latency (target < 500ms)
- Cross-platform: Run tests on Windows, macOS, Linux

**npm Publish Checklist**:
- [ ] `npm run build` produces clean dist/
- [ ] `npm test` passes all tests
- [ ] README.md is complete
- [ ] LICENSE file exists (MIT)
- [ ] package.json has all required fields
- [ ] Shebang in dist/index.js after compilation
- [ ] No dependencies on local paths
- [ ] Local install: `npm install -g ./` works
- [ ] Global invocation: `sbotify` works from any directory
- [ ] `npm publish --dry-run` succeeds
- [ ] npm package page shows correct metadata

---

## Success Metrics (End of Phase 7)

### Agent Autonomy
- [x] Agent can search YouTube without human help
- [x] Agent can play first result
- [x] Agent can skip to next track
- [x] Agent can queue multiple tracks
- [x] Agent can use mood keywords
- [x] All operations work without browser interaction

### User Experience
- [x] Browser dashboard shows now-playing info in real-time
- [x] Volume control works smoothly
- [x] Queue preview shows next tracks
- [x] Mobile responsive design

### Reliability
- [x] Audio plays for 8+ hours without interruption
- [x] Auto-recovery from mpv crash
- [x] WebSocket auto-reconnect on disconnect
- [x] No hanging processes on shutdown

### Installation & Distribution
- [x] `npm install -g sbotify` works
- [x] `sbotify` command available globally
- [x] Works on Windows, macOS, Linux
- [x] npm package published (v0.1.0)

### Code Quality
- [x] TypeScript strict mode passes
- [x] No console.log() calls
- [x] 80%+ test coverage
- [x] ESM-only codebase
- [x] Follows code standards

---

## Known Risks & Mitigations

| Risk | Impact | Mitigation | Phase |
|------|--------|-----------|-------|
| @distube/ytsr breaks | Search fails (F1 broken) | Monitor; fallback to yt-dlp query | 4 |
| YouTube blocks yt-dlp | URL extraction fails | Implement Invidious fallback | 4+ |
| mpv unavailable | Audio won't play | Graceful error + install instructions | 3 |
| WebSocket latency | Dashboard stale | Increase broadcast frequency | 5 |
| Queue state loss | Playback interrupted | Implement persistent queue (v0.2) | 7+ |
| Windows IPC timeout | Agent blocked | Add timeout + retry logic | 3 |
| Stream URL expires | Song stops mid-play | Refresh cache on 404 | 4 |

---

## Post-MVP Roadmap (v0.2+)

### v0.2: Enhanced Queue
- Persistent queue (JSON file in ~/.sbotify)
- Seek/resume on playback bar click
- Keyboard shortcuts (Space: play/pause, N: next, P: previous)
- Queue shuffle/repeat modes

### v0.3: Streaming Integrations
- Spotify support (requires Spotify API)
- Apple Music fallback
- SoundCloud search

### v0.4: Advanced Features
- Audio equalizer (bass, treble, vocals)
- Lyrics display (via Genius API)
- Recommendation engine
- User accounts (multi-user mode)

---

## Progress Tracking

**Last Updated**: Mar 15, 2026

| Phase | Status | % Complete | Notes |
|-------|--------|-----------|-------|
| 1 | ✓ COMPLETE | 100% | Docs created |
| 2 | → IN PROGRESS | 0% | Starting implementation |
| 3 | ⏳ PENDING | 0% | Blocked on Phase 2 |
| 4 | ⏳ PENDING | 0% | Blocked on Phase 3 |
| 5 | ⏳ PENDING | 0% | Blocked on Phase 4 |
| 6 | ⏳ PENDING | 0% | Blocked on Phase 4 |
| 7 | ⏳ PENDING | 0% | Blocked on Phase 4 |
| **Overall** | **5%** | | MVP target: 57% (Phases 1–4) |

---

## Questions & Decisions Log

**Q1**: Should mood tool auto-play or just return results?
**Decision**: Auto-play first result (better UX for Agent)
**Rationale**: Reduces friction; matches Agent mental model of "play focus music"

**Q2**: How long to cache YouTube URLs?
**Decision**: 5 hours
**Rationale**: YouTube URL TTL ~6 hours; 5h buffer prevents mid-playback expiry

**Q3**: Single process or multi-instance per Agent?
**Decision**: Single instance for MVP
**Rationale**: Simplicity; v0.2 can add multi-instance support

**Q4**: Persist queue to disk?
**Decision**: Not in MVP (session-only)
**Rationale**: Reduces complexity; most sessions <1 hour anyway

**Q5**: Support offline mode?
**Decision**: No
**Rationale**: Requires pre-downloading content; MVP is online-only
