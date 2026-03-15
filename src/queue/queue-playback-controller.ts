import type { MpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import type { Mood } from '../mood/mood-presets.js';
import type { YouTubeProvider } from '../providers/youtube-provider.js';
import type { SearchResult } from '../providers/youtube-provider.js';
import { getWebServer } from '../web/web-server.js';
import type { QueueItem, QueueManager } from './queue-manager.js';

function mapSearchResultToQueueItem(result: SearchResult): QueueItem {
  return {
    id: result.id,
    title: result.title,
    artist: result.artist,
    duration: Math.round(result.durationMs / 1000),
    thumbnail: result.thumbnail,
    url: result.url,
  };
}

export class QueuePlaybackController {
  private suppressStoppedHandler = false;
  private shuttingDown = false;
  private currentPlayId: number | null = null;

  constructor(
    private readonly mpv: MpvController,
    private readonly queueManager: QueueManager,
    private readonly youtubeProvider: YouTubeProvider,
  ) {
    this.mpv.on('stopped', () => {
      void this.handleStopped();
    });
  }

  async playById(id: string, extraMeta?: { mood?: Mood }): Promise<QueueItem> {
    const audio = await this.youtubeProvider.getAudioUrl(id);
    const queueItem: QueueItem = {
      id,
      title: audio.title,
      artist: audio.artist,
      duration: audio.duration,
      thumbnail: audio.thumbnail,
      url: `https://www.youtube.com/watch?v=${id}`,
      ...extraMeta,
    };

    this.mpv.play(audio.streamUrl, queueItem);
    this.queueManager.setNowPlaying(queueItem);
    getWebServer()?.openDashboardOnce();

    // Record play in history store
    try {
      const store = getHistoryStore();
      if (store) {
        this.currentPlayId = store.recordPlay(
          { title: queueItem.title, artist: queueItem.artist, duration: queueItem.duration, thumbnail: queueItem.thumbnail, ytVideoId: id },
          { mood: queueItem.mood, source: 'playById' },
        );
      }
    } catch (err) {
      console.error('[sbotify] Failed to record play:', (err as Error).message);
    }

    return queueItem;
  }

  async queueByQuery(query: string): Promise<{ item: QueueItem; position: number }> {
    const results = await this.youtubeProvider.search(query, 1);
    if (results.length === 0) {
      throw new Error(`No results found for "${query}".`);
    }

    const item = mapSearchResultToQueueItem(results[0]);
    const position = this.queueManager.add(item);
    return { item, position };
  }

  async skip(): Promise<QueueItem | null> {
    // Record skip in history before stopping
    if (this.currentPlayId !== null) {
      try {
        const store = getHistoryStore();
        if (store) {
          const position = await this.mpv.getPosition().catch(() => 0);
          store.updatePlay(this.currentPlayId, { played_sec: Math.round(position), skipped: true });
        }
      } catch (err) {
        console.error('[sbotify] Failed to record skip:', (err as Error).message);
      }
      this.currentPlayId = null;
    }

    if (this.queueManager.getNowPlaying()) {
      this.queueManager.finishCurrentTrack();
      this.suppressStoppedHandler = true;
      this.mpv.stop();
    }

    return await this.playNextQueuedTrack();
  }

  listQueue(): QueueItem[] {
    return this.queueManager.list();
  }

  clearForShutdown(): void {
    this.shuttingDown = true;
  }

  private async handleStopped(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }

    if (this.suppressStoppedHandler) {
      this.suppressStoppedHandler = false;
      return;
    }

    // Record natural finish in history — use track duration since mpv resets position on stop
    if (this.currentPlayId !== null) {
      try {
        const store = getHistoryStore();
        const nowPlaying = this.queueManager.getNowPlaying();
        if (store && nowPlaying) {
          store.updatePlay(this.currentPlayId, { played_sec: nowPlaying.duration, skipped: false });
        }
      } catch (err) {
        console.error('[sbotify] Failed to record finish:', (err as Error).message);
      }
      this.currentPlayId = null;
    }

    this.queueManager.finishCurrentTrack();
    await this.playNextQueuedTrack();
  }

  private async playNextQueuedTrack(): Promise<QueueItem | null> {
    const nextItem = this.queueManager.next();
    if (!nextItem) {
      this.queueManager.clearNowPlaying();
      return null;
    }

    return await this.playById(nextItem.id, { mood: nextItem.mood });
  }
}

let queuePlaybackController: QueuePlaybackController | null = null;

export function createQueuePlaybackController(
  mpv: MpvController,
  queueManager: QueueManager,
  youtubeProvider: YouTubeProvider,
): QueuePlaybackController {
  if (!queuePlaybackController) {
    queuePlaybackController = new QueuePlaybackController(mpv, queueManager, youtubeProvider);
  }
  return queuePlaybackController;
}

export function getQueuePlaybackController(): QueuePlaybackController | null {
  return queuePlaybackController;
}
