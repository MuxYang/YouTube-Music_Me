'use strict';

const MUSIC_URL = 'https://music.youtube.com/';
const APP_NAME = 'YouTube Music Me';

const DEFAULT_SETTINGS = Object.freeze({
  closeToTray: true,
  closeAction: 'tray',
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
  windowBounds: {
    width: 1280,
    height: 800
  }
});

function normalizeSettings(value = {}) {
  const sourceAppearance = value.appearance || {};
  const sourceLyrics = value.lyrics || {};
  const sourceBounds = value.windowBounds || {};
  const width = Number.isFinite(sourceBounds.width)
    ? Math.max(880, Math.round(sourceBounds.width))
    : DEFAULT_SETTINGS.windowBounds.width;
  const height = Number.isFinite(sourceBounds.height)
    ? Math.max(600, Math.round(sourceBounds.height))
    : DEFAULT_SETTINGS.windowBounds.height;

  const bounds = { width, height };

  if (Number.isFinite(sourceBounds.x)) {
    bounds.x = Math.round(sourceBounds.x);
  }

  if (Number.isFinite(sourceBounds.y)) {
    bounds.y = Math.round(sourceBounds.y);
  }

  const requestedCloseAction = String(value.closeAction || '').toLowerCase();
  const closeAction = ['ask', 'tray', 'quit'].includes(requestedCloseAction)
    ? requestedCloseAction
    : value.closeToTray === false ? 'ask' : 'tray';
  const lrclibEnabled = sourceLyrics.lrclibEnabled === true;
  const neteaseEnabled = lrclibEnabled && sourceLyrics.neteaseEnabled === true;
  const lyrics = {
    autoTranslate: lrclibEnabled && sourceLyrics.autoTranslate === true,
    lrclibEnabled,
    neteaseEnabled,
    neteaseTranslationSource: neteaseEnabled
      && sourceLyrics.neteaseTranslationSource === true,
    translationProvider: sourceLyrics.translationProvider === 'deepl' ? 'deepl' : 'google'
  };

  const normalized = {
    closeToTray: value.closeToTray !== false,
    appearance: {
      animations: sourceAppearance.animations === true,
      translucentSurfaces: sourceAppearance.translucentSurfaces === true
    },
    lyrics,
    windowBounds: bounds
  };
  normalized.closeAction = closeAction;
  normalized.closeToTray = closeAction === 'tray';
  return normalized;
}

function isExternalPolicyUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') {
      return false;
    }

    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();
    if (hostname === 'policies.google.com') {
      return /^\/(privacy|terms)(?:\/|$)/.test(pathname);
    }

    if (hostname === 'google.com' || hostname.endsWith('.google.com')) {
      return /\/policies\/(privacy|terms)(?:\/|$)/.test(pathname);
    }

    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      return pathname === '/t/terms'
        || pathname.startsWith('/t/terms/')
        || (pathname === '/static' && ['privacy_guidelines', 'terms'].includes(
          (url.searchParams.get('template') || '').toLowerCase()
        ));
    }

    return false;
  } catch {
    return false;
  }
}

function isTrustedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && (
      url.hostname === 'youtube.com'
      || url.hostname.endsWith('.youtube.com')
      || url.hostname === 'google.com'
      || url.hostname.endsWith('.google.com')
      || url.hostname === 'googleusercontent.com'
      || url.hostname.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

module.exports = {
  APP_NAME,
  DEFAULT_SETTINGS,
  MUSIC_URL,
  isExternalPolicyUrl,
  isTrustedAppUrl,
  normalizeSettings
};
