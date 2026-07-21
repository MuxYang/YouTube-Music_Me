'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isExternalPolicyUrl, isTrustedAppUrl, normalizeSettings } = require('../src/config');

test('normalizes window bounds and keeps coordinates', () => {
  assert.deepEqual(normalizeSettings({
    closeToTray: false,
    windowBounds: { x: 12.4, y: 45.6, width: 700, height: 400 }
  }), {
    closeToTray: false,
    closeAction: 'ask',
    appearance: {
      animations: false,
      translucentSurfaces: false
    },
    lyrics: {
      autoTranslate: false,
      lrclibEnabled: false,
      neteaseEnabled: false,
      neteaseTranslationSource: false,
      translationProvider: 'google'
    },
    windowBounds: { x: 12, y: 46, width: 880, height: 600 }
  });
});

test('defaults close-to-tray unless explicitly disabled', () => {
  assert.equal(normalizeSettings({}).closeToTray, true);
  assert.equal(normalizeSettings({ closeToTray: 0 }).closeToTray, true);
  assert.equal(normalizeSettings({ closeToTray: false }).closeToTray, false);
});

test('normalizes appearance switches as explicit booleans', () => {
  assert.deepEqual(normalizeSettings({
    appearance: { animations: true, translucentSurfaces: true }
  }).appearance, {
    animations: true,
    translucentSurfaces: true
  });
  assert.deepEqual(normalizeSettings({
    appearance: { animations: 1, translucentSurfaces: 'yes' }
  }).appearance, {
    animations: false,
    translucentSurfaces: false
  });
});

test('defaults LRCLIB lyrics off and only accepts an explicit boolean', () => {
  assert.equal(normalizeSettings({}).lyrics.lrclibEnabled, false);
  assert.equal(normalizeSettings({ lyrics: { lrclibEnabled: true } }).lyrics.lrclibEnabled, true);
  assert.equal(normalizeSettings({ lyrics: { lrclibEnabled: 1 } }).lyrics.lrclibEnabled, false);
});

test('disables dependent lyrics options when their providers are disabled', () => {
  const withoutSync = normalizeSettings({
    lyrics: {
      autoTranslate: true,
      neteaseEnabled: true,
      neteaseTranslationSource: true
    }
  }).lyrics;
  assert.equal(withoutSync.autoTranslate, false);
  assert.equal(withoutSync.neteaseEnabled, false);
  assert.equal(withoutSync.neteaseTranslationSource, false);

  const withoutNetease = normalizeSettings({
    lyrics: { lrclibEnabled: true, neteaseTranslationSource: true }
  }).lyrics;
  assert.equal(withoutNetease.neteaseTranslationSource, false);
});

test('keeps every lyrics switch enumerable during settings persistence', () => {
  const lyrics = normalizeSettings({}).lyrics;
  assert.deepEqual(Object.keys(lyrics), [
    'autoTranslate',
    'lrclibEnabled',
    'neteaseEnabled',
    'neteaseTranslationSource',
    'translationProvider'
  ]);
});

test('migrates close behavior and normalizes the NetEase lyrics switch', () => {
  const settings = normalizeSettings({
    closeAction: 'quit',
    lyrics: {
      autoTranslate: true,
      lrclibEnabled: true,
      neteaseEnabled: true,
      neteaseTranslationSource: true
    }
  });
  assert.equal(settings.closeAction, 'quit');
  assert.equal(settings.closeToTray, false);
  assert.equal(settings.lyrics.neteaseEnabled, true);
  assert.equal(settings.lyrics.neteaseTranslationSource, true);
  assert.equal(settings.lyrics.autoTranslate, true);
});

test('normalizes the lyrics translation provider', () => {
  assert.equal(normalizeSettings({}).lyrics.translationProvider, 'google');
  assert.equal(normalizeSettings({
    lyrics: { translationProvider: 'deepl' }
  }).lyrics.translationProvider, 'deepl');
  assert.equal(normalizeSettings({
    lyrics: { translationProvider: 'azure' }
  }).lyrics.translationProvider, 'azure');
  assert.equal(normalizeSettings({
    lyrics: { translationProvider: 'unknown' }
  }).lyrics.translationProvider, 'google');
});

test('allows only HTTPS YouTube and Google application URLs', () => {
  assert.equal(isTrustedAppUrl('https://music.youtube.com/watch?v=1'), true);
  assert.equal(isTrustedAppUrl('https://accounts.google.com/signin'), true);
  assert.equal(isTrustedAppUrl('http://music.youtube.com/'), false);
  assert.equal(isTrustedAppUrl('https://youtube.com.example.com/'), false);
  assert.equal(isTrustedAppUrl('not a url'), false);
});

test('recognizes only supported external legal and privacy pages', () => {
  assert.equal(isExternalPolicyUrl('https://www.youtube.com/t/terms?chromeless=1'), true);
  assert.equal(isExternalPolicyUrl('https://policies.google.com/privacy?hl=zh-CN'), true);
  assert.equal(isExternalPolicyUrl('https://policies.google.com/terms'), true);
  assert.equal(isExternalPolicyUrl('https://www.youtube.com/static?template=terms'), true);
  assert.equal(isExternalPolicyUrl('https://music.youtube.com/watch?v=1'), false);
  assert.equal(isExternalPolicyUrl('http://www.youtube.com/t/terms'), false);
  assert.equal(isExternalPolicyUrl('https://policies.google.com.example.com/privacy'), false);
});
