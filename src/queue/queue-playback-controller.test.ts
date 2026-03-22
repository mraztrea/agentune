import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import test from 'node:test';
import { QueuePlaybackController } from './queue-playback-controller.js';
import { QueueManager } from './queue-manager.js';

class FakeMpv extends EventEmitter {
  public playCalls: Array<{ url: string; meta: unknown }> = [];
  public resumeCalls = 0;
  public stopCalls = 0;
  public pauseProperty = false;
  public isPlaying = false;

  play(url: string, meta: unknown): void {
    this.playCalls.push({ url, meta });
    this.isPlaying = !this.pauseProperty;
  }

  stop(): void {
    this.stopCalls += 1;
    this.isPlaying = false;
  }

  resume(): void {
    this.resumeCalls += 1;
    this.pauseProperty = false;
    this.isPlaying = true;
  }

  pause(): void {
    this.pauseProperty = true;
    this.isPlaying = false;
  }

  suppressNextStopped(): void { /* no-op in test fake */ }

  emitStopped(): void {
    this.isPlaying = false;
    this.emit('stopped');
  }

  async getPosition(): Promise<number> {
    return 0;
  }
}

class FakeYouTubeProvider {
  async search(query: string): Promise<Array<{
    id: string;
    title: string;
    artist: string;
    duration: string;
    durationMs: number;
    thumbnail: string;
    url: string;
  }>> {
    return [{
      id: 'search-result',
      title: `${query} result`,
      artist: 'Search Artist',
      duration: '3:00',
      durationMs: 180000,
      thumbnail: 'thumb-search',
      url: 'https://youtube.test/search-result',
    }];
  }

  async getAudioUrl(id: string): Promise<{
    streamUrl: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
  }> {
    return {
      streamUrl: `https://stream.test/${id}`,
      title: `Track ${id}`,
      artist: `Artist ${id}`,
      duration: 180,
      thumbnail: `thumb-${id}`,
    };
  }
}

class SlowFakeYouTubeProvider extends FakeYouTubeProvider {
  override async getAudioUrl(id: string): Promise<{
    streamUrl: string;
    title: string;
    artist: string;
    duration: number;
    thumbnail: string;
  }> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return await super.getAudioUrl(id);
  }
}

test('QueuePlaybackController queues search results', async () => {
  const queueManager = new QueueManager();
  const controller = new QueuePlaybackController(
    new FakeMpv() as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  const queued = await controller.queueByQuery('focus music');

  assert.equal(queued.position, 1);
  assert.equal(queued.item.id, 'search-result');
  assert.deepEqual(queueManager.list().map((item) => item.id), ['search-result']);
});

test('QueuePlaybackController addById queues then starts playback when idle', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  const added = await controller.addById('resolved-song', {
    canonicalArtist: 'Canonical Artist',
    canonicalTitle: 'Canonical Title',
  });

  assert.equal(added.action, 'queued');
  assert.equal(added.position, 1);
  assert.equal(added.startedPlayback, true);
  assert.equal(queueManager.getNowPlaying()?.id, 'resolved-song');
  assert.equal(queueManager.getNowPlaying()?.artist, 'Canonical Artist');
  assert.equal(queueManager.list().length, 0);
  assert.equal(fakeMpv.playCalls.length, 1);
});

test('QueuePlaybackController addById queues when something is already playing', async () => {
  const queueManager = new QueueManager();
  const controller = new QueuePlaybackController(
    new FakeMpv() as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  queueManager.setNowPlaying({
    id: 'current',
    title: 'Current',
    artist: 'Current Artist',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  });

  const added = await controller.addById('queued-song', {
    canonicalArtist: 'Queued Artist',
    canonicalTitle: 'Queued Title',
  });

  assert.equal(added.action, 'queued');
  assert.equal(added.position, 1);
  assert.equal(added.startedPlayback, false);
  assert.equal(queueManager.getNowPlaying()?.id, 'current');
  assert.deepEqual(queueManager.list().map((item) => item.id), ['queued-song']);
  assert.equal(queueManager.list()[0].artist, 'Queued Artist');
});

test('QueuePlaybackController keeps every queued item when addById runs concurrently', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new SlowFakeYouTubeProvider() as never,
  );
  const ids = Array.from({ length: 20 }, (_, index) => `song-${index + 1}`);

  const added = await Promise.all(ids.map((id) => controller.addById(id, {
    canonicalArtist: `Artist ${id}`,
    canonicalTitle: `Title ${id}`,
  })));

  const state = queueManager.getState();
  const actualIds = [state.nowPlaying?.id, ...state.queue.map((item) => item.id)]
    .filter((id): id is string => Boolean(id))
    .sort();

  assert.equal(fakeMpv.playCalls.length, 1);
  assert.equal(added.filter((result) => result.startedPlayback).length, 1);
  assert.equal(state.queue.length, ids.length - 1);
  assert.deepEqual(actualIds, [...ids].sort());
});

test('QueuePlaybackController replaceCurrentTrack plays new track immediately', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  queueManager.setNowPlaying({
    id: 'current',
    title: 'Current',
    artist: 'Current Artist',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  });

  const nowPlaying = await controller.replaceCurrentTrack('replacement', {
    canonicalArtist: 'Replacement Artist',
    canonicalTitle: 'Replacement Title',
  });

  assert.equal(nowPlaying.id, 'replacement');
  assert.equal(queueManager.getNowPlaying()?.id, 'replacement');
  assert.equal(queueManager.getNowPlaying()?.artist, 'Replacement Artist');
  assert.equal(fakeMpv.playCalls.length, 1);
});

test('QueuePlaybackController skip plays the next queued track', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  queueManager.setNowPlaying({
    id: 'current',
    title: 'Current',
    artist: 'Artist current',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  });
  queueManager.add({
    id: 'next',
    title: 'Next',
    artist: 'Artist next',
    duration: 200,
    thumbnail: 'thumb-next',
    url: 'https://youtube.test/next',
  });

  const nextTrack = await controller.skip();

  assert.equal(fakeMpv.stopCalls, 1);
  assert.equal(nextTrack?.id, 'next');
  assert.equal(queueManager.getNowPlaying()?.id, 'next');
  assert.deepEqual(queueManager.getState().history.map((item) => item.id), ['current']);
});

test('QueuePlaybackController skip clears paused state before starting the next track', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  queueManager.setNowPlaying({
    id: 'current',
    title: 'Current',
    artist: 'Artist current',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  });
  queueManager.add({
    id: 'next',
    title: 'Next',
    artist: 'Artist next',
    duration: 200,
    thumbnail: 'thumb-next',
    url: 'https://youtube.test/next',
  });
  fakeMpv.pause();

  const nextTrack = await controller.skip();

  assert.equal(nextTrack?.id, 'next');
  assert.equal(fakeMpv.resumeCalls, 1);
  assert.equal(fakeMpv.isPlaying, true);
  assert.equal(queueManager.getNowPlaying()?.id, 'next');
});

test('QueuePlaybackController advances when playback stops naturally', async () => {
  const queueManager = new QueueManager();
  const fakeMpv = new FakeMpv();
  const controller = new QueuePlaybackController(
    fakeMpv as never,
    queueManager,
    new FakeYouTubeProvider() as never,
  );

  queueManager.setNowPlaying({
    id: 'current',
    title: 'Current',
    artist: 'Artist current',
    duration: 180,
    thumbnail: 'thumb-current',
    url: 'https://youtube.test/current',
  });
  queueManager.add({
    id: 'next',
    title: 'Next',
    artist: 'Artist next',
    duration: 200,
    thumbnail: 'thumb-next',
    url: 'https://youtube.test/next',
  });

  fakeMpv.emitStopped();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fakeMpv.playCalls.length, 1);
  assert.equal(queueManager.getNowPlaying()?.id, 'next');
  assert.deepEqual(queueManager.getState().history.map((item) => item.id), ['current']);
});
