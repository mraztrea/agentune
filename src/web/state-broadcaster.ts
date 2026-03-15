import { EventEmitter } from 'events';
import type { TrackMeta, MpvController } from '../audio/mpv-controller.js';
import type { QueueManager } from '../queue/queue-manager.js';

export interface DashboardQueueItem {
  title: string;
  artist: string;
}

export interface DashboardState {
  playing: boolean;
  title: string | null;
  artist: string | null;
  thumbnail: string | null;
  position: number;
  duration: number;
  volume: number;
  muted: boolean;
  queue: DashboardQueueItem[];
  mood: string | null;
}

function mapTrack(track: TrackMeta | null) {
  if (!track) {
    return { title: null, artist: null, thumbnail: null, duration: 0, mood: null };
  }

  return {
    title: track.title,
    artist: track.artist ?? 'Unknown',
    thumbnail: track.thumbnail ?? null,
    duration: track.duration ?? 0,
    mood: track.mood ?? null,
  };
}

export class StateBroadcaster extends EventEmitter {
  private lastSerializedState = '';
  private positionTimer: NodeJS.Timeout;
  private state: DashboardState;

  constructor(
    private readonly mpv: MpvController,
    private readonly queueManager: QueueManager,
  ) {
    super();
    this.state = this.createBaseState();
    this.positionTimer = setInterval(() => {
      void this.refresh();
    }, 1000);

    this.mpv.on('state-change', () => {
      void this.refresh();
    });
    this.queueManager.on('state-change', () => {
      void this.refresh();
    });
  }

  getState(): DashboardState {
    return this.state;
  }

  async refresh(): Promise<void> {
    const nextState = await this.buildState();
    const serialized = JSON.stringify(nextState);
    if (serialized === this.lastSerializedState) {
      return;
    }

    this.state = nextState;
    this.lastSerializedState = serialized;
    this.emit('state', this.state);
  }

  destroy(): void {
    clearInterval(this.positionTimer);
  }

  private createBaseState(): DashboardState {
    return {
      playing: false,
      title: null,
      artist: null,
      thumbnail: null,
      position: 0,
      duration: 0,
      volume: this.mpv.getVolume(),
      muted: this.mpv.getIsMuted(),
      queue: this.queueManager.list().map((item) => ({ title: item.title, artist: item.artist })),
      mood: null,
    };
  }

  private async buildState(): Promise<DashboardState> {
    const snapshot = this.mpv.getState();
    const track = mapTrack(snapshot.currentTrack);
    const position = snapshot.currentTrack && this.mpv.isReady()
      ? Math.max(0, Math.round(await this.mpv.getPosition()))
      : 0;

    return {
      playing: snapshot.isPlaying,
      title: track.title,
      artist: track.artist,
      thumbnail: track.thumbnail,
      position,
      duration: Math.max(position, Math.round(track.duration)),
      volume: snapshot.volume,
      muted: snapshot.isMuted,
      queue: this.queueManager.list().map((item) => ({ title: item.title, artist: item.artist })),
      mood: track.mood,
    };
  }
}
