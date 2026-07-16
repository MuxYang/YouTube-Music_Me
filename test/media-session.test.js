'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createTrackFingerprint,
  parsePlayerBarTiming,
  playerBarBelongsToTrack,
  playerBarTitleBelongsToTrack,
  selectMediaArtwork,
  selectSquareArtwork,
  selectTrackTiming,
  upgradeArtworkSource
} = require('../src/media-session');

test('reads the track-relative clock shown by the player bar', () => {
  assert.deepEqual(parsePlayerBarTiming('1:23 / 3:52'), {
    duration: 232,
    position: 83
  });
  assert.equal(parsePlayerBarTiming('Live'), null);
});

test('uses an exact video ID to validate player-bar metadata', () => {
  assert.equal(playerBarBelongsToTrack('video-2', 'video-2'), true);
  assert.equal(playerBarBelongsToTrack('video-1', 'video-2'), false);
  assert.equal(playerBarBelongsToTrack('', 'video-2'), false);
});

test('uses the matching player-bar title when YouTube exposes no watch link', () => {
  assert.equal(playerBarTitleBelongsToTrack(
    'Wake Me Up Before You Go-Go',
    'Wake Me Up Before You Go-Go (Official Video)'
  ), true);
  assert.equal(playerBarTitleBelongsToTrack('Previous Song', 'Current Song'), false);
});

test('uses high-resolution player timing before the player-bar clock', () => {
  const timing = selectTrackTiming({
    durationHint: 240,
    media: { duration: 480, position: 258 },
    player: { duration: 240, position: 18.75 },
    playerBar: { duration: 240, position: 18 }
  });
  assert.deepEqual(timing, { duration: 240, position: 18.75 });
});

test('derives each natural transition from the current cumulative window', () => {
  assert.deepEqual(selectTrackTiming({
    durationHint: 210,
    player: { duration: 450, position: 244 }
  }), { duration: 210, position: 4 });
  assert.deepEqual(selectTrackTiming({
    durationHint: 180,
    player: { duration: 630, position: 455 }
  }), { duration: 180, position: 5 });
  assert.deepEqual(selectTrackTiming({
    durationHint: 240,
    player: { duration: 420, position: 185 }
  }), { duration: 240, position: 5 });
});

test('does not require previous-track state when a new timeline resets', () => {
  assert.deepEqual(selectTrackTiming({
    durationHint: 210,
    media: { duration: 210, position: 3 }
  }), { duration: 210, position: 3 });
});

test('rejects a raw position that cannot belong to the current track', () => {
  assert.equal(selectTrackTiming({
    durationHint: 180,
    media: { duration: 900, position: 400 }
  }), null);
});

test('lyrics identity changes when stable metadata changes for one video', () => {
  assert.equal(createTrackFingerprint(null), '');
  const early = createTrackFingerprint({
    artist: 'Uploader', duration: 200, title: 'Artist - Song', videoId: 'abc'
  });
  const stable = createTrackFingerprint({
    artist: 'Artist', duration: 200, title: 'Song', videoId: 'abc'
  });
  assert.notEqual(early, stable);
});

test('selects a square cover and rejects a widescreen thumbnail', () => {
  const artwork = selectSquareArtwork([
    { src: 'https://i.ytimg.com/video=w1280-h720', width: 1280, height: 720 },
    { src: 'https://lh3.googleusercontent.com/cover=w60-h60-l90-rj', width: 60, height: 60 }
  ]);
  assert.deepEqual(artwork, [{
    sizes: '544x544',
    src: 'https://lh3.googleusercontent.com/cover=w544-h544-l90-rj'
  }]);
});

test('does not publish non-network artwork URLs', () => {
  assert.equal(upgradeArtworkSource('data:image/png;base64,AAAA'), '');
  assert.deepEqual(selectSquareArtwork([{ src: 'blob:test', width: 100, height: 100 }]), []);
});

test('uses a widescreen video thumbnail when no square cover is available', () => {
  assert.deepEqual(selectMediaArtwork([{
    height: 720,
    src: 'https://i.ytimg.com/vi/example/maxresdefault.jpg',
    width: 1280
  }]), [{
    sizes: '1280x720',
    src: 'https://i.ytimg.com/vi/example/maxresdefault.jpg'
  }]);
});
