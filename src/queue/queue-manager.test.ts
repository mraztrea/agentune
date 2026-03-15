import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueManager } from './queue-manager.js';

test('QueueManager adds and returns queued items in order', () => {
  const queueManager = new QueueManager();
  const firstPosition = queueManager.add({
    id: '1',
    title: 'First',
    artist: 'Artist 1',
    duration: 100,
    thumbnail: 'thumb-1',
    url: 'https://example.com/1',
  });
  const secondPosition = queueManager.add({
    id: '2',
    title: 'Second',
    artist: 'Artist 2',
    duration: 120,
    thumbnail: 'thumb-2',
    url: 'https://example.com/2',
  });

  assert.equal(firstPosition, 1);
  assert.equal(secondPosition, 2);
  assert.deepEqual(queueManager.list().map((item) => item.id), ['1', '2']);
  assert.equal(queueManager.next()?.id, '1');
  assert.equal(queueManager.next()?.id, '2');
  assert.equal(queueManager.next(), null);
});

test('QueueManager archives finished tracks into history', () => {
  const queueManager = new QueueManager();
  queueManager.setNowPlaying({
    id: '1',
    title: 'Current',
    artist: 'Artist',
    duration: 100,
    thumbnail: 'thumb',
    url: 'https://example.com/1',
  });

  const finished = queueManager.finishCurrentTrack();
  const state = queueManager.getState();

  assert.equal(finished?.id, '1');
  assert.equal(state.nowPlaying, null);
  assert.deepEqual(state.history.map((item) => item.id), ['1']);
});
