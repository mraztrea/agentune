# agentune

**Music Player for Agent.**

agentune is a local MCP music player for Claude Code, Codex, and OpenCode. Your agent can discover tracks, play instantly, queue the next song, and keep one shared listening session running while you work.

> CLI-only package: install and run `agentune` as a command. Programmatic `import "agentune"` is not a supported interface.

## Why agentune

- **Zero-auth setup**: no Spotify login, no Apple Music login, no API keys
- **Background play**: audio runs through `mpv`, not a browser tab
- **Auto start**: the daemon can start itself when your agent connects
- **Shared session**: queue, history, taste state, and dashboard stay in one local daemon
- **Browser dashboard**: live now-playing, queue, volume, taste, and listening insights
- **Cross-platform**: works on Windows, macOS, and Linux

## Prerequisites

- Node.js 20+
- `mpv`
- `yt-dlp`

### macOS

```bash
brew install mpv yt-dlp
```

### Ubuntu / Debian

```bash
sudo apt-get install mpv python3-pip
pip install yt-dlp
```

### Windows

```bash
scoop install mpv yt-dlp
```

## Quick Start

### 1. Install agentune

```bash
npm install -g agentune
agentune --version
```

### 2. Connect your agent

#### Claude Code

```bash
claude mcp add agentune --scope user -- agentune
```

#### Codex

```bash
codex mcp add agentune -- agentune
```

#### OpenCode

Add this to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agentune": {
      "type": "local",
      "command": ["agentune"],
      "enabled": true
    }
  }
}
```

### 3. Start your coding session

Your MCP client launches `agentune` automatically. The dashboard is available at `http://localhost:3737` after the first connection.

Useful daemon commands:

```bash
agentune --help
agentune start
agentune stop
```

Use `agentune start` when you want the background daemon running before your agent connects, or when `autoStartDaemon` is disabled.

### 4. Send your first prompts

```text
play some musics. id like Vietnamese song only, V-Pop, Indie, RAP, Ballad.
play some musics.
```

You can also ask for:

```text
what song is playing now?
skip this one.
turn volume down to 60.
pause the music.
resume playback.
```

## Main Capabilities

- Let the agent discover music from your current taste and listening history
- Play a song immediately or add it to the queue
- Pause, resume, skip, and adjust volume
- Check what is playing right now
- Review recent listening history
- Update the taste/persona text the agent uses for future picks

## Browser Dashboard

Open `http://localhost:3737` to see:

- now-playing track and progress
- pause/resume and next controls
- volume slider
- live queue
- listening insights from local history
- taste editor
- cleanup actions and explicit daemon stop

## Runtime Notes

On first run, agentune creates `${AGENTUNE_DATA_DIR || ~/.agentune}/config.json`.

Most useful settings:

- `dashboardPort`: browser dashboard port, default `3737`
- `daemonPort`: local daemon port, default `3747`
- `defaultVolume`: initial playback volume
- `autoStartDaemon`: automatically start the daemon when your agent connects

If `autoStartDaemon` is `false`, start the daemon yourself before connecting:

```bash
agentune start
```

The daemon keeps playing in the background after the agent session closes. It stops only when you run `agentune stop` or click `Stop daemon` in the dashboard.

## More Docs

- [Project overview](./docs/project-overview-pdr.md)
- [System architecture](./docs/system-architecture.md)
- [Codebase summary](./docs/codebase-summary.md)

## License

MIT
