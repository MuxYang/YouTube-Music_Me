'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignSyncedTranslation,
  buildLyricsSearchHints,
  createLyricsLookupCacheKey,
  isLikelyRomanizedLyrics,
  normalizeTranslationLanguage,
  parseClockDuration,
  parseSyncedLyrics,
  selectLyricsSearchPairs,
  selectBestLyricsCandidate
} = require('../src/lyrics');

test('parses and aligns a provider translation by lyrics timestamps', () => {
  assert.deepEqual(parseSyncedLyrics('[00:01.20]First\n[00:03.450]Second'), [
    { text: 'First', time: 1.2 },
    { text: 'Second', time: 3.45 }
  ]);
  assert.deepEqual(alignSyncedTranslation([
    { text: '原文一', time: 1 },
    { text: '原文二', time: 3.5 },
    { text: '原文三', time: 8 }
  ], '[00:01.20]Translation one\n[00:03.45]Translation two\n[00:08.60]Translation three'), [
    'Translation one',
    'Translation two',
    'Translation three'
  ]);
  assert.equal(alignSyncedTranslation([
    { text: 'One', time: 1 },
    { text: 'Two', time: 3 },
    { text: 'Three', time: 5 }
  ], '[00:20.00]Unrelated'), null);
});

test('builds aliases for bilingual YouTube Music titles', () => {
  const hints = buildLyricsSearchHints({
    artist: 'syudou',
    duration: 232,
    title: 'あーあ - Aaah'
  });
  assert.equal(hints.titles.includes('Aaah'), true);
  assert.equal(hints.titles.includes('あーあ'), true);
  assert.equal(hints.pairs.some((pair) => (
    pair.trackName === 'Aaah' && pair.artistName === 'syudou'
  )), true);
});

test('infers an artist and track pair from a video title', () => {
  const hints = buildLyricsSearchHints({ artist: 'Compilation uploader', title: 'Real Artist - Song Name' });
  assert.equal(hints.pairs.some((pair) => (
    pair.inferred && pair.artistName === 'Real Artist' && pair.trackName === 'Song Name'
  )), true);
});

test('uses the full music-video title as a provider search hint', () => {
  const hints = buildLyricsSearchHints({
    artist: 'Video uploader',
    title: 'Song Name',
    videoTitle: 'Real Artist - Song Name'
  });
  assert.equal(hints.pairs.some((pair) => (
    pair.inferred && pair.artistName === 'Real Artist' && pair.trackName === 'Song Name'
  )), true);
});

test('searches canonical artist aliases before presentation title variants', () => {
  const hints = buildLyricsSearchHints({
    artist: '怪忌蝶',
    artistAliases: ['Phantom Siita'],
    title: 'Meguru',
    titleAliases: ['輪廻る - Meguru']
  });
  const pairs = selectLyricsSearchPairs(hints);
  assert.deepEqual(pairs.slice(0, 2).map((pair) => [pair.trackName, pair.artistName]), [
    ['Meguru', '怪忌蝶'],
    ['Meguru', 'Phantom Siita']
  ]);
});

test('lyrics provider cache key changes when player metadata stabilizes', () => {
  const early = buildLyricsSearchHints({
    artist: 'Previous Artist',
    duration: 238,
    title: 'Haru Ni Mau',
    videoId: 'video-1'
  });
  const stable = buildLyricsSearchHints({
    artist: 'Ado',
    duration: 238,
    title: 'Haru Ni Mau',
    videoId: 'video-1'
  });
  assert.notEqual(createLyricsLookupCacheKey(early), createLyricsLookupCacheKey(stable));
});

test('ranks title, artist, and duration above an uploader-only match', () => {
  const hints = buildLyricsSearchHints({
    artist: 'syudou',
    duration: 232,
    title: 'あーあ - Aaah'
  });
  const match = selectBestLyricsCandidate([
    {
      id: 1,
      trackName: 'Aaah',
      artistName: 'Different Artist',
      duration: 190,
      syncedLyrics: '[00:01.00]wrong'
    },
    {
      id: 2,
      trackName: 'Aaah',
      artistName: 'syudou',
      duration: 232,
      syncedLyrics: '[00:01.00]right'
    }
  ], hints);
  assert.equal(match.candidate.id, 2);
});

test('rejects a candidate with a materially different duration', () => {
  const hints = buildLyricsSearchHints({ artist: 'Artist', duration: 240, title: 'Song' });
  assert.equal(selectBestLyricsCandidate([{
    id: 1,
    trackName: 'Song',
    artistName: 'Artist',
    duration: 180,
    syncedLyrics: '[00:01.00]wrong version'
  }], hints), null);
});

test('scores provider title and artist aliases', () => {
  const hints = buildLyricsSearchHints({ artist: 'Real Artist', duration: 200, title: 'Song' });
  const match = selectBestLyricsCandidate([{
    artistAliases: ['Real Artist'],
    artistName: 'Uploader',
    duration: 200,
    id: 8,
    syncedLyrics: '[00:01.00]matched through aliases',
    titleAliases: ['Song'],
    trackName: 'Localized title'
  }], hints);
  assert.equal(match.candidate.id, 8);
});

test('parses queue durations and maps YouTube Music languages for translation', () => {
  assert.equal(parseClockDuration('3:52'), 232);
  assert.equal(parseClockDuration('1:02:03'), 3723);
  assert.equal(normalizeTranslationLanguage('zh-Hans'), 'zh-CN');
  assert.equal(normalizeTranslationLanguage('zh-Hant-HK'), 'zh-TW');
  assert.equal(normalizeTranslationLanguage('pt-BR'), 'pt-br');
});

test('rejects romanized-only lyrics for Japanese tracks', () => {
  assert.equal(isLikelyRomanizedLyrics(
    '[00:01.00]konnichiwa watashi no uta anata no koe',
    { title: 'こんにちは' }
  ), true);
  assert.equal(isLikelyRomanizedLyrics(
    '[00:01.00]こんにちは 私の歌',
    { title: 'こんにちは' }
  ), false);
});
