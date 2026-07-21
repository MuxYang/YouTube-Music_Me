'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createAzureTranslatorUrl,
  createAzureTranslatorBatches,
  createDeepLLyricsPayloads,
  createGoogleLyricsBatches,
  joinGoogleLyricsLines,
  normalizeAzureTargetLanguage,
  normalizeAzureTranslatorEndpoint,
  normalizeAzureTranslatorKey,
  normalizeAzureTranslatorRegion,
  normalizeDeepLAuthKey,
  normalizeDeepLTargetLanguage,
  normalizeTranslationProvider,
  splitGoogleLyricsText
} = require('../src/translation');

test('normalizes supported translation providers and DeepL target languages', () => {
  assert.equal(normalizeTranslationProvider('deepl'), 'deepl');
  assert.equal(normalizeTranslationProvider('azure'), 'azure');
  assert.equal(normalizeTranslationProvider('other'), 'google');
  assert.equal(normalizeDeepLTargetLanguage('zh-CN'), 'ZH-HANS');
  assert.equal(normalizeDeepLTargetLanguage('zh_HK'), 'ZH-HANT');
  assert.equal(normalizeDeepLTargetLanguage('en'), 'EN-US');
  assert.equal(normalizeDeepLTargetLanguage('ja-JP'), 'JA');
});

test('normalizes Azure Translator credentials and target languages', () => {
  const key = '0123456789abcdef0123456789abcdef';
  assert.equal(normalizeAzureTranslatorKey(` ${key} `), key);
  assert.equal(normalizeAzureTranslatorRegion(' SoutheastAsia '), 'southeastasia');
  assert.equal(normalizeAzureTranslatorRegion(''), '');
  assert.equal(normalizeAzureTranslatorEndpoint(''), 'https://api.cognitive.microsofttranslator.com');
  assert.equal(
    normalizeAzureTranslatorEndpoint('https://example.cognitiveservices.azure.com/'),
    'https://example.cognitiveservices.azure.com'
  );
  assert.equal(
    normalizeAzureTranslatorEndpoint(
      'https://example.cognitiveservices.azure.com/translator/text/v3.0/translate/'
    ),
    'https://example.cognitiveservices.azure.com'
  );
  assert.equal(normalizeAzureTargetLanguage('zh-CN'), 'zh-Hans');
  assert.equal(normalizeAzureTargetLanguage('zh-TW'), 'zh-Hant');
  assert.equal(normalizeAzureTargetLanguage('ja-JP'), 'ja');
  assert.throws(() => normalizeAzureTranslatorKey('short'));
  assert.throws(() => normalizeAzureTranslatorEndpoint('https://example.com'));
  assert.throws(() => normalizeAzureTranslatorEndpoint(
    'https://example.cognitiveservices.azure.com/untrusted/path'
  ));
  assert.equal(
    createAzureTranslatorUrl('', 'zh-CN'),
    'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans'
  );
  assert.equal(
    createAzureTranslatorUrl('https://example.cognitiveservices.azure.com', 'ja-JP'),
    'https://example.cognitiveservices.azure.com/translator/text/v3.0/translate?api-version=3.0&to=ja'
  );
});

test('splits Azure Translator input by line count and character count', () => {
  const lines = ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10)];
  assert.deepEqual(createAzureTranslatorBatches(lines, 25, 100), [
    lines.slice(0, 2),
    lines.slice(2)
  ]);
  assert.deepEqual(createAzureTranslatorBatches(lines, 100, 2), [
    lines.slice(0, 2),
    lines.slice(2)
  ]);
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
