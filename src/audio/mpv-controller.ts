// mpv IPC wrapper — controls headless mpv for audio playback
// Uses node-mpv for abstracted IPC communication with mpv process

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

  async init(): Promise<void> {
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

    try {
      await this.player.start();
      await this.player.volume(this.state.volume);
      this.initialized = true;
      console.error('[mpv] Ready — headless audio engine started');
    } catch (err) {
      this.player = null;
      throw new Error(`mpv failed to start: ${(err as Error).message}`);
    }
  }

  isReady(): boolean {
    return this.initialized && this.player !== null;
  }

  // Ensure mpv is initialized before any operation
  private ensureReady(): mpvAPI {
    if (!this.player || !this.initialized) {
      throw new Error('mpv not initialized — call init() first');
    }
    return this.player;
  }

  async play(url: string, meta: TrackMeta): Promise<void> {
    const player = this.ensureReady();
    await player.load(url);
    this.state.currentTrack = meta;
    this.state.isPlaying = true;
    console.error('[mpv] Playing:', meta.title);
  }

  async pause(): Promise<void> {
    const player = this.ensureReady();
    await player.pause();
    this.state.isPlaying = false;
    console.error('[mpv] Paused');
  }

  async resume(): Promise<void> {
    const player = this.ensureReady();
    await player.resume();
    this.state.isPlaying = true;
    console.error('[mpv] Resumed');
  }

  async stop(): Promise<void> {
    const player = this.ensureReady();
    await player.stop();
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    console.error('[mpv] Stopped');
  }

  async setVolume(level: number): Promise<number> {
    const player = this.ensureReady();
    const clamped = Math.max(0, Math.min(100, level));
    await player.volume(clamped);
    this.state.volume = clamped;
    console.error('[mpv] Volume set to:', clamped);
    return clamped;
  }

  async getVolume(): Promise<number> {
    return this.state.volume;
  }

  async getPosition(): Promise<number> {
    const player = this.ensureReady();
    try {
      const pos = await player.getTimePosition();
      return pos ?? 0;
    } catch {
      return 0;
    }
  }

  async getDuration(): Promise<number> {
    const player = this.ensureReady();
    try {
      const dur = await player.getDuration();
      return dur ?? 0;
    } catch {
      return 0;
    }
  }

  async getCurrentTrack(): Promise<TrackMeta | null> {
    return this.state.currentTrack;
  }

  async getIsPlaying(): Promise<boolean> {
    return this.state.isPlaying;
  }

  async destroy(): Promise<void> {
    if (this.player) {
      try {
        await this.player.quit();
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
