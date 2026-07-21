'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectLyricsLanguage,
  normalizeDetectedLanguage,
  normalizeDetectionText
} = require('../src/language-detection');

test('normalizes franc ISO 639-3 results for locale comparison', () => {
  assert.equal(normalizeDetectedLanguage('eng'), 'en');
  assert.equal(normalizeDetectedLanguage('cmn'), 'zh');
  assert.equal(normalizeDetectedLanguage('jpn'), 'ja');
  assert.equal(normalizeDetectedLanguage('und'), '');
  assert.equal(normalizeDetectedLanguage('../invalid'), '');
});

test('normalizes lyrics before local language detection', () => {
  assert.equal(normalizeDetectionText([' first   line ', '', 'second line']), 'first line\nsecond line');
});

test('detects common lyric languages without a translation request', async () => {
  const english = await detectLyricsLanguage([
    'This is an English lyric line written for local language detection.',
    'We sing through the night and wait together for the morning light.'
  ]);
  assert.equal(english.language, 'en');
  assert.equal(english.confidence > 0, true);
  assert.equal((await detectLyricsLanguage([
    '这是用于本地语言检测的中文歌词，包含足够多的文字。',
    '我们一起走过漫长的夜晚，等待清晨的阳光。'
  ])).language, 'zh');
  assert.equal((await detectLyricsLanguage([
    'これはローカル言語検出のための日本語の歌詞です。',
    '長い夜を越えて一緒に朝の光を待っています。'
  ])).language, 'ja');
});

test('detects repetitive English song lyrics', async () => {
  const verse = [
    'We are no strangers to love',
    'You know the rules and so do I',
    'A full commitment is what I am thinking of',
    'You would not get this from any other guy',
    'Never gonna give you up never gonna let you down',
    'Never gonna run around and desert you'
  ];
  const result = await detectLyricsLanguage([...verse, ...verse, ...verse]);
  assert.equal(result.language, 'en');
  assert.equal(result.confidence > 0, true);
});

test('does not guess a language for insufficient lyrics', async () => {
  assert.deepEqual(await detectLyricsLanguage(['Hello']), {
    confidence: 0,
    language: ''
  });
});
