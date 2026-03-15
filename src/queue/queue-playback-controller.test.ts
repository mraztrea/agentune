import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import test from 'node:test';
import { QueuePlaybackController } from './queue-playback-controller.js';
import { QueueManager } from './queue-manager.js';

class FakeMpv extends EventEmitter {
  public playCalls: Array<{ url: string; meta: unknown }> = [];
  public stopCalls = 0;

  play(url: string, meta: unknown): void {
    this.playCalls.push({ url, meta });
  }

  stop(): void {
    this.stopCalls += 1;
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
