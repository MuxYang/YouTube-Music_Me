'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDeepLLyricsPayloads,
  createGoogleLyricsBatches,
  joinGoogleLyricsLines,
  normalizeDeepLAuthKey,
  normalizeDeepLTargetLanguage,
  normalizeTranslationProvider,
  splitGoogleLyricsText
} = require('../src/translation');

test('normalizes supported translation providers and DeepL target languages', () => {
  assert.equal(normalizeTranslationProvider('deepl'), 'deepl');
  assert.equal(normalizeTranslationProvider('other'), 'google');
  assert.equal(normalizeDeepLTargetLanguage('zh-CN'), 'ZH-HANS');
  assert.equal(normalizeDeepLTargetLanguage('zh_HK'), 'ZH-HANT');
  assert.equal(normalizeDeepLTargetLanguage('en'), 'EN-US');
  assert.equal(normalizeDeepLTargetLanguage('ja-JP'), 'JA');
});

test('accepts only API Free DeepL keys', () => {
  const key = '279a2e9d-83b3-c416-7e2d-f721593e42a0:fx';
  assert.equal(normalizeDeepLAuthKey(` ${key} `), key);
  assert.throws(() => normalizeDeepLAuthKey('short:fx'));
  assert.throws(() => normalizeDeepLAuthKey('279a2e9d-83b3-c416-7e2d-f721593e42a0'));
});

test('keeps one Google request for a normal song and splits only above the limit', () => {
  assert.equal(createGoogleLyricsBatches(['first line', 'second line']).length, 1);
  assert.deepEqual(
    createGoogleLyricsBatches(['a'.repeat(3000), 'b'.repeat(3000)]).map((batch) => batch.length),
    [1, 1]
  );
});

test('preserves Google lyric line boundaries with the request separator', () => {
  const lines = ['first line', 'second line', 'third line'];
  assert.deepEqual(splitGoogleLyricsText(joinGoogleLyricsLines(lines), lines.length), lines);
  assert.deepEqual(splitGoogleLyricsText(
    '第一行\n [[[ ytm9f3a7c1d ]]] \n第二行',
    2
  ), ['第一行', '第二行']);
  assert.throws(() => splitGoogleLyricsText('merged translation', 2));
});

test('sends a normal song to DeepL in one request with full context', () => {
  const lines = Array.from({ length: 80 }, (_, index) => `lyrics line ${index}`);
  const payloads = createDeepLLyricsPayloads(lines, 'zh-CN');
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].text, lines);
  assert.equal(payloads[0].context, lines.join('\n'));
  assert.equal(payloads[0].target_lang, 'ZH-HANS');
});

test('splits DeepL requests by byte size without splitting lyric lines', () => {
  const lines = Array.from({ length: 12 }, (_, index) => `${index}-${'界'.repeat(30)}`);
  const payloads = createDeepLLyricsPayloads(lines, 'en', 900);
  assert.ok(payloads.length > 1);
  assert.deepEqual(payloads.flatMap((payload) => payload.text), lines);
  assert.equal(payloads.every((payload) => Buffer.byteLength(
    JSON.stringify(payload),
    'utf8'
  ) <= 900), true);
});
