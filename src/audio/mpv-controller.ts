import { EventEmitter } from 'node:events';
import { getIpcPath } from './platform-ipc-path.js';
import { isMpvInstalled, resolvePreferredMpvBinary } from './mpv-launch-helpers.js';
import { createMpvProcessSession, type MpvProcessExitEvent, type MpvPropertyChangeEvent, type MpvProcessSession } from './mpv-process-session.js';

export const MPV_STARTUP_WARMUP_MS = 500;

export interface TrackMeta {
  id: string; title: string; artist?: string; duration?: number; thumbnail?: string;
}

type MpvState = {
  currentTrack: TrackMeta | null;
  isMuted: boolean;
  isPlaying: boolean;
  volume: number;
};

export async function waitForMpvStartupWarmup(durationMs = MPV_STARTUP_WARMUP_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, durationMs));
}

export class MpvController extends EventEmitter {
  private commandQueue = Promise.resolve();
  private destroying = false;
  private initialized = false;
  private pendingStoppedEvent = false;
  private session: MpvProcessSession | null = null;
  private readonly state: MpvState;
  // Count of idle-active events to silently discard (set via suppressNextStopped).
  // Prevents stale stop-originated events from corrupting the active track state.
  private suppressStoppedCount = 0;

  constructor(initialVolume = 80) {
    super();
    this.state = {
      currentTrack: null,
      isMuted: false,
      isPlaying: false,
      volume: clampVolume(initialVolume),
    };
  }

  init(): void {
    if (this.initialized) return;

    if (!isMpvInstalled()) {
      throw new Error(
        'mpv is not installed or not in PATH. ' +
        'Install: brew install mpv (macOS), apt install mpv (Linux), scoop install mpv (Windows)',
      );
    }

    const ipcPath = getIpcPath();
    console.error('[mpv] Initializing with IPC path:', ipcPath);

    this.session = createMpvProcessSession({
      binary: resolvePreferredMpvBinary(),
      ipcPath,
    });
    this.attachSessionEvents(this.session);
    this.session.start();
    this.initialized = true;
    this.emitStateChange();
    this.enqueueSessionCommand('set initial volume', () => this.session!.setVolume(this.state.volume));
    console.error('[mpv] Ready — headless audio engine started');
  }

  isReady(): boolean {
    return this.initialized && this.session !== null;
  }

  play(url: string, meta: TrackMeta): void {
    this.pendingStoppedEvent = false;
    this.state.currentTrack = meta;
    this.state.isPlaying = true;
    this.emitStateChange();
    console.error('[mpv] Playing:', meta.title);
    this.enqueueSessionCommand('load file', () => this.ensureSession().loadFile(url));
  }

  pause(): void {
    this.state.isPlaying = false;
    this.emitStateChange();
    console.error('[mpv] Paused');
    this.enqueueSessionCommand('pause playback', () => this.ensureSession().setPause(true));
  }

  resume(): void {
    this.state.isPlaying = this.state.currentTrack !== null;
    this.emitStateChange();
    console.error('[mpv] Resumed');
    this.enqueueSessionCommand('resume playback', () => this.ensureSession().setPause(false));
  }

  stop(): void {
    if (!this.state.currentTrack) return;

    this.pendingStoppedEvent = true;
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    this.emitStateChange();
    console.error('[mpv] Stopped');
    this.enqueueSessionCommand('stop playback', () => this.ensureSession().stop());
  }

  setVolume(level: number): number {
    const clamped = clampVolume(level);
    this.state.volume = clamped;
    this.emitStateChange();
    console.error('[mpv] Volume set to:', clamped);
    this.enqueueSessionCommand('set volume', () => this.ensureSession().setVolume(clamped));
    return clamped;
  }

  getVolume(): number { return this.state.volume; }

  toggleMute(): boolean {
    this.state.isMuted = !this.state.isMuted;
    this.emitStateChange();
    console.error('[mpv] Mute toggled:', this.state.isMuted);
    this.enqueueSessionCommand('toggle mute', () => this.ensureSession().setMute(this.state.isMuted));
    return this.state.isMuted;
  }

  getIsMuted(): boolean { return this.state.isMuted; }

  async getPosition(): Promise<number> {
    const session = this.ensureSession();
    try {
      const position = await session.getProperty('time-pos');
      return typeof position === 'number' ? position : 0;
    } catch {
      return 0;
    }
  }

  async getDuration(): Promise<number> {
    const session = this.ensureSession();
    try {
      const duration = await session.getProperty('duration');
      return typeof duration === 'number' ? duration : 0;
    } catch {
      return 0;
    }
  }

  /** Tell the controller to silently discard the next N idle-active stopped events. */
  suppressNextStopped(): void {
    this.suppressStoppedCount++;
  }

  getCurrentTrack(): TrackMeta | null { return this.state.currentTrack; }

  getIsPlaying(): boolean { return this.state.isPlaying; }

  getState(): Readonly<MpvState> { return this.state; }

  destroy(): void {
    this.destroying = true;
    this.session?.destroy();
    this.session = null;
    this.initialized = false;
    this.pendingStoppedEvent = false;
    this.suppressStoppedCount = 0;
    this.state.currentTrack = null;
    this.state.isMuted = false;
    this.state.isPlaying = false;
    this.emitStateChange();
    this.removeAllListeners();
    controller = null;
    console.error('[mpv] Destroyed');
  }

  private attachSessionEvents(session: MpvProcessSession): void {
    session.on('property-change', (event: MpvPropertyChangeEvent) => {
      if (event.name === 'pause' && typeof event.data === 'boolean') {
        this.state.isPlaying = event.data ? false : this.state.currentTrack !== null;
        this.emitStateChange();
        this.emit(event.data ? 'paused' : 'resumed');
        return;
      }

      if (event.name === 'idle-active' && event.data === true) {
        this.handleStoppedEvent();
      }
    });

    session.on('exit', (event: MpvProcessExitEvent) => {
      this.handleSessionExit(event);
    });
  }

  private emitStateChange(): void {
    this.emit('state-change', this.state);
  }

  private enqueueSessionCommand(context: string, operation: () => Promise<void>): void {
    const nextCommand = this.commandQueue.then(operation, operation);
    this.commandQueue = nextCommand.catch(() => undefined);
    void nextCommand.catch((error: Error) => {
      console.error(`[mpv] Failed to ${context}:`, error.message);
    });
  }

  private ensureSession(): MpvProcessSession {
    if (!this.session || !this.initialized) throw new Error('mpv not initialized — call init() first');
    return this.session;
  }

  private handleSessionExit(event: MpvProcessExitEvent): void {
    if (this.destroying) return;

    this.session = null;
    this.initialized = false;
    this.pendingStoppedEvent = false;
    this.suppressStoppedCount = 0;
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    this.emitStateChange();
    console.error('[mpv] Process exited unexpectedly:', { code: event.code, signal: event.signal });
  }

  private handleStoppedEvent(): void {
    // Discard stale idle-active events from a previous stop() that was
    // followed by a new play() before mpv processed the stop IPC command.
    if (this.suppressStoppedCount > 0) {
      this.suppressStoppedCount--;
      this.pendingStoppedEvent = false;
      return;
    }

    if (!this.pendingStoppedEvent && !this.state.currentTrack) return;

    this.pendingStoppedEvent = false;
    this.state.currentTrack = null;
    this.state.isPlaying = false;
    this.emitStateChange();
    this.emit('stopped');
  }
}

let controller: MpvController | null = null;

export function createMpvController(initialVolume = 80): MpvController {
  if (!controller) controller = new MpvController(initialVolume);
  return controller;
}

export function getMpvController(): MpvController | null { return controller; }

function clampVolume(level: number): number {
  return Math.max(0, Math.min(100, Math.round(level)));
}
