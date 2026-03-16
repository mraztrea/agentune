import type { MpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import { normalizeTrackId } from '../history/history-schema.js';
import { getAppleSearchProvider } from '../providers/apple-search-provider.js';
import type { AudioInfo, YouTubeProvider } from '../providers/youtube-provider.js';
import type { SearchResult } from '../providers/youtube-provider.js';
import { getTasteEngine } from '../taste/taste-engine.js';
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

  async playById(
    id: string,
    extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string },
  ): Promise<QueueItem> {
    const resolved = await this.resolveQueueItem(id, extraMeta);
    this.startPlayback(resolved.item, resolved.audio, extraMeta);
    return resolved.item;
  }

  async addById(
    id: string,
    extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string },
  ): Promise<{ item: QueueItem; action: 'queued'; position: number; startedPlayback: boolean }> {
    const resolved = await this.resolveQueueItem(id, extraMeta);
    const position = this.queueManager.add(resolved.item);

    if (!this.queueManager.getNowPlaying()) {
      await this.playNextQueuedTrack();
      return { item: resolved.item, action: 'queued', position, startedPlayback: true };
    }

    return { item: resolved.item, action: 'queued', position, startedPlayback: false };
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
    // Record skip in history + taste feedback before stopping
    if (this.currentPlayId !== null) {
      try {
        const store = getHistoryStore();
        const nowPlaying = this.queueManager.getNowPlaying();
        if (store) {
          const position = await this.mpv.getPosition().catch(() => 0);
          store.updatePlay(this.currentPlayId, { played_sec: Math.round(position), skipped: true });

          // Taste feedback: skip signal
          if (nowPlaying) {
            getTasteEngine()?.processFeedback(
              { artist: nowPlaying.artist, title: nowPlaying.title, duration: nowPlaying.duration },
              Math.round(position),
              nowPlaying.duration,
              true,
            );
          }
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

    // Record natural finish in history + taste feedback
    if (this.currentPlayId !== null) {
      try {
        const store = getHistoryStore();
        const nowPlaying = this.queueManager.getNowPlaying();
        if (store && nowPlaying) {
          store.updatePlay(this.currentPlayId, { played_sec: nowPlaying.duration, skipped: false });

          // Taste feedback: full play signal
          getTasteEngine()?.processFeedback(
            { artist: nowPlaying.artist, title: nowPlaying.title, duration: nowPlaying.duration },
            nowPlaying.duration,
            nowPlaying.duration,
            false,
          );
        }
      } catch (err) {
        console.error('[sbotify] Failed to record finish:', (err as Error).message);
      }
      this.currentPlayId = null;
    }

    this.queueManager.finishCurrentTrack();
    await this.playNextQueuedTrack();
  }

  /** Fetch genre from Apple iTunes and update track tags (fire-and-forget). */
  private async enrichTrackTags(artist: string, title: string): Promise<void> {
    const apple = getAppleSearchProvider();
    const store = getHistoryStore();
    if (!apple || !store) return;

    try {
      const genres = await apple.getTrackGenre(artist, title);
      if (genres.length === 0) return;
      const trackId = normalizeTrackId(artist, title);
      store.updateTrackTags(trackId, genres);
    } catch (err) {
      console.error('[sbotify] Tag enrichment failed:', (err as Error).message);
    }
  }

  private async playNextQueuedTrack(): Promise<QueueItem | null> {
    const nextItem = this.queueManager.next();
    if (!nextItem) {
      this.queueManager.clearNowPlaying();
      return null;
    }

    return await this.playById(nextItem.id, {
      context: nextItem.context,
      canonicalArtist: nextItem.artist,
      canonicalTitle: nextItem.title,
    });
  }

  private async resolveQueueItem(
    id: string,
    extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string },
  ): Promise<{ item: QueueItem; audio: AudioInfo }> {
    const audio = await this.youtubeProvider.getAudioUrl(id);
    return {
      audio,
      item: {
        id,
        title: extraMeta?.canonicalTitle ?? audio.title,
        artist: extraMeta?.canonicalArtist ?? audio.artist,
        duration: audio.duration,
        thumbnail: audio.thumbnail,
        url: `https://www.youtube.com/watch?v=${id}`,
        context: extraMeta?.context,
      },
    };
  }

  private async recordInterruptedPlay(): Promise<void> {
    if (this.currentPlayId === null) return;

    try {
      const store = getHistoryStore();
      const nowPlaying = this.queueManager.getNowPlaying();
      if (store && nowPlaying) {
        const position = await this.mpv.getPosition().catch(() => 0);
        store.updatePlay(this.currentPlayId, { played_sec: Math.round(position), skipped: true });
        getTasteEngine()?.processFeedback(
          { artist: nowPlaying.artist, title: nowPlaying.title, duration: nowPlaying.duration },
          Math.round(position),
          nowPlaying.duration,
          true,
        );
      }
    } catch (err) {
      console.error('[sbotify] Failed to record interrupted play:', (err as Error).message);
    }

    this.currentPlayId = null;
  }

  private startPlayback(
    queueItem: QueueItem,
    audio: AudioInfo,
    extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string },
  ): void {
    this.mpv.play(audio.streamUrl, queueItem);
    this.queueManager.setNowPlaying(queueItem);
    getWebServer()?.openDashboardOnce();

    try {
      const store = getHistoryStore();
      if (store) {
        const canonical = extraMeta?.canonicalArtist && extraMeta?.canonicalTitle
          ? { artist: extraMeta.canonicalArtist, title: extraMeta.canonicalTitle }
          : undefined;
        this.currentPlayId = store.recordPlay(
          {
            title: queueItem.title,
            artist: queueItem.artist,
            duration: queueItem.duration,
            thumbnail: queueItem.thumbnail,
            ytVideoId: queueItem.id,
          },
          { context: queueItem.context, source: 'playById' },
          canonical,
        );
      }
    } catch (err) {
      console.error('[sbotify] Failed to record play:', (err as Error).message);
    }

    this.enrichTrackTags(queueItem.artist, queueItem.title);
  }

  async replaceCurrentTrack(
    id: string,
    extraMeta?: { context?: string; canonicalArtist?: string; canonicalTitle?: string },
  ): Promise<QueueItem> {
    await this.recordInterruptedPlay();
    const resolved = await this.resolveQueueItem(id, extraMeta);
    this.startPlayback(resolved.item, resolved.audio, extraMeta);
    return resolved.item;
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
