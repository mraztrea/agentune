// mpv IPC wrapper — controls headless mpv for audio playback
// Uses node-mpv v1.5 which spawns mpv in constructor; methods are sync socket commands

import mpvAPI from 'node-mpv';
import { execSync } from 'child_process';
import { unlinkSync } from 'fs';
import { getIpcPath } from './platform-ipc-path.js';

export interface TrackMeta {
  id: string;
  title: string;
  artist?: string;
  duration?: number;
  thumbnail?: string;
}

interface MpvState {
  currentTrack: TrackMeta | null;
  isPlaying: boolean;
  volume: number;
}

// Detect if mpv binary is available in PATH
function isMpvInstalled(): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where mpv' : 'which mpv';
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export class MpvController {
  private player: mpvAPI | null = null;
  private state: MpvState = {
    currentTrack: null,
    isPlaying: false,
    volume: 80,
  };
  private initialized = false;

  // node-mpv v1.5 spawns mpv in constructor — no start() method
  init(): void {
    if (this.initialized) return;

    if (!isMpvInstalled()) {
      throw new Error(
        'mpv is not installed or not in PATH. ' +
        'Install: brew install mpv (macOS), apt install mpv (Linux), scoop install mpv (Windows)'
      );
    }

    const ipcPath = getIpcPath();
    console.error('[mpv] Initializing with IPC path:', ipcPath);

    // Clean up stale Unix socket from previous crash (Windows pipes auto-clean)
    if (process.platform !== 'win32') {
      try { unlinkSync(ipcPath); } catch { /* no stale socket */ }
    }

    // mpv process spawns here in the constructor
    this.player = new mpvAPI({
      audio_only: true,
      auto_restart: true,
      ipc_command: '--input-ipc-server',
      socket: ipcPath,
    }, [
      '--no-video',
      '--idle',
      '--no-config',
    ]);

    this.player.volume(this.state.volume);
    this.initialized = true;
    console.error('[mpv] Ready — headless audio engine started');
  }

  isReady(): boolean {
    return this.initialized && this.player !== null;
  }

  private ensureReady(): mpvAPI {
    if (!this.player || !this.initialized) {
      throw new Error('mpv not initialized — call init() first');
    }
    return this.player;
  }

  play(url: string, meta: TrackMeta): void {
    const player = this.ensureReady();
    player.load(url);
    this.state.currentTrack = meta;
    this.state.isPlaying = true;
    console.error('[mpv] Playing:', meta.title);
  }

  pause(): void {
    const player = this.ensureReady();
    player.pause();
    this.state.isPlaying = false;
    console.error('[mpv] Paused');
  }

  resume(): void {
    const player = this.ensureReady();
    player.resume();
    this.state.isPlaying = true;
    console.error('[mpv] Resumed');
  }

  stop(): void {
    const player = this.ensureReady();
    player.stop();
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    console.error('[mpv] Stopped');
  }

  setVolume(level: number): number {
    const player = this.ensureReady();
    const clamped = Math.max(0, Math.min(100, level));
    player.volume(clamped);
    this.state.volume = clamped;
    console.error('[mpv] Volume set to:', clamped);
    return clamped;
  }

  getVolume(): number {
    return this.state.volume;
  }

  async getPosition(): Promise<number> {
    const player = this.ensureReady();
    try {
      const pos = await player.getProperty('time-pos');
      return (pos as number) ?? 0;
    } catch {
      return 0;
    }
  }

  async getDuration(): Promise<number> {
    const player = this.ensureReady();
    try {
      const dur = await player.getProperty('duration');
      return (dur as number) ?? 0;
    } catch {
      return 0;
    }
  }

  getCurrentTrack(): TrackMeta | null {
    return this.state.currentTrack;
  }

  getIsPlaying(): boolean {
    return this.state.isPlaying;
  }

  destroy(): void {
    if (this.player) {
      try {
        this.player.quit();
      } catch {
        // mpv may already be gone
      }
      this.player = null;
      this.initialized = false;
      // Reset singleton so next createMpvController() creates fresh instance
      controller = null;
      console.error('[mpv] Destroyed');
    }
  }
}

// Singleton instance shared across the application
let controller: MpvController | null = null;

export function createMpvController(): MpvController {
  if (!controller) {
    controller = new MpvController();
  }
  return controller;
}

export function getMpvController(): MpvController | null {
  return controller;
}
