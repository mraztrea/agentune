# sbotify

**MCP music server — let your coding agent be your DJ.**

sbotify is a Model Context Protocol (MCP) server that enables coding agents (Claude Code, Cursor, Codex) to control music playback like a professional DJ. Search YouTube, play songs, manage queues, and set moods — all through natural language while your agent writes code.

## Features

- **Agent-driven music control**: Search, play, skip, queue songs via MCP protocol
- **Discovery pipeline**: 4-lane intelligent suggestions (continuation, comfort, context-fit, wildcard) with 8-term scoring
- **Browser dashboard**: Real-time now-playing info + volume slider on localhost:3737
- **Headless playback**: Audio plays independently via mpv (no browser needed)
- **Cross-platform**: Works on Windows, macOS, Linux
- **YouTube MVP**: No API keys required; uses @distube/ytsr + yt-dlp

## Quick Start

### Prerequisites

- Node.js 20+
- mpv (audio engine)
- yt-dlp (audio extraction)

**macOS:**
```bash
brew install mpv yt-dlp
npm install -g sbotify
```

**Ubuntu/Debian:**
```bash
sudo apt-get install mpv python3-pip
pip install yt-dlp
npm install -g sbotify
```

**Windows:**
```bash
# Install via scoop or download binaries
scoop install mpv yt-dlp
npm install -g sbotify
```

### Start the Server

```bash
sbotify
# Listens on stdio for MCP (agent) + HTTP on localhost:3737 (browser)
```

### MCP Configuration (Claude Code)

Add to your `Claude.md` or claude config:

```json
{
  "mcpServers": {
    "sbotify": {
      "command": "sbotify",
      "args": [],
      "disabled": false
    }
  }
}
```

Then ask Claude Code:
> "Play relaxing lo-fi beats for focus"
> "What song is playing?"
> "Skip to the next track"

### Browser Dashboard

Open http://localhost:3737 in your browser to see:
- Now-playing track (title, artist, progress)
- Volume slider
- Live queue preview
- Session lane info (current tag context)

## Architecture Overview

```
Coding Agent (Claude Code/Cursor)
    │ stdio (MCP Protocol)
    ▼
┌─────────────────────────────────────┐
│    sbotify MCP Server (Node.js)     │
├─────────────────────────────────────┤
│  • MCP Tool Definitions (Phase 2)   │
│  • mpv Audio Engine (Phase 3)       │
│  • YouTube Provider (Phase 4)       │
│  • Queue Manager (Phase 7)          │
└─────────────────────────────────────┘
    │                              │
    │ JSON IPC pipes/sockets       │ HTTP + WebSocket
    ▼                              ▼
   mpv (headless)            Browser Dashboard
   (audio playback)          (localhost:3737)
```

## Key Design Principles

1. **Never console.log()** — corrupts MCP stdio protocol. Use `console.error()` for debug.
2. **IPC Protocol**: Named pipes on Windows (`\\.\pipe\sbotify`), Unix sockets on Unix (`/tmp/sbotify-mpv`)
3. **Error Handling**: Return `{isError: true, message: "..."}` instead of throwing
4. **Stream URLs**: YouTube streams expire after ~6 hours; always fetch fresh

## Documentation

- **[Project Overview & PDR](./docs/project-overview-pdr.md)** — Goals, MVP scope, target users
- **[Codebase Summary](./docs/codebase-summary.md)** — Directory structure, module responsibilities
- **[Code Standards](./docs/code-standards.md)** — TypeScript conventions, ESM rules, naming patterns
- **[System Architecture](./docs/system-architecture.md)** — Component interactions, IPC protocol details
- **[Project Roadmap](./docs/project-roadmap.md)** — Phase timeline, milestones, progress
- **[Project Changelog](./docs/project-changelog.md)** — Significant implementation changes and validation notes

## Development

```bash
# Install dependencies
npm install

# Watch TypeScript compilation
npm run dev

# Build
npm run build

# Start locally
npm start
```

## Phase Timeline

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Project setup | ✓ Complete |
| 2 | MCP server + tool definitions | ✓ Complete |
| 3 | Audio engine (mpv) | ✓ Complete |
| 4 | YouTube provider | ✓ Complete |
| 5 | Browser dashboard | ✓ Complete |
| 6 | Mood mode | ✓ Complete |
| 7 | Queue + polish + release prep | ✓ Complete |

See [Project Roadmap](./docs/project-roadmap.md) for detailed timelines and dependencies.

## Success Criteria

- Agent can search, play, skip, queue songs **without human intervention**
- Browser dashboard displays now-playing + volume control
- Audio plays **independently** (mpv headless mode)
- **< 3 seconds** from "play" command to audio output
- Works on **Windows, macOS, Linux**
- **npm install -g sbotify** prepared (publish intentionally deferred)

## Contributing

See [Code Standards](./docs/code-standards.md) for contribution guidelines, TypeScript conventions, and code review process.

## License

MIT

## Questions?

See [Codebase Summary](./docs/codebase-summary.md) for architecture details or [System Architecture](./docs/system-architecture.md) for protocol specifications.
