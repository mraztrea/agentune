# Project Overview & PDR (Product Development Requirements)

## Executive Summary

**sbotify** is an MCP (Model Context Protocol) server enabling coding agents to control music playback like a DJ while writing code. It bridges the gap between AI agents and music streaming by providing a lightweight, headless audio engine with agent-driven search, playback control, and browser-based visualization.

## Product Vision

Empower developers using AI coding assistants (Claude Code, Cursor, Codex) to enhance focus, creativity, and productivity through agent-controlled music. Music selection and playback should require zero human interaction — the agent decides what to play based on context ("focus mode", "hype mode", "relaxing beats").

## Target Users

1. **Primary**: Developers using Claude Code or Cursor for pair programming
2. **Secondary**: Open-source developers needing ambient music during long coding sessions
3. **Tertiary**: Streaming researchers studying agent-based media control

## MVP Scope (Phases 1–4)

### In Scope
- Agent-driven search on YouTube (no API key required)
- Playback control (play, pause, skip, queue)
- Browser dashboard showing now-playing + volume
- Headless audio via mpv (independent of browser)
- Basic mood keywords ("focus", "chill", "hype")
- Cross-platform (Windows, macOS, Linux)

### Out of Scope (Post-MVP)
- Spotify/Apple Music/Amazon Music integration
- Persistent queue storage
- User accounts or playlists
- Lyrics display
- Recommendations
- Audio equalizer or effects

## Functional Requirements

| ID | Requirement | Phase | Priority |
|----|-------------|-------|----------|
| F1 | Agent searches YouTube without API key | 4 | P0 |
| F2 | Agent plays first result from search | 2, 3, 4 | P0 |
| F3 | Agent skips to next track | 2, 3, 7 | P0 |
| F4 | Agent queues multiple tracks | 2, 7 | P0 |
| F5 | Agent reads now-playing info | 2, 3 | P0 |
| F6 | Browser shows now-playing title/progress | 5 | P1 |
| F7 | Browser controls volume | 5 | P1 |
| F8 | Mood keywords auto-generate search queries | 2, 6 | P1 |
| F9 | Queue persists during session | 7 | P1 |
| F10 | Works on Windows, macOS, Linux | 3 | P0 |

## Non-Functional Requirements

| ID | Requirement | Metric | Priority |
|----|-------------|--------|----------|
| NF1 | Search-to-play latency | < 3 seconds | P0 |
| NF2 | Audio reliability | 0 interruptions in 8hr session | P0 |
| NF3 | Memory footprint | < 100 MB | P1 |
| NF4 | TypeScript strict mode | 100% passing | P0 |
| NF5 | Error recovery | Auto-reconnect on mpv crash | P1 |

## Success Metrics

1. **Agent Autonomy**: Agent initiates music without human intervention (F1–F5)
2. **Dashboard UX**: Real-time updates on browser with < 100ms latency
3. **Reliability**: No crashes or playback interruptions during 8-hour session
4. **Installation**: `npm install -g sbotify && sbotify` works out-of-the-box
5. **Cross-platform**: Same code/behavior on Windows, macOS, Linux

## Constraints & Dependencies

### Technical Constraints
- **No Spotify/YouTube Music API**: Use @distube/ytsr (scraping-free) + yt-dlp
- **Node.js ESM only**: TypeScript strict mode, async/await throughout
- **MCP Protocol**: Compliance with @modelcontextprotocol/sdk v1.x
- **stdio safety**: No console.log() — use console.error() only
- **URL expiry**: YouTube streams expire after ~6 hours (force refresh on play)

### System Dependencies
- Node.js 20+ (LTS)
- mpv (audio engine)
- yt-dlp (Python-based audio extraction)

### Architecture Dependencies
1. Phase 1 (Setup) → Phase 2 (MCP) → Phase 3 (mpv) → Phase 4 (YouTube)
2. Phase 4 is also prerequisite for Phase 5, 6, 7

## Acceptance Criteria

### Phase 2: MCP Server
- [ ] McpServer initializes with stdio transport
- [ ] All tool definitions registered (search, play, skip, queue, status)
- [ ] Tool results use `{isError: true/false}` structure
- [ ] Zero console.log() calls

### Phase 3: Audio Engine
- [ ] mpv spawns with JSON IPC socket
- [ ] Play, pause, stop commands work
- [ ] Progress/duration reporting works
- [ ] Graceful shutdown without hanging

### Phase 4: YouTube Provider
- [ ] Search returns video metadata (title, duration, URL)
- [ ] Stream URLs valid for 6+ hours
- [ ] Handles no results gracefully
- [ ] < 1 second search latency

### Phase 5: Dashboard
- [ ] Now-playing title updates in real-time
- [ ] Progress bar syncs with playback
- [ ] Volume slider sends commands to mpv
- [ ] Responsive on mobile browsers

## Out-of-Scope Justification

- **Spotify Integration**: Requires OAuth + paid API; YouTube is free + no keys
- **Persistent Storage**: MVP focuses on single-session behavior
- **Recommendations**: Too complex for MVP; mood keywords sufficient
- **Advanced UI**: Focus on minimal, functional dashboard first

## Success Criteria (Final)

Agent can execute this conversation **without human intervention**:

```
Agent: "Play lo-fi beats for focus"
[sbotify searches YouTube, plays first result]
[Browser shows now-playing: "lo-fi beats 🎧"]

Agent: "This is too upbeat. Try something more chill."
[Agent searches for "chill jazz", plays result]
[Progress updates on browser]

Agent: "Skip this one"
[Next track plays immediately]

Agent: "What's playing now?"
[Agent reads metadata from sbotify]
```

All without human clicking, confirmation, or intervention.

## Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| YouTube scraping blocked | F1 broken | Monitor @distube/ytsr; fallback to direct yt-dlp query |
| mpv crashes | All playback halted | Auto-restart with backoff; notify agent |
| Stream URLs expire | Playback stalls | Refresh URL cache every 5 hours; re-fetch on 404 |
| Windows IPC hangs | Agent blocked | Named pipe timeout + graceful degradation |
| Agent misconceptions | Misuse | Clear MCP tool descriptions |

## Timeline

- **Week 1 (P0 phases 1–4)**: Bootstrap, MCP server, mpv, YouTube (dependencies resolved)
- **Week 2 (P1 phases 5–7)**: Dashboard, mood mode, queue, publish to npm

## Review & Iteration

- Weekly sync with agent developers (if available)
- Post-MVP: Gather usage metrics, mood preset feedback
- Plan Spotify integration for v0.2 if demand warrants
