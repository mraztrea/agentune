import type { MpvController } from '../audio/mpv-controller.js';
import { getHistoryStore } from '../history/history-store.js';
import { normalizeTrackId } from '../history/history-schema.js';
import { getAppleSearchProvider } from '../providers/apple-search-provider.js';
import type { AudioInfo, YouTubeProvider } from '../providers/youtube-provider.js';
import type { SearchResult } from '../providers/youtube-provider.js';
import { getWebServer } from '../web/web-server.js';
import type { QueueItem, QueueManager } from './queue-manager.js';

type PlaybackMeta = { context?: string; canonicalArtist?: string; canonicalTitle?: string };

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
  private shuttingDown = false;
  private currentPlayId: number | null = null;
  private playbackMutation = Promise.resolve();
  // Pre-fetched audio for the next queued track (keyed by video ID)
  private prefetchedAudio: { id: string; audio: AudioInfo } | null = null;
  private prefetchInProgress: string | null = null;
  // Monotonic counter incremented by operations that explicitly take over
  // playback transitions (skip, stop-reset, replace).  A stale handleStopped
  // callback whose captured generation doesn't match is silently discarded.
  private playGeneration = 0;

  constructor(
    private readonly mpv: MpvController,
    private readonly queueManager: QueueManager,
    private readonly youtubeProvider: YouTubeProvider,
  ) {
    this.mpv.on('stopped', () => {
      const gen = this.playGeneration;
      void this.handleStopped(gen);
    });
  }

  async playById(
    id: string,
    extraMeta?: PlaybackMeta,
  ): Promise<QueueItem> {
    const resolved = await this.resolveQueueItem(id, extraMeta);
    return await this.withPlaybackMutation(async () => {
      this.startPlayback(resolved.item, resolved.audio, extraMeta);
      return resolved.item;
    });
  }

  async addById(
    id: string,
    extraMeta?: PlaybackMeta,
  ): Promise<{ item: QueueItem; action: 'queued'; position: number; startedPlayback: boolean }> {
    const resolved = await this.resolveQueueItem(id, extraMeta);
    return await this.withPlaybackMutation(async () => {
      const position = this.queueManager.add(resolved.item);

      if (!this.queueManager.getNowPlaying()) {
        await this.playNextQueuedTrackLocked({
          id: resolved.item.id,
          audio: resolved.audio,
          extraMeta,
        });
        return { item: resolved.item, action: 'queued', position, startedPlayback: true };
      }

      // If this is the next-up track, pre-fetch its audio
      if (position === 1) this.prefetchNextTrack();
      return { item: resolved.item, action: 'queued', position, startedPlayback: false };
    });
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
    return await this.withPlaybackMutation(async () => {
      // Record skip in history + taste feedback before stopping
      if (this.currentPlayId !== null) {
        try {
          const store = getHistoryStore();
          const nowPlaying = this.queueManager.getNowPlaying();
          if (store && nowPlaying) {
            const position = await this.mpv.getPosition().catch(() => 0);
            store.updatePlay(this.currentPlayId, { played_sec: Math.round(position), skipped: true });
          }
        } catch (err) {
          console.error('[agentune] Failed to record skip:', (err as Error).message);
        }
        this.currentPlayId = null;
      }

      // Bump generation AFTER the getPosition() await above so that any
      // 'stopped' event captured during that yield carries the OLD generation
      // and will be discarded when it finally enters the mutex.
      this.playGeneration++;

      if (this.queueManager.getNowPlaying()) {
        this.queueManager.finishCurrentTrack();
      }
      // Guard suppress+stop on mpv state (not queue state) to prevent an
      // orphaned suppressStoppedCount when an idle-active event fires during
      // the `await getPosition()` above, clearing mpv.currentTrack before we
      // reach this point.  Without this guard, stop() early-returns but the
      // counter is already incremented, swallowing the *next* track's natural
      // finish event and freezing auto-advance.
      if (this.mpv.getCurrentTrack()) {
        this.mpv.suppressNextStopped();
        this.mpv.stop();
      }

      return await this.playNextQueuedTrackLocked();
    });
  }

  async stopAndResetRuntimeState(): Promise<void> {
    await this.withPlaybackMutation(async () => {
      this.playGeneration++;
      this.prefetchedAudio = null;
      this.prefetchInProgress = null;
      await this.recordInterruptedPlay();

      if (this.mpv.isReady() && this.mpv.getCurrentTrack()) {
        this.mpv.suppressNextStopped();
        this.mpv.stop();
      }

      this.queueManager.reset();
    });
  }

  listQueue(): QueueItem[] {
    return this.queueManager.list();
  }

  clearForShutdown(): void {
    this.shuttingDown = true;
  }

  private async handleStopped(generation: number): Promise<void> {
    await this.withPlaybackMutation(async () => {
      if (this.shuttingDown) {
        return;
      }

      // If another operation (skip, replace, stop-reset) already took over
      // the playback transition, this callback is stale — discard it.
      if (generation !== this.playGeneration) {
        return;
      }

      // Record natural finish in history + taste feedback
      if (this.currentPlayId !== null) {
        try {
          const store = getHistoryStore();
          const nowPlaying = this.queueManager.getNowPlaying();
          if (store && nowPlaying) {
            store.updatePlay(this.currentPlayId, { played_sec: nowPlaying.duration, skipped: false });
          }
        } catch (err) {
          console.error('[agentune] Failed to record finish:', (err as Error).message);
        }
        this.currentPlayId = null;
      }

      this.queueManager.finishCurrentTrack();
      await this.playNextQueuedTrackLocked();
    });
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
      console.error('[agentune] Tag enrichment failed:', (err as Error).message);
    }
  }

  private async playNextQueuedTrackLocked(
    prefetched?: { id: string; audio: AudioInfo; extraMeta?: PlaybackMeta },
  ): Promise<QueueItem | null> {
    const nextItem = this.queueManager.next();
    if (!nextItem) {
      this.queueManager.clearNowPlaying();
      return null;
    }

    if (prefetched && prefetched.id === nextItem.id) {
      this.startPlayback(nextItem, prefetched.audio, prefetched.extraMeta);
      return nextItem;
    }

    const nextExtraMeta = {
      context: nextItem.context,
      canonicalArtist: nextItem.artist,
      canonicalTitle: nextItem.title,
    };
    const resolved = await this.resolveQueueItem(nextItem.id, nextExtraMeta);
    this.startPlayback(resolved.item, resolved.audio, nextExtraMeta);
    return resolved.item;
  }

  private async resolveQueueItem(
    id: string,
    extraMeta?: PlaybackMeta,
  ): Promise<{ item: QueueItem; audio: AudioInfo }> {
    // Use pre-fetched audio if available for this track
    let audio: AudioInfo;
    if (this.prefetchedAudio && this.prefetchedAudio.id === id) {
      audio = this.prefetchedAudio.audio;
      this.prefetchedAudio = null;
      console.error('[agentune] Using pre-fetched audio for:', id);
    } else {
      audio = await this.youtubeProvider.getAudioUrl(id);
    }
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

  /** Pre-fetch the next queued track's audio URL in the background. */
  private prefetchNextTrack(): void {
    const nextItem = this.queueManager.peek();
    if (!nextItem) return;
    if (this.prefetchedAudio?.id === nextItem.id) return; // already cached
    if (this.prefetchInProgress === nextItem.id) return;  // already fetching

    this.prefetchInProgress = nextItem.id;
    console.error('[agentune] Pre-fetching audio for next track:', nextItem.title);

    this.youtubeProvider.getAudioUrl(nextItem.id).then((audio) => {
      // Only store if the queue hasn't changed
      if (this.queueManager.peek()?.id === nextItem.id) {
        this.prefetchedAudio = { id: nextItem.id, audio };
        console.error('[agentune] Pre-fetch complete for:', nextItem.title);
      }
    }).catch((err) => {
      console.error('[agentune] Pre-fetch failed:', (err as Error).message);
    }).finally(() => {
      this.prefetchInProgress = null;
    });
  }

  private async recordInterruptedPlay(): Promise<void> {
    if (this.currentPlayId === null) return;

    try {
      const store = getHistoryStore();
      const nowPlaying = this.queueManager.getNowPlaying();
      if (store && nowPlaying) {
        const position = await this.mpv.getPosition().catch(() => 0);
        store.updatePlay(this.currentPlayId, { played_sec: Math.round(position), skipped: true });
      }
    } catch (err) {
      console.error('[agentune] Failed to record interrupted play:', (err as Error).message);
    }

    this.currentPlayId = null;
  }

  private startPlayback(
    queueItem: QueueItem,
    audio: AudioInfo,
    extraMeta?: PlaybackMeta,
  ): void {
    // mpv keeps its pause property until explicitly cleared, so a paused track
    // followed by skip would otherwise load the next song in a paused state.
    this.mpv.resume();
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
      console.error('[agentune] Failed to record play:', (err as Error).message);
    }

    this.enrichTrackTags(queueItem.artist, queueItem.title);

    // Pre-fetch next track's audio URL for seamless transitions
    this.prefetchNextTrack();
  }

  async replaceCurrentTrack(
    id: string,
    extraMeta?: PlaybackMeta,
  ): Promise<QueueItem> {
    const resolved = await this.resolveQueueItem(id, extraMeta);
    return await this.withPlaybackMutation(async () => {
      this.playGeneration++;
      await this.recordInterruptedPlay();
      this.startPlayback(resolved.item, resolved.audio, extraMeta);
      return resolved.item;
    });
  }

  private async withPlaybackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.playbackMutation;
    let release!: () => void;
    this.playbackMutation = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
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
