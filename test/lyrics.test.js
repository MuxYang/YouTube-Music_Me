'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alignSyncedTranslation,
  buildLyricsSearchHints,
  canSeekLyricsTimeline,
  createLyricsLookupCacheKey,
  haveSameLanguage,
  isLikelyRomanizedLyrics,
  isLyricsMetadataLine,
  normalizeTranslationLanguage,
  parseClockDuration,
  parseSyncedLyrics,
  selectLyricsTranslationSource,
  selectLyricsSearchPairs,
  selectBestLyricsCandidate,
  shouldOfferLyricsTranslation
} = require('../src/lyrics');

test('allows lyrics seeking only for the rendered current track', () => {
  const current = {
    currentKey: 'track-key',
    currentState: 'ready',
    currentVideoId: 'video-2',
    expectedKey: 'track-key',
    expectedVideoId: 'video-2',
    lyricsVideoId: 'video-2'
  };
  assert.equal(canSeekLyricsTimeline(current), true);
  assert.equal(canSeekLyricsTimeline({ ...current, expectedVideoId: 'video-1' }), false);
  assert.equal(canSeekLyricsTimeline({ ...current, expectedKey: 'previous-key' }), false);
  assert.equal(canSeekLyricsTimeline({ ...current, currentState: 'loading' }), false);
});

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

test('rejects a timeline made only of empty timestamp elements', () => {
  assert.deepEqual(parseSyncedLyrics('[00:01.00]\n[00:02.00]'), []);
  assert.deepEqual(parseSyncedLyrics('[00:01.00]\n[00:02.00]Line'), [{
    text: 'Line',
    time: 2
  }]);
});

test('does not insert provider translations into lyric credit lines', () => {
  assert.equal(isLyricsMetadataLine('作詞：Reol'), true);
  assert.equal(isLyricsMetadataLine('Composer: Reol'), true);
  assert.deepEqual(alignSyncedTranslation([
    { text: '作詞：Reol', time: 1 },
    { text: '作曲：Reol', time: 1 },
    { text: '「鼓動が止むまで傍にいる」なんて', time: 1 },
    { text: '違える約束はせず ただあなたといたい', time: 5 }
  ], '[00:01.00]「直到心跳停止为止都会在你身边」什么的\n[00:05.00]绝不会违背承诺 只是想和你在一起'), [
    '',
    '',
    '「直到心跳停止为止都会在你身边」什么的',
    '绝不会违背承诺 只是想和你在一起'
  ]);
});

test('uses aligned NetEase Chinese lyrics as one translation source timeline', () => {
  const originalLines = [
    { text: '作詞：Reol', time: 1 },
    { text: '原文一', time: 2 },
    { text: '原文二', time: 5 }
  ];
  assert.deepEqual(selectLyricsTranslationSource(
    originalLines,
    '[00:02.10]中文一\n[00:05.20]中文二',
    true
  ), {
    kind: 'netease-zh',
    lines: ['作詞：Reol', '中文一', '中文二']
  });
  assert.deepEqual(selectLyricsTranslationSource(
    originalLines,
    '[00:30.00]无关歌词',
    true
  ), {
    kind: 'original',
    lines: ['作詞：Reol', '原文一', '原文二']
  });

  const partiallyAligned = [
    { text: '原文一', time: 2 },
    { text: '原文二', time: 5 },
    { text: '原文三', time: 8 }
  ];
  assert.equal(selectLyricsTranslationSource(
    partiallyAligned,
    '[00:02.10]中文一\n[00:05.20]中文二',
    true
  ).kind, 'original');
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

test('treats localized featured-artist labels as artist metadata', () => {
  const hints = buildLyricsSearchHints({
    artist: 'Fenruri',
    duration: 212,
    title: 'Lost in the Noise',
    titleAliases: ['Lost in the Noise（合作音乐人：KASANE TETO）']
  });
  assert.equal(hints.titles.includes('Lost in the Noise'), true);
  assert.equal(hints.titles.some((title) => title.includes('合作音乐人')), false);
  assert.equal(hints.artists.includes('KASANE TETO'), true);
  assert.equal(hints.isJapanese, false);
  assert.equal(isLikelyRomanizedLyrics(
    '[00:01.00]Static in my ears now the world fades away',
    {
      title: 'Lost in the Noise',
      titleAliases: ['Lost in the Noise（合作音乐人：KASANE TETO）']
    }
  ), false);
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
  assert.notEqual(createLyricsLookupCacheKey(buildLyricsSearchHints({
    artist: 'Ado', duration: 238, title: 'Haru Ni Mau', videoId: 'video-1'
  })), createLyricsLookupCacheKey(buildLyricsSearchHints({
    album: 'Stable Album',
    artist: 'Ado',
    duration: 238,
    title: 'Haru Ni Mau',
    videoId: 'video-1'
  })));
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

test('rejects an exact title and duration when the artist does not match', () => {
  const hints = buildLyricsSearchHints({
    artist: 'Fenruri',
    duration: 212,
    title: 'Lost in the Noise',
    titleAliases: ['Lost in the Noise（合作音乐人：KASANE TETO）']
  });
  assert.equal(selectBestLyricsCandidate([{
    id: 1,
    trackName: 'Lost in the Noise',
    artistName: '逍遥游之',
    duration: 212,
    syncedLyrics: '[00:01.00]wrong lyrics'
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
  assert.equal(haveSameLanguage('en', 'en-US'), true);
  assert.equal(haveSameLanguage('ja', 'en-US'), false);
  assert.equal(haveSameLanguage('zh-Hans', 'zh-CN'), true);
  assert.equal(haveSameLanguage('zh-Hant', 'zh-CN'), false);
});

test('offers translation only for a confidently different lyrics language', () => {
  assert.equal(shouldOfferLyricsTranslation({
    declaredLanguage: 'en',
    detectedLanguage: 'en',
    source: 'youtube-cc',
    targetLanguage: 'en-US'
  }), false);
  assert.equal(shouldOfferLyricsTranslation({
    detectedLanguage: 'en',
    source: 'lrclib',
    targetLanguage: 'en-US'
  }), false);
  assert.equal(shouldOfferLyricsTranslation({
    detectedLanguage: 'ja',
    source: 'lrclib',
    targetLanguage: 'en-US'
  }), true);
  assert.equal(shouldOfferLyricsTranslation({
    detectedLanguage: 'en',
    source: 'lrclib',
    targetLanguage: 'zh-CN'
  }), true);
  assert.equal(shouldOfferLyricsTranslation({
    declaredLanguage: 'en',
    detectedLanguage: 'en',
    source: 'youtube-cc',
    targetLanguage: 'zh-CN'
  }), true);
  assert.equal(shouldOfferLyricsTranslation({
    detectedLanguage: '',
    source: 'lrclib',
    targetLanguage: 'en-US'
  }), false);
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
  assert.equal(isLikelyRomanizedLyrics(
    '[00:01.00]This song is intentionally written in English',
    { language: 'zh-CN', title: '中文歌名' }
  ), false);
  assert.equal(isLikelyRomanizedLyrics(
    '[00:01.00]This is an English song shown in a Japanese interface',
    { language: 'ja-JP', title: 'English Song' }
  ), false);
});
