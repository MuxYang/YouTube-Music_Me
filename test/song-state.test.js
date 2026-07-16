'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSongStateMonitor } = require('../src/song-state');

test('emits one revision for each detected video ID', () => {
  const monitor = createSongStateMonitor();
  const initial = monitor.observe({
    durationHint: 240,
    player: { duration: 240, position: 20 },
    videoId: 'first'
  });
  const update = monitor.observe({
    durationHint: 240,
    player: { duration: 240, position: 21 },
    videoId: 'first'
  });
  const changed = monitor.observe({
    durationHint: 210,
    player: { duration: 450, position: 244 },
    videoId: 'second'
  });
  assert.deepEqual([initial.revision, update.revision, changed.revision], [1, 1, 2]);
  assert.equal(initial.initial, true);
  assert.equal(update.trackChanged, false);
  assert.equal(changed.trackChanged, true);
});

test('rebases every natural cut from the preceding track boundary', () => {
  const monitor = createSongStateMonitor();
  monitor.observe({
    durationHint: 240,
    player: { duration: 240, position: 238 },
    videoId: 'first'
  });
  const second = monitor.observe({
    durationHint: 210,
    player: { duration: 450, position: 244 },
    videoId: 'second'
  });
  const secondUpdate = monitor.observe({
    durationHint: 210,
    player: { duration: 450, position: 250 },
    videoId: 'second'
  });
  const third = monitor.observe({
    durationHint: 180,
    player: { duration: 630, position: 455 },
    videoId: 'third'
  });
  assert.deepEqual(second.timing, { duration: 210, position: 4 });
  assert.deepEqual(secondUpdate.timing, { duration: 210, position: 10 });
  assert.deepEqual(third.timing, { duration: 180, position: 5 });
});

test('keeps a reset timeline relative to zero after a track change', () => {
  const monitor = createSongStateMonitor();
  monitor.observe({
    durationHint: 240,
    player: { duration: 240, position: 238 },
    videoId: 'first'
  });
  const next = monitor.observe({
    durationHint: 210,
    player: { duration: 210, position: 3 },
    videoId: 'second'
  });
  assert.deepEqual(next.timing, { duration: 210, position: 3 });
});

test('uses the current player-bar clock as a transition anchor', () => {
  const monitor = createSongStateMonitor();
  monitor.observe({
    durationHint: 240,
    player: { duration: 240, position: 238 },
    videoId: 'first'
  });
  const next = monitor.observe({
    durationHint: 210,
    player: { duration: 900, position: 350 },
    playerBar: { duration: 210, position: 4 },
    videoId: 'second'
  });
  assert.deepEqual(next.timing, { duration: 210, position: 4 });
});
