'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const {
  getAppStrings,
  getAppearanceStrings,
  getAzureConfigStrings,
  getDeepLConfigStrings,
  localeBundles,
  normalizeUiLocale,
  parseYouTubeLanguagePreference
} = require('../src/i18n');

test('normalizes supported UI locales to locale filenames and falls back to English', () => {
  assert.equal(normalizeUiLocale('zh-Hans-CN'), 'zh-cn');
  assert.equal(normalizeUiLocale('zh_HK'), 'zh-tw');
  assert.equal(normalizeUiLocale('ja-JP'), 'en-us');
  assert.equal(getAppStrings('zh-TW').close, '關閉');
  assert.equal(getAppearanceStrings('zh-CN').otherCategory, '其他');
  assert.equal(getAzureConfigStrings('en-US').title, 'Configure Azure Translator');
  assert.equal(getDeepLConfigStrings('en-US').title, 'Configure DeepL');
});

test('loads translations exclusively from canonical locale JSON files', () => {
  const localeFiles = readdirSync(path.join(__dirname, '..', 'src', 'i18n'))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(localeFiles, ['en-us.json', 'zh-cn.json', 'zh-tw.json']);
  assert.deepEqual(Object.keys(localeBundles).sort(), ['en-us', 'zh-cn', 'zh-tw']);
});

test('keeps every locale namespace complete', () => {
  const reference = localeBundles['en-us'];
  for (const bundle of Object.values(localeBundles)) {
    assert.deepEqual(Object.keys(bundle).sort(), Object.keys(reference).sort());
    for (const namespace of Object.keys(reference)) {
      assert.deepEqual(
        Object.keys(bundle[namespace]).sort(),
        Object.keys(reference[namespace]).sort()
      );
      assert.equal(Object.values(bundle[namespace]).every((value) => (
        typeof value === 'string' && value.length > 0
      )), true);
    }
  }
});

test('reads a validated YouTube language from the PREF cookie', () => {
  assert.equal(parseYouTubeLanguagePreference('tz=Asia.Singapore&hl=zh-TW&f6=400'), 'zh-TW');
  assert.equal(parseYouTubeLanguagePreference('tz=UTC&hl=../../bad'), '');
  assert.equal(parseYouTubeLanguagePreference('tz=UTC'), '');
});
