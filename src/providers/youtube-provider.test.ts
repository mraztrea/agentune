import assert from 'node:assert/strict';
import test from 'node:test';
import { mapYtDlpSearchEntries } from './youtube-provider.js';

test('mapYtDlpSearchEntries converts yt-dlp playlist entries into SearchResult objects', () => {
  const results = mapYtDlpSearchEntries([
    {
      id: '6eONmnFB9sw',
      title: 'Chuyện Đôi Ta - Emcee L (Da LAB) ft Muộii (Official MV)',
      duration: 226,
      channel: 'Da LAB Official and Emcee L Official',
      webpage_url: 'https://www.youtube.com/watch?v=6eONmnFB9sw',
      thumbnails: [{ url: 'https://i.ytimg.com/vi/6eONmnFB9sw/hq720.jpg' }],
    },
  ], 3);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, '6eONmnFB9sw');
  assert.equal(results[0].artist, 'Da LAB Official and Emcee L Official');
  assert.equal(results[0].duration, '3:46');
  assert.equal(results[0].durationMs, 226000);
  assert.equal(results[0].url, 'https://www.youtube.com/watch?v=6eONmnFB9sw');
});

test('mapYtDlpSearchEntries skips malformed entries and respects limit', () => {
  const results = mapYtDlpSearchEntries([
    { title: 'missing id' },
    { id: 'good-1', title: 'Good 1', duration: 60, uploader: 'Uploader 1' },
    { id: 'good-2', title: 'Good 2', duration: 61, uploader: 'Uploader 2' },
  ], 1);

  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'good-1');
  assert.equal(results[0].artist, 'Uploader 1');
  assert.equal(results[0].duration, '1:00');
});
