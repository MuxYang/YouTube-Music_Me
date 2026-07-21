'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { isExternalPolicyUrl } = require('../config');
const {
  getAppStrings,
  getAppearanceStrings: getLocalizedAppearanceStrings,
  normalizeUiLocale
} = require('../i18n');
const {
  alignSyncedTranslation,
  canSeekLyricsTimeline,
  haveSameLanguage,
  isLikelyRomanizedLyrics,
  isLyricsMetadataLine,
  normalizeTranslationLanguage,
  parseSyncedLyrics,
  selectLyricsTranslationSource,
  shouldOfferLyricsTranslation,
  stripPresentationNoise
} = require('../lyrics');
const {
  createTrackFingerprint,
  parsePlayerBarTiming,
  playerBarBelongsToTrack,
  playerBarTitleBelongsToTrack,
  selectMediaArtwork,
  selectSquareArtwork
} = require('../media-session');
const { createSongStateMonitor } = require('../song-state');

const CONTROL_ID = 'ytm-desktop-window-controls';
const SCROLLBAR_ID = 'ytm-desktop-scrollbar';
const CLOSE_DIALOG_ID = 'ytm-desktop-close-dialog';
const CONSENT_DIALOG_ID = 'ytm-desktop-consent-dialog';
const CONTEXT_MENU_ID = 'ytm-desktop-context-menu';
const STYLE_PANEL_ID = 'ytm-desktop-style-panel';
const LOADING_GUARD_ID = 'ytm-desktop-loading-guard';
const LYRICS_PANEL_ID = 'ytm-desktop-lyrics-panel';
const SETTING_PICKER_ID = 'ytm-desktop-setting-picker';
const SEARCH_BACKDROP_ID = 'ytm-desktop-search-backdrop';
const MENU_SURFACE_SELECTOR = [
  'ytmusic-multi-page-menu-renderer',
  'ytd-multi-page-menu-renderer',
  'ytmusic-menu-popup-renderer'
].join(',');
const SURFACE_SELECTOR = `ytmusic-search-box #suggestion-list,${MENU_SURFACE_SELECTOR}`;
let readySent = false;
let hideScrollbarTimer = null;
let scrollbarFrame = null;
let currentMetadataKey = '';
let currentPlaybackSnapshot = null;
let playbackMonitorTimer = null;
let playbackPollTimer = null;
let lyricsSyncTimer = null;
let lyricsRequestToken = 0;
let currentLyricsKey = '';
let currentLyricsState = 'idle';
let currentLyricsIndex = -1;
let currentLyricsResult = null;
let currentLyricsTrack = null;
let forceLyricsRefreshKey = '';
let lyricsRetryAt = 0;
let lyricsRetryAttempted = false;
let lyricsRetryKey = '';
let lyricsProviderRetryPending = false;
let lyricsUserScrollUntil = 0;
let lyricsTranslationRequestToken = 0;
let lyricsLanguageDetectionRequestToken = 0;
let pendingLyricsIntegrationRefresh = false;
let appearanceSettingsInitialized = false;
let currentUiLocale = '';
let currentDocumentLanguage = '';
let pendingLanguageMenuUntil = 0;
let languageReloadTimer = null;
let windowIsMaximized = false;
let surfaceAnimationFrame = null;
let surfaceAnimationObserver = null;
let surfaceResizeObserver = null;
let lastSurfaceTriggerPoint = null;
const lyricsTranslationCache = new Map();
const settingsContentAnimationTimes = new WeakMap();
const settingsTouchSelections = new WeakMap();
const settingsCloseOverlays = new WeakSet();
const settingsOpenDialogs = new WeakSet();
const observedSurfaceSizes = new WeakSet();
const surfaceAnimationTimes = new Map();
const surfaceVisibility = new WeakMap();
let appearanceSettings = {
  animations: false,
  autoTranslateLyrics: false,
  azureConfigured: false,
  closeAction: 'tray',
  deeplConfigured: false,
  lrclibLyrics: false,
  lyricsTranslationProvider: 'google',
  neteaseLyrics: false,
  neteaseTranslationSource: false,
  translucentSurfaces: false
};
const settingsCloseBypass = new WeakSet();
const nativeSettingsClickBypass = new WeakSet();
const songStateMonitor = createSongStateMonitor();

function claimPageMediaSession() {
  if (window.__ytmDesktopMediaSessionController || !navigator.mediaSession) return;
  const session = navigator.mediaSession;
  const findDescriptor = (property) => {
    let target = session;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      if (descriptor) return descriptor;
      target = Object.getPrototypeOf(target);
    }
    return null;
  };
  const metadataDescriptor = findDescriptor('metadata');
  const playbackDescriptor = findDescriptor('playbackState');
  const nativeSetMetadata = metadataDescriptor?.set
    ? (value) => metadataDescriptor.set.call(session, value)
    : null;
  const nativeSetPlaybackState = playbackDescriptor?.set
    ? (value) => playbackDescriptor.set.call(session, value)
    : null;
  const nativeSetActionHandler = session.setActionHandler.bind(session);
  const nativeSetPositionState = session.setPositionState.bind(session);
  let lastPositionState = null;

  const getPlayer = () => document.querySelector('#movie_player');
  const getMedia = (player = getPlayer()) => player?.querySelector('video, audio') || null;
  const seekTo = (time, fastSeek = false) => {
    const position = Math.max(0, Number(time) || 0);
    const player = getPlayer();
    try {
      if (typeof player?.seekTo === 'function') {
        player.seekTo(position, true);
        return;
      }
    } catch {}
    const media = getMedia(player);
    if (!media) return;
    if (fastSeek && typeof media.fastSeek === 'function') media.fastSeek(position);
    else media.currentTime = position;
  };
  const clickControl = (selector) => {
    const controls = [...document.querySelectorAll(selector)];
    const visible = controls.find((control) => {
      const bounds = control.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    (visible || controls.at(-1))?.click();
  };
  const actions = {
    play: () => {
      const player = getPlayer();
      if (typeof player?.playVideo === 'function') player.playVideo();
      else getMedia(player)?.play().catch(() => {});
    },
    pause: () => {
      const player = getPlayer();
      if (typeof player?.pauseVideo === 'function') player.pauseVideo();
      else getMedia(player)?.pause();
    },
    stop: () => {
      const player = getPlayer();
      if (typeof player?.pauseVideo === 'function') player.pauseVideo();
      else getMedia(player)?.pause();
      seekTo(0);
    },
    previoustrack: () => clickControl('.previous-button.ytmusic-player-bar, #previous-button'),
    nexttrack: () => clickControl('.next-button.ytmusic-player-bar, #next-button'),
    seekbackward: (details = {}) => seekTo(
      (lastPositionState?.position || 0) - (details.seekOffset || 10)
    ),
    seekforward: (details = {}) => seekTo(Math.min(
      lastPositionState?.duration || Number.POSITIVE_INFINITY,
      (lastPositionState?.position || 0) + (details.seekOffset || 10)
    )),
    seekto: (details = {}) => {
      if (Number.isFinite(details.seekTime)) seekTo(details.seekTime, details.fastSeek);
    }
  };
  for (const [action, handler] of Object.entries(actions)) {
    try {
      nativeSetActionHandler(action, handler);
    } catch {}
  }

  window.__ytmDesktopMediaSessionController = {
    publish(value = {}) {
      try {
        if (value.metadata && nativeSetMetadata && typeof MediaMetadata !== 'undefined') {
          nativeSetMetadata(new MediaMetadata(value.metadata));
        }
        if (value.playbackState && nativeSetPlaybackState) {
          nativeSetPlaybackState(value.playbackState);
        }
        if (value.resetPosition === true) {
          nativeSetPositionState();
          lastPositionState = null;
        }
        if (value.positionState) {
          nativeSetPositionState(value.positionState);
          lastPositionState = value.positionState;
        }
      } catch {}
    }
  };

  for (const [property, descriptor] of [
    ['metadata', metadataDescriptor],
    ['playbackState', playbackDescriptor]
  ]) {
    try {
      Object.defineProperty(session, property, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: descriptor?.get ? () => descriptor.get.call(session) : () => undefined,
        set: () => {}
      });
    } catch {}
  }
  for (const method of ['setActionHandler', 'setPositionState']) {
    try {
      Object.defineProperty(session, method, {
        configurable: true,
        value: () => {},
        writable: false
      });
    } catch {}
  }
}

function installPageMediaSessionGuard() {
  try {
    contextBridge.executeInMainWorld({ func: claimPageMediaSession });
  } catch (error) {
    console.warn('Unable to claim the page media session:', error.message);
  }
}

installPageMediaSessionGuard();

function samplePagePlayback() {
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const callNumber = (target, method) => {
    try {
      return number(target?.[method]?.());
    } catch {
      return null;
    }
  };
  const players = [...document.querySelectorAll('#movie_player')];
  let player = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of players) {
    const mediaElements = [...candidate.querySelectorAll('video, audio')];
    const state = callNumber(candidate, 'getPlayerState');
    const playing = mediaElements.some((media) => !media.paused && !media.ended && media.currentSrc);
    const visible = mediaElements.some((media) => {
      const bounds = media.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const score = (playing || state === 1 ? 300 : 0)
      + (state === 2 ? 120 : 0)
      + (visible ? 80 : 0)
      + (mediaElements.some((media) => media.currentSrc) ? 10 : 0);
    if (score >= bestScore) {
      player = candidate;
      bestScore = score;
    }
  }
  if (!player) {
    return null;
  }
  const response = (() => {
    try {
      return player.getPlayerResponse?.() || null;
    } catch {
      return null;
    }
  })();
  const details = response?.videoDetails || {};
  const mediaElements = [...player.querySelectorAll('video, audio')];
  const media = mediaElements.find((element) => !element.paused && !element.ended && element.currentSrc)
    || mediaElements.find((element) => element.currentSrc)
    || mediaElements[0]
    || null;
  const adElement = player.querySelector(
    '.ytp-ad-player-overlay, .ytp-ad-preview-container, .ytp-ad-text'
  );
  const adVisible = adElement && (() => {
    const bounds = adElement.getBoundingClientRect();
    const style = getComputedStyle(adElement);
    return bounds.width > 0 && bounds.height > 0
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  })();
  const isAd = player.classList.contains('ad-showing')
    || player.classList.contains('ad-interrupting')
    || callNumber(player, 'getAdState') === 1
    || Boolean(adVisible);
  const playerBars = [...document.querySelectorAll('ytmusic-player-bar')];
  const playerBar = playerBars.find((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }) || playerBars.at(-1) || null;
  const titleElement = playerBar?.querySelector('.title');
  const barLink = titleElement?.closest?.('a[href*="watch"]')
    || titleElement?.querySelector?.('a[href*="watch"]')
    || null;
  let playerBarVideoId = '';
  try {
    playerBarVideoId = barLink?.href
      ? new URL(barLink.href, location.href).searchParams.get('v') || ''
      : '';
  } catch {}
  const artwork = [...(playerBar?.querySelectorAll(
    '.thumbnail-image-wrapper img, ytmusic-player-bar-thumbnail img, yt-img-shadow img, img.image'
  ) || [])].map((image) => ({
    height: image.naturalHeight || image.height,
    src: image.currentSrc || image.src,
    width: image.naturalWidth || image.width
  }));
  const captionRenderer = response?.captions?.playerCaptionsTracklistRenderer;
  const defaultCaptionIndexes = new Set(
    (Array.isArray(captionRenderer?.audioTracks) ? captionRenderer.audioTracks : [])
      .map((track) => number(track?.defaultCaptionTrackIndex))
      .filter((index) => index !== null && index >= 0)
  );
  return {
    details: {
      author: String(details.author || ''),
      captionTracks: Array.isArray(captionRenderer?.captionTracks)
        ? captionRenderer.captionTracks.slice(0, 50).map((track, index) => ({
          baseUrl: String(track?.baseUrl || ''),
          isDefault: defaultCaptionIndexes.has(index),
          kind: String(track?.kind || ''),
          languageCode: String(track?.languageCode || ''),
          vssId: String(track?.vssId || '')
        })) : [],
      lengthSeconds: number(details.lengthSeconds) || 0,
      musicVideoType: String(details.musicVideoType || ''),
      thumbnails: Array.isArray(details.thumbnail?.thumbnails)
        ? details.thumbnail.thumbnails.map((thumbnail) => ({
          height: number(thumbnail?.height) || 0,
          url: String(thumbnail?.url || ''),
          width: number(thumbnail?.width) || 0
        }))
        : [],
      title: String(details.title || ''),
      videoId: String(details.videoId || '')
    },
    isAd,
    media: media ? {
      duration: number(media.duration),
      paused: media.paused,
      playbackRate: number(media.playbackRate),
      position: number(media.currentTime)
    } : null,
    player: {
      duration: callNumber(player, 'getDuration'),
      playbackRate: callNumber(player, 'getPlaybackRate'),
      position: callNumber(player, 'getCurrentTime'),
      state: callNumber(player, 'getPlayerState')
    },
    playerBar: {
      artwork,
      byline: String(playerBar?.querySelector('yt-formatted-string.byline, .byline, .subtitle')?.textContent || '').trim(),
      timeText: String(playerBar?.querySelector('.time-info, #time-info')?.textContent || '').trim(),
      title: String(titleElement?.textContent || '').trim(),
      videoId: playerBarVideoId
    }
  };
}

function seekPagePlayback(expectedVideoId, requestedPosition) {
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const callNumber = (target, method) => {
    try {
      return number(target?.[method]?.());
    } catch {
      return null;
    }
  };
  const players = [...document.querySelectorAll('#movie_player')];
  let player = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of players) {
    const mediaElements = [...candidate.querySelectorAll('video, audio')];
    const state = callNumber(candidate, 'getPlayerState');
    const playing = mediaElements.some((media) => !media.paused && !media.ended && media.currentSrc);
    const visible = mediaElements.some((media) => {
      const bounds = media.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const score = (playing || state === 1 ? 300 : 0)
      + (state === 2 ? 120 : 0)
      + (visible ? 80 : 0)
      + (mediaElements.some((media) => media.currentSrc) ? 10 : 0);
    if (score >= bestScore) {
      player = candidate;
      bestScore = score;
    }
  }
  if (!player) {
    return false;
  }

  let activeVideoId = '';
  try {
    activeVideoId = String(player.getPlayerResponse?.()?.videoDetails?.videoId || '');
  } catch {}
  if (!expectedVideoId || activeVideoId !== expectedVideoId) {
    return false;
  }

  const position = Math.max(0, number(requestedPosition) || 0);
  try {
    if (typeof player.seekTo === 'function') {
      player.seekTo(position, true);
      return true;
    }
  } catch {}
  const mediaElements = [...player.querySelectorAll('video, audio')];
  const media = mediaElements.find((element) => !element.paused && !element.ended && element.currentSrc)
    || mediaElements.find((element) => element.currentSrc)
    || mediaElements[0];
  if (!media) {
    return false;
  }
  media.currentTime = position;
  return true;
}


const icons = {
  minimize: [['path', { d: 'M5 12h14' }]],
  maximize: [['rect', { x: '5', y: '5', width: '14', height: '14', rx: '1' }]],
  restore: [['path', { d: 'M8 8V5h11v11h-3M5 8h11v11H5z' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  undo: [['path', { d: 'M9 7 4 12l5 5M4 12h9a7 7 0 0 1 7 7' }]],
  redo: [['path', { d: 'm15 7 5 5-5 5M20 12h-9a7 7 0 0 0-7 7' }]],
  cut: [
    ['circle', { cx: '6', cy: '7', r: '3' }],
    ['circle', { cx: '6', cy: '17', r: '3' }],
    ['path', { d: 'm8.6 8.5 10.4 7M8.6 15.5 19 8.5' }]
  ],
  copy: [
    ['rect', { x: '8', y: '8', width: '11', height: '11', rx: '2' }],
    ['path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }]
  ],
  paste: [
    ['path', { d: 'M9 5h6M9 3h6v4H9zM9 17h6' }],
    ['path', { d: 'M7 5H5v16h14V5h-2' }]
  ],
  selectAll: [['path', { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5M9 15l3-7 3 7M10 13h4' }]],
  external: [['path', { d: 'M14 4h6v6M20 4 11 13M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }]],
  link: [['path', { d: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1' }]],
  translate: [
    ['path', { d: 'm5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6' }]
  ],
  reload: [['path', { d: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }]]
};

function getAppearanceStrings() {
  const language = document.documentElement.lang;
  return { ...getLocalizedAppearanceStrings(language), ...getAppStrings(language) };
}

function getLyricsSourceText(strings = getAppearanceStrings()) {
  return currentLyricsResult?.source === 'netease'
    ? strings.neteaseSource
    : currentLyricsResult?.source === 'youtube-cc'
      ? strings.captionSource
      : strings.lyricsSource;
}

function getTranslationSourceText(provider, strings = getAppearanceStrings()) {
  if (provider === 'netease') {
    return strings.neteaseTranslationSource;
  }
  if (provider === 'deepl') {
    return strings.deeplTranslationSource;
  }
  return provider === 'azure' ? strings.azureTranslationSource : strings.translationSource;
}

function getLyricsSourceAttribution(panel, originalText, strings = getAppearanceStrings()) {
  if (panel.dataset.translated !== 'true') {
    return originalText;
  }
  return [
    originalText,
    ...(panel.dataset.translationInputSource === 'netease-zh'
      ? [strings.neteaseChineseSourceLabel]
      : []),
    getTranslationSourceText(panel.dataset.translationProvider, strings)
  ].join(' · ');
}

function updateWindowControlLocalization() {
  const strings = getAppearanceStrings();
  const controls = document.getElementById(CONTROL_ID);
  controls?.setAttribute('aria-label', strings.windowControls);
  const labels = {
    close: strings.close,
    minimize: strings.minimize,
    'toggle-maximize': windowIsMaximized ? strings.restore : strings.maximize
  };
  for (const button of controls?.querySelectorAll('.ytm-desktop-control') || []) {
    const label = labels[button.dataset.action];
    if (label) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }
}

function refreshInjectedLocalization() {
  const strings = getAppearanceStrings();
  document.documentElement.dataset.ytmDesktopLocale = normalizeUiLocale(
    document.documentElement.lang
  );
  closeSettingPicker();
  closeMaterialContextMenu();
  if (document.getElementById(CONSENT_DIALOG_ID)) {
    closeConsentDialog(false);
  }
  closeCloseDialog(true);
  updateWindowControlLocalization();

  for (const settingsPage of document.querySelectorAll('ytmusic-settings-page')) {
    const active = settingsPage.classList.contains('ytm-desktop-style-active');
    const styleItem = settingsPage.querySelector('.ytm-desktop-style-category');
    const title = styleItem?.querySelector('.title');
    if (title) {
      title.textContent = strings.otherCategory;
    }
    const oldPanel = settingsPage.querySelector(`#${STYLE_PANEL_ID}`);
    if (oldPanel) {
      oldPanel.replaceWith(createStylePanel());
      if (active) {
        setStylePanelActive(settingsPage, true);
      }
    }
  }
  updateAppearanceControls();

  for (const panel of getLyricsPanels()) {
    panel.setAttribute('aria-label', strings.lyricsTitle);
    const status = panel.querySelector('.ytm-desktop-lyrics-status');
    if (status && !status.hidden) {
      const messages = {
        empty: strings.lyricsNotFound,
        error: strings.lyricsError,
        loading: strings.lyricsLoading
      };
      if (messages[currentLyricsState]) {
        status.textContent = messages[currentLyricsState];
      }
    }
    const source = panel.querySelector('.ytm-desktop-lyrics-source');
    if (source && !source.hidden) {
      const originalText = getLyricsSourceText(strings);
      source.dataset.originalText = originalText;
      source.textContent = getLyricsSourceAttribution(panel, originalText, strings);
    }
    const translateButton = panel.querySelector('.ytm-desktop-lyrics-translate');
    if (translateButton) {
      const label = translateButton.classList.contains('loading')
        ? strings.translatingLyrics
        : translateButton.classList.contains('error')
          ? strings.translationError
          : panel.dataset.translated === 'true'
            ? strings.showOriginalLyrics
            : strings.translateLyrics;
      translateButton.title = label;
      translateButton.setAttribute('aria-label', label);
    }
    delete panel.dataset.autoTranslationChecked;
  }
  lyricsTranslationRequestToken += 1;
  requestLyricsRefresh();
}

function handleDocumentLanguageChange() {
  const language = String(document.documentElement.lang || '').toLowerCase();
  const locale = normalizeUiLocale(document.documentElement.lang);
  if (language === currentDocumentLanguage) {
    return;
  }
  currentDocumentLanguage = language;
  currentUiLocale = locale;
  refreshInjectedLocalization();
}

function installLanguageMonitor() {
  currentDocumentLanguage = String(document.documentElement.lang || '').toLowerCase();
  currentUiLocale = normalizeUiLocale(document.documentElement.lang);
  document.documentElement.dataset.ytmDesktopLocale = currentUiLocale;
  const observer = new MutationObserver(handleDocumentLanguageChange);
  observer.observe(document.documentElement, {
    attributeFilter: ['lang'],
    attributes: true
  });
}

function installPageLoadingGuard() {
  if (!document.documentElement) {
    document.addEventListener('readystatechange', installPageLoadingGuard, { once: true });
    return;
  }
  if (document.getElementById(LOADING_GUARD_ID)) {
    return;
  }

  document.documentElement.classList.add('ytm-desktop-page-loading');
  const style = document.createElement('style');
  style.id = `${LOADING_GUARD_ID}-style`;
  style.textContent = `
    html.ytm-desktop-page-loading,
    html.ytm-desktop-page-loading body { background: #000 !important; }
    #${LOADING_GUARD_ID} {
      align-items: center; background: #000; display: flex; inset: 0; justify-content: center;
      opacity: 1; pointer-events: all; position: fixed; transition: opacity 220ms cubic-bezier(.2,0,0,1);
      z-index: 2147483647;
    }
    #${LOADING_GUARD_ID}.ready { opacity: 0; pointer-events: none; }
    #${LOADING_GUARD_ID} svg { animation: ytm-desktop-loading-rotate 1.35s linear infinite; height: 34px; width: 34px; }
    #${LOADING_GUARD_ID} circle {
      animation: ytm-desktop-loading-dash 1.35s ease-in-out infinite; fill: none; stroke: #fff;
      stroke-dasharray: 1,120; stroke-linecap: round; stroke-width: 3.5;
    }
    @keyframes ytm-desktop-loading-rotate { to { transform: rotate(360deg); } }
    @keyframes ytm-desktop-loading-dash {
      0% { stroke-dasharray: 1,120; stroke-dashoffset: 0; }
      50% { stroke-dasharray: 82,120; stroke-dashoffset: -34; }
      100% { stroke-dasharray: 82,120; stroke-dashoffset: -112; }
    }
  `;
  document.documentElement.appendChild(style);

  const guard = document.createElement('div');
  const namespace = 'http://www.w3.org/2000/svg';
  const spinner = document.createElementNS(namespace, 'svg');
  const circle = document.createElementNS(namespace, 'circle');
  guard.id = LOADING_GUARD_ID;
  guard.setAttribute(
    'aria-label',
    getAppStrings(document.documentElement.lang).splashLoading
  );
  guard.setAttribute('role', 'status');
  spinner.setAttribute('viewBox', '0 0 48 48');
  spinner.setAttribute('aria-hidden', 'true');
  circle.setAttribute('cx', '24');
  circle.setAttribute('cy', '24');
  circle.setAttribute('r', '19');
  spinner.appendChild(circle);
  guard.appendChild(spinner);
  document.documentElement.appendChild(guard);
}

function hidePageLoadingGuard() {
  const guard = document.getElementById(LOADING_GUARD_ID);
  if (!guard || guard.classList.contains('ready')) {
    return;
  }

  guard.classList.add('ready');
  window.setTimeout(() => {
    guard.remove();
    document.documentElement.classList.remove('ytm-desktop-page-loading');
    document.getElementById(`${LOADING_GUARD_ID}-style`)?.remove();
  }, 240);
}

installPageLoadingGuard();

function createIcon(definition) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  for (const [tagName, attributes] of definition) {
    const element = document.createElementNS(namespace, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    svg.appendChild(element);
  }

  return svg;
}

function updateAppearanceControls() {
  const simplifiedChinese = normalizeUiLocale(document.documentElement.lang) === 'zh-cn';
  for (const button of document.querySelectorAll('.ytm-desktop-setting-toggle[data-setting]')) {
    const checked = appearanceSettings[button.dataset.setting] === true;
    button.classList.toggle('checked', checked);
    button.disabled = (button.dataset.setting === 'neteaseLyrics'
      && !appearanceSettings.lrclibLyrics)
      || (button.dataset.setting === 'neteaseTranslationSource'
        && (!appearanceSettings.lrclibLyrics
          || !appearanceSettings.neteaseLyrics
          || simplifiedChinese));
    if (button.getAttribute('aria-checked') !== String(checked)) {
      button.setAttribute('aria-checked', String(checked));
    }
  }
  for (const select of document.querySelectorAll('.ytm-desktop-setting-select[data-setting]')) {
    const value = appearanceSettings[select.dataset.setting];
    select.disabled = select.dataset.setting === 'lyricsTranslationProvider'
      && !appearanceSettings.lrclibLyrics;
    const option = select._settingOptions?.find((candidate) => candidate.value === value);
    if (option) {
      select.dataset.value = value;
      const label = select.querySelector('.ytm-desktop-setting-select-value');
      if (label && label.textContent !== option.label) {
        label.textContent = option.label;
      }
    }
  }
  for (const row of document.querySelectorAll(
    '.ytm-desktop-setting-row[data-setting-row="autoTranslateLyrics"],'
    + '.ytm-desktop-setting-row[data-setting-row="lyricsTranslationProvider"]'
  )) {
    row.hidden = !appearanceSettings.lrclibLyrics;
  }
  for (const row of document.querySelectorAll(
    '.ytm-desktop-setting-row[data-setting-row="neteaseLyrics"]'
  )) {
    row.hidden = !appearanceSettings.lrclibLyrics;
  }
  for (const row of document.querySelectorAll(
    '.ytm-desktop-setting-row[data-setting-row="neteaseTranslationSource"]'
  )) {
    row.hidden = !appearanceSettings.lrclibLyrics
      || !appearanceSettings.neteaseLyrics
      || simplifiedChinese;
  }
  const deeplRow = document.querySelector(
    '.ytm-desktop-setting-row[data-setting-row="deeplApiKey"]'
  );
  if (deeplRow) {
    const strings = getAppearanceStrings();
    deeplRow.hidden = !appearanceSettings.lrclibLyrics
      || appearanceSettings.lyricsTranslationProvider !== 'deepl';
    const summary = deeplRow.querySelector('.ytm-desktop-setting-summary');
    const button = deeplRow.querySelector('.ytm-desktop-setting-action');
    if (summary) {
      summary.textContent = appearanceSettings.deeplConfigured
        ? strings.deeplApiKeyConfiguredDescription
        : strings.deeplApiKeyMissingDescription;
    }
    if (button) {
      button.textContent = appearanceSettings.deeplConfigured
        ? strings.deeplUpdate
        : strings.deeplConfigure;
    }
  }
  const azureRow = document.querySelector(
    '.ytm-desktop-setting-row[data-setting-row="azureApiKey"]'
  );
  if (azureRow) {
    const strings = getAppearanceStrings();
    azureRow.hidden = !appearanceSettings.lrclibLyrics
      || appearanceSettings.lyricsTranslationProvider !== 'azure';
    const summary = azureRow.querySelector('.ytm-desktop-setting-summary');
    const button = azureRow.querySelector('.ytm-desktop-setting-action');
    if (summary) {
      summary.textContent = appearanceSettings.azureConfigured
        ? strings.azureApiKeyConfiguredDescription
        : strings.azureApiKeyMissingDescription;
    }
    if (button) {
      button.textContent = appearanceSettings.azureConfigured
        ? strings.azureUpdate
        : strings.azureConfigure;
    }
  }
}

function applyAppearanceSettings(value = {}, options = {}) {
  const animationsWereEnabled = appearanceSettings.animations;
  const autoTranslateWasEnabled = appearanceSettings.autoTranslateLyrics;
  const previousLyricsEnabled = appearanceSettings.lrclibLyrics;
  const previousNeteaseEnabled = appearanceSettings.neteaseLyrics;
  const previousNeteaseTranslationSource = appearanceSettings.neteaseTranslationSource;
  const previousTranslationProvider = appearanceSettings.lyricsTranslationProvider;
  appearanceSettings = {
    animations: value.animations === true,
    autoTranslateLyrics: value.autoTranslateLyrics === true,
    azureConfigured: value.azureConfigured === true,
    closeAction: ['ask', 'tray', 'quit'].includes(value.closeAction)
      ? value.closeAction
      : 'tray',
    deeplConfigured: value.deeplConfigured === true,
    lrclibLyrics: value.lrclibLyrics === true,
    lyricsTranslationProvider: ['deepl', 'azure'].includes(value.lyricsTranslationProvider)
      ? value.lyricsTranslationProvider
      : 'google',
    neteaseLyrics: value.neteaseLyrics === true,
    neteaseTranslationSource: value.neteaseTranslationSource === true,
    translucentSurfaces: value.translucentSurfaces === true
  };
  document.documentElement.classList.toggle(
    'ytm-desktop-animations',
    appearanceSettings.animations
  );
  document.documentElement.classList.toggle(
    'ytm-desktop-translucent',
    appearanceSettings.translucentSurfaces
  );
  document.documentElement.classList.toggle(
    'ytm-desktop-lrclib-lyrics',
    appearanceSettings.lrclibLyrics
  );
  updateAppearanceControls();
  const lyricsIntegrationChanged = !appearanceSettingsInitialized
    || previousLyricsEnabled !== appearanceSettings.lrclibLyrics
    || previousNeteaseEnabled !== appearanceSettings.neteaseLyrics;
  const translationProviderChanged = previousTranslationProvider
    !== appearanceSettings.lyricsTranslationProvider;
  const translationSourceChanged = previousNeteaseTranslationSource
    !== appearanceSettings.neteaseTranslationSource;
  const autoTranslationChanged = autoTranslateWasEnabled !== appearanceSettings.autoTranslateLyrics
    || translationProviderChanged
    || translationSourceChanged;
  const deferLyricsApply = options.deferLyricsRefresh === true
    && (lyricsIntegrationChanged || autoTranslationChanged);
  if (translationProviderChanged || translationSourceChanged) {
    lyricsTranslationCache.clear();
    lyricsTranslationRequestToken += 1;
    const panel = getCurrentLyricsPanel();
    if (panel?.dataset.translated === 'true') {
      applyLyricsTranslation(panel, null);
    }
  }
  if (autoTranslationChanged && appearanceSettings.autoTranslateLyrics) {
    const panel = getCurrentLyricsPanel();
    if (panel) {
      delete panel.dataset.autoTranslationChecked;
    }
  }
  appearanceSettingsInitialized = true;
  if (deferLyricsApply) {
    pendingLyricsIntegrationRefresh = true;
  } else if (lyricsIntegrationChanged) {
    pendingLyricsIntegrationRefresh = false;
    refreshLyricsIntegration();
  }
  if (appearanceSettings.animations && !animationsWereEnabled) {
    for (const surface of getAnimationSurfaces()) {
      surfaceVisibility.set(surface, false);
    }
  }
  requestSurfaceAnimationRefresh();
  if (!deferLyricsApply && !pendingLyricsIntegrationRefresh) {
    window.queueMicrotask(refreshAutomaticLyricsTranslation);
  }
}

function isVisibleSurface(element) {
  if (!element.isConnected || element.hidden) {
    return false;
  }
  if (element.matches('ytmusic-search-box #suggestion-list')) {
    const searchInput = element.closest('ytmusic-search-box')?.querySelector(
      'input[role="combobox"]'
    );
    if (searchInput?.getAttribute('aria-expanded') === 'false') {
      return false;
    }
    const hasVisibleContent = [...element.children].some((child) => {
      if (child.matches('dom-repeat, template')) {
        return false;
      }
      const childBounds = child.getBoundingClientRect();
      const childStyle = getComputedStyle(child);
      return childBounds.width > 0
        && childBounds.height > 0
        && childStyle.display !== 'none'
        && childStyle.visibility !== 'hidden';
    });
    if (!hasVisibleContent) {
      return false;
    }
  }
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return bounds.width > 0
    && bounds.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden';
}

function getAnimationSurfaces() {
  return [...document.querySelectorAll(SURFACE_SELECTOR)].filter((element) => (
    element.matches('ytmusic-search-box #suggestion-list')
    || !element.parentElement?.closest(MENU_SURFACE_SELECTOR)
  ));
}

function getSurfaceAnimationKey(surface) {
  return surface.matches('ytmusic-search-box #suggestion-list')
    ? 'search-suggestions'
    : 'account-menu';
}

function rememberSurfaceTriggerPoint(event) {
  lastSurfaceTriggerPoint = {
    time: performance.now(),
    x: event.clientX,
    y: event.clientY
  };
}

function getSurfaceRevealDirection(surface) {
  if (surface.matches('ytmusic-search-box #suggestion-list')) {
    return 'down';
  }
  const point = lastSurfaceTriggerPoint;
  if (!point || performance.now() - point.time > 1500) {
    return 'down';
  }
  const bounds = surface.getBoundingClientRect();
  if (bounds.bottom <= point.y + 24) {
    return 'up';
  }
  if (bounds.top >= point.y - 24) {
    return 'down';
  }
  return point.y > bounds.top + bounds.height / 2 ? 'up' : 'down';
}

function syncSearchBackdrop(surface, visible) {
  let backdrop = document.getElementById(SEARCH_BACKDROP_ID);
  if (!appearanceSettings.translucentSurfaces || !visible) {
    if (backdrop) {
      backdrop.hidden = true;
    }
    return null;
  }
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = SEARCH_BACKDROP_ID;
    backdrop.setAttribute('aria-hidden', 'true');
    document.body.appendChild(backdrop);
  }
  const bounds = surface.getBoundingClientRect();
  backdrop.style.borderRadius = getComputedStyle(surface).borderRadius;
  backdrop.style.height = `${bounds.height}px`;
  backdrop.style.left = `${bounds.left}px`;
  backdrop.style.top = `${bounds.top}px`;
  backdrop.style.width = `${bounds.width}px`;
  backdrop.hidden = false;
  return backdrop;
}

function refreshSurfaceAnimations() {
  for (const surface of getAnimationSurfaces()) {
    if (surfaceResizeObserver && !observedSurfaceSizes.has(surface)) {
      surfaceResizeObserver.observe(surface);
      observedSurfaceSizes.add(surface);
    }
    const visible = isVisibleSurface(surface);
    const wasVisible = surfaceVisibility.get(surface) === true;
    surfaceVisibility.set(surface, visible);
    const searchBackdrop = surface.matches('ytmusic-search-box #suggestion-list')
      ? syncSearchBackdrop(surface, visible)
      : null;
    if (!appearanceSettings.animations
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || !visible
      || wasVisible) {
      continue;
    }

    const animationKey = getSurfaceAnimationKey(surface);
    const now = performance.now();
    if (now - (surfaceAnimationTimes.get(animationKey) || 0) < 300) {
      continue;
    }
    surfaceAnimationTimes.set(animationKey, now);
    const revealDirection = getSurfaceRevealDirection(surface);
    for (const target of [searchBackdrop, surface].filter(Boolean)) {
      const animation = target.animate([
        {
          clipPath: revealDirection === 'up'
            ? 'inset(100% 0 0 0 round 8px)'
            : 'inset(0 0 100% 0 round 8px)'
        },
        { clipPath: 'inset(0 0 0 0 round 8px)' }
      ], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill: 'both'
      });
      animation.addEventListener('finish', () => animation.cancel(), { once: true });
    }
  }
}

function requestSurfaceAnimationRefresh() {
  refreshSurfaceAnimations();
  if (!surfaceAnimationFrame) {
    surfaceAnimationFrame = window.requestAnimationFrame(() => {
      surfaceAnimationFrame = null;
      refreshSurfaceAnimations();
    });
  }
}

function handleSurfaceMutations(records) {
  const relevant = records.some((record) => {
    const target = record.target instanceof Element ? record.target : null;
    if (target?.matches(SURFACE_SELECTOR)
      || target?.matches('tp-yt-iron-dropdown, ytmusic-popup-container, ytd-popup-container')
      || target?.closest('ytmusic-search-box')
      || target?.closest(MENU_SURFACE_SELECTOR)) {
      return true;
    }
    return [...record.addedNodes, ...record.removedNodes].some((node) => (
      node instanceof Element
      && (node.matches(SURFACE_SELECTOR) || Boolean(node.querySelector(SURFACE_SELECTOR)))
    ));
  });
  if (relevant) {
    requestSurfaceAnimationRefresh();
  }
}

function installSurfaceAnimations() {
  if (surfaceAnimationObserver) {
    return;
  }
  surfaceAnimationObserver = new MutationObserver(handleSurfaceMutations);
  surfaceResizeObserver = new ResizeObserver(requestSurfaceAnimationRefresh);
  surfaceAnimationObserver.observe(document.documentElement, {
    attributeFilter: ['aria-expanded', 'class', 'hidden', 'open', 'style'],
    attributes: true,
    childList: true,
    subtree: true
  });
  requestSurfaceAnimationRefresh();
}

function closeConsentDialog(result) {
  const dialog = document.getElementById(CONSENT_DIALOG_ID);
  if (!dialog) {
    return;
  }
  if (dialog._timer) {
    window.clearInterval(dialog._timer);
  }
  const settingsOverlay = dialog._settingsOverlay;
  if (settingsOverlay) {
    settingsOverlay.noCancelOnEscKey = dialog._previousNoCancelOnEscKey;
    settingsOverlay.noCancelOnOutsideClick = dialog._previousNoCancelOnOutsideClick;
    if (!dialog._hadNoCancelOnEscKeyAttribute) {
      settingsOverlay.removeAttribute('no-cancel-on-esc-key');
    }
    if (!dialog._hadNoCancelOnOutsideClickAttribute) {
      settingsOverlay.removeAttribute('no-cancel-on-outside-click');
    }
  }
  dialog.remove();
  dialog._resolve?.(result);
}

function showSettingConsent(kind) {
  const strings = getAppearanceStrings();
  const isNetease = kind === 'netease';
  const isNeteaseChineseSource = kind === 'netease-chinese-source';
  const language = document.documentElement.lang.toLowerCase();
  const isChinese = language.startsWith('zh');
  const waitSeconds = isNeteaseChineseSource || (isNetease && !isChinese) ? 5 : 3;
  const backdrop = document.createElement('div');
  const settingsDialog = document.querySelector('ytmusic-settings-page')?.closest('ytmusic-dialog');
  const settingsOverlay = settingsDialog?.querySelector('tp-yt-paper-dialog, paper-dialog')
    || settingsDialog;
  const surface = document.createElement('section');
  const heading = document.createElement('h2');
  const description = document.createElement('p');
  const actions = document.createElement('div');
  backdrop.id = CONSENT_DIALOG_ID;
  backdrop.className = 'ytm-material-dialog-backdrop';
  surface.className = 'ytm-material-dialog';
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  if (settingsOverlay) {
    backdrop._settingsOverlay = settingsOverlay;
    backdrop._previousNoCancelOnEscKey = settingsOverlay.noCancelOnEscKey === true;
    backdrop._previousNoCancelOnOutsideClick = settingsOverlay.noCancelOnOutsideClick === true;
    backdrop._hadNoCancelOnEscKeyAttribute = settingsOverlay.hasAttribute('no-cancel-on-esc-key');
    backdrop._hadNoCancelOnOutsideClickAttribute = settingsOverlay.hasAttribute(
      'no-cancel-on-outside-click'
    );
    settingsOverlay.noCancelOnEscKey = true;
    settingsOverlay.noCancelOnOutsideClick = true;
    settingsOverlay.setAttribute('no-cancel-on-esc-key', '');
    settingsOverlay.setAttribute('no-cancel-on-outside-click', '');
  }
  heading.textContent = isNeteaseChineseSource
    ? strings.neteaseChineseSourceConsentTitle
    : isNetease ? strings.neteaseConsentTitle : strings.lrclibConsentTitle;
  description.textContent = isNeteaseChineseSource
    ? strings.neteaseChineseSourceConsentDescription
    : isNetease && !isChinese
      ? getLocalizedAppearanceStrings('en-us').neteaseConsentDescription
      : isNetease ? strings.neteaseConsentDescription : strings.lrclibConsentDescription;
  actions.className = 'ytm-material-dialog-actions';
  const cancel = createDialogAction(strings.consentCancel, 'quiet', () => closeConsentDialog(false));
  const agree = createDialogAction(
    `${strings.consentAgree} (${waitSeconds})`,
    'primary',
    () => closeConsentDialog(true)
  );
  agree.disabled = true;
  actions.append(cancel, agree);
  surface.append(heading, description, actions);
  backdrop.appendChild(surface);
  const promise = new Promise((resolve) => {
    backdrop._resolve = resolve;
  });
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) {
      closeConsentDialog(false);
    }
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConsentDialog(false);
    }
  });
  (settingsDialog || document.body).appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add('open'));
  let remaining = waitSeconds;
  backdrop._timer = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      window.clearInterval(backdrop._timer);
      agree.disabled = false;
      agree.textContent = strings.consentAgree;
      agree.focus();
      return;
    }
    agree.textContent = `${strings.consentAgree} (${remaining})`;
  }, 1000);
  cancel.focus();
  return promise;
}

async function showDeepLConfigurationDialog() {
  closeSettingPicker();
  try {
    const nextSettings = await ipcRenderer.invoke('translation:open-deepl-config', {
      locale: document.documentElement.lang
    });
    applyAppearanceSettings(nextSettings);
    return nextSettings.deeplConfigured === true;
  } catch (error) {
    console.warn('Unable to open DeepL configuration:', error.message);
    return false;
  }
}

async function showAzureConfigurationDialog() {
  closeSettingPicker();
  try {
    const nextSettings = await ipcRenderer.invoke('translation:open-azure-config', {
      locale: document.documentElement.lang
    });
    applyAppearanceSettings(nextSettings);
    return nextSettings.azureConfigured === true;
  } catch (error) {
    console.warn('Unable to open Azure Translator configuration:', error.message);
    return false;
  }
}

async function updateAppearanceSetting(key, value, button) {
  button.disabled = true;
  try {
    if (value === true && (key === 'lrclibLyrics' || key === 'neteaseLyrics')) {
      const accepted = await showSettingConsent(key === 'neteaseLyrics' ? 'netease' : 'lrclib');
      if (!accepted) {
        return;
      }
    }
    if (value === true && key === 'neteaseTranslationSource') {
      const accepted = await showSettingConsent('netease-chinese-source');
      if (!accepted) {
        return;
      }
    }
    const nextSettings = await ipcRenderer.invoke('appearance:set', { [key]: value });
    applyAppearanceSettings(nextSettings, {
      deferLyricsRefresh: [
        'autoTranslateLyrics',
        'lrclibLyrics',
        'neteaseLyrics',
        'neteaseTranslationSource'
      ].includes(key)
    });
  } catch (error) {
    console.warn('Unable to update appearance settings:', error.message);
  } finally {
    button.disabled = false;
  }
}

function createSettingToggle(key, label) {
  const button = document.createElement('button');
  const track = document.createElement('span');
  const thumb = document.createElement('span');
  button.type = 'button';
  button.className = 'ytm-desktop-setting-toggle';
  button.dataset.setting = key;
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', label);
  track.className = 'ytm-desktop-setting-toggle-track';
  thumb.className = 'ytm-desktop-setting-toggle-thumb';
  button.append(track, thumb);
  button.addEventListener('click', () => {
    updateAppearanceSetting(key, !appearanceSettings[key], button);
  });
  return button;
}

function createAppearanceSettingRow(key, titleText, summaryText) {
  const row = document.createElement('div');
  const content = document.createElement('div');
  const title = document.createElement('div');
  const summary = document.createElement('div');
  row.className = 'ytm-desktop-setting-row';
  row.dataset.settingRow = key;
  content.className = 'ytm-desktop-setting-copy';
  title.className = 'ytm-desktop-setting-title';
  title.textContent = titleText;
  summary.className = 'ytm-desktop-setting-summary';
  summary.textContent = summaryText;
  content.append(title, summary);
  row.append(content, createSettingToggle(key, titleText));
  return row;
}

function closeSettingPicker(restoreFocus = false) {
  const picker = document.getElementById(SETTING_PICKER_ID);
  if (!picker) {
    return false;
  }
  const trigger = picker._trigger;
  picker.remove();
  trigger?.classList.remove('open');
  trigger?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) {
    trigger?.focus({ preventScroll: true });
  }
  return true;
}

function closeSettingPickerOnSettingsScroll(event) {
  const scrollTarget = event.target instanceof Element ? event.target : null;
  if (scrollTarget?.closest('ytmusic-settings-page')) {
    closeSettingPicker();
  }
}

function positionSettingPicker(picker, trigger) {
  const triggerBounds = trigger.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(
    window.innerWidth - margin * 2,
    Math.max(240, Math.round(triggerBounds.width))
  );
  picker.style.width = `${width}px`;
  const pickerHeight = picker.getBoundingClientRect().height;
  const opensAbove = triggerBounds.bottom + pickerHeight + margin > window.innerHeight
    && triggerBounds.top >= pickerHeight + margin;
  picker.dataset.openDirection = opensAbove ? 'up' : 'down';
  const top = opensAbove
    ? triggerBounds.top - pickerHeight - 4
    : triggerBounds.bottom + 4;
  const left = Math.max(
    margin,
    Math.min(triggerBounds.right - width, window.innerWidth - width - margin)
  );
  picker.style.left = `${Math.round(left)}px`;
  picker.style.top = `${Math.round(Math.max(margin, top))}px`;
}

function openSettingPicker(trigger) {
  const existing = document.getElementById(SETTING_PICKER_ID);
  if (existing?._trigger === trigger) {
    closeSettingPicker(true);
    return;
  }
  closeSettingPicker();
  const options = trigger._settingOptions || [];
  const picker = document.createElement('div');
  picker.id = SETTING_PICKER_ID;
  picker.className = 'ytm-desktop-setting-picker';
  picker.setAttribute('role', 'listbox');
  picker.setAttribute('aria-label', trigger.getAttribute('aria-label') || '');
  picker._trigger = trigger;
  const optionButtons = [];
  const focusOption = (index) => {
    optionButtons[(index + optionButtons.length) % optionButtons.length]?.focus();
  };
  for (const option of options) {
    const button = document.createElement('button');
    const selected = option.value === appearanceSettings[trigger.dataset.setting];
    button.type = 'button';
    button.className = 'ytm-desktop-setting-picker-option';
    button.dataset.value = option.value;
    button.textContent = option.label;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(selected));
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      for (const candidate of optionButtons) candidate.disabled = true;
      try {
        const key = trigger.dataset.setting;
        if (key === 'lyricsTranslationProvider' && option.value === 'deepl'
          && !appearanceSettings.deeplConfigured) {
          closeSettingPicker();
          const configured = await showDeepLConfigurationDialog();
          if (!configured) {
            trigger.focus({ preventScroll: true });
            return;
          }
        }
        if (key === 'lyricsTranslationProvider' && option.value === 'azure'
          && !appearanceSettings.azureConfigured) {
          closeSettingPicker();
          const configured = await showAzureConfigurationDialog();
          if (!configured) {
            trigger.focus({ preventScroll: true });
            return;
          }
        }
        const nextSettings = await ipcRenderer.invoke('appearance:set', {
          [key]: option.value
        });
        applyAppearanceSettings(nextSettings);
        closeSettingPicker(true);
      } catch (error) {
        console.warn('Unable to update appearance settings:', error.message);
        for (const candidate of optionButtons) candidate.disabled = false;
      }
    });
    button.addEventListener('keydown', (event) => {
      const index = optionButtons.indexOf(button);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(index + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusOption(optionButtons.length - 1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeSettingPicker(true);
      }
    });
    optionButtons.push(button);
    picker.appendChild(button);
  }
  document.body.appendChild(picker);
  trigger.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  positionSettingPicker(picker, trigger);
  window.requestAnimationFrame(() => {
    picker.classList.add('open');
    (optionButtons.find((button) => button.getAttribute('aria-selected') === 'true')
      || optionButtons[0])?.focus({ preventScroll: true });
  });
}

function createAppearanceSelectRow(key, titleText, summaryText, options) {
  const row = document.createElement('div');
  const content = document.createElement('div');
  const title = document.createElement('div');
  const summary = document.createElement('div');
  const select = document.createElement('button');
  const value = document.createElement('span');
  const chevron = createIcon(icons.chevronDown);
  row.className = 'ytm-desktop-setting-row ytm-desktop-setting-select-row';
  row.dataset.settingRow = key;
  content.className = 'ytm-desktop-setting-copy';
  title.className = 'ytm-desktop-setting-title';
  title.textContent = titleText;
  summary.className = 'ytm-desktop-setting-summary';
  summary.textContent = summaryText;
  select.className = 'ytm-desktop-setting-select';
  select.type = 'button';
  select.dataset.setting = key;
  select._settingOptions = options.map((option) => ({ ...option }));
  select.setAttribute('aria-label', titleText);
  select.setAttribute('aria-haspopup', 'listbox');
  select.setAttribute('aria-expanded', 'false');
  value.className = 'ytm-desktop-setting-select-value';
  chevron.setAttribute('class', 'ytm-desktop-setting-select-chevron');
  chevron.setAttribute('aria-hidden', 'true');
  select.append(value, chevron);
  select.addEventListener('click', () => openSettingPicker(select));
  select.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openSettingPicker(select);
    }
  });
  content.append(title, summary);
  row.append(content, select);
  return row;
}

function createDeepLKeyRow(strings) {
  const row = document.createElement('div');
  const content = document.createElement('div');
  const title = document.createElement('div');
  const summary = document.createElement('div');
  const button = document.createElement('button');
  row.className = 'ytm-desktop-setting-row ytm-desktop-setting-select-row';
  row.dataset.settingRow = 'deeplApiKey';
  content.className = 'ytm-desktop-setting-copy';
  title.className = 'ytm-desktop-setting-title';
  title.textContent = strings.deeplApiKeyTitle;
  summary.className = 'ytm-desktop-setting-summary';
  summary.textContent = appearanceSettings.deeplConfigured
    ? strings.deeplApiKeyConfiguredDescription
    : strings.deeplApiKeyMissingDescription;
  button.type = 'button';
  button.className = 'ytm-desktop-setting-action';
  button.textContent = appearanceSettings.deeplConfigured
    ? strings.deeplUpdate
    : strings.deeplConfigure;
  button.addEventListener('click', () => showDeepLConfigurationDialog());
  content.append(title, summary);
  row.append(content, button);
  return row;
}

function createAzureKeyRow(strings) {
  const row = document.createElement('div');
  const content = document.createElement('div');
  const title = document.createElement('div');
  const summary = document.createElement('div');
  const button = document.createElement('button');
  row.className = 'ytm-desktop-setting-row ytm-desktop-setting-select-row';
  row.dataset.settingRow = 'azureApiKey';
  content.className = 'ytm-desktop-setting-copy';
  title.className = 'ytm-desktop-setting-title';
  title.textContent = strings.azureApiKeyTitle;
  summary.className = 'ytm-desktop-setting-summary';
  summary.textContent = appearanceSettings.azureConfigured
    ? strings.azureApiKeyConfiguredDescription
    : strings.azureApiKeyMissingDescription;
  button.type = 'button';
  button.className = 'ytm-desktop-setting-action';
  button.textContent = appearanceSettings.azureConfigured
    ? strings.azureUpdate
    : strings.azureConfigure;
  button.addEventListener('click', () => showAzureConfigurationDialog());
  content.append(title, summary);
  row.append(content, button);
  return row;
}

function createStylePanel() {
  const strings = getAppearanceStrings();
  const panel = document.createElement('section');
  const content = document.createElement('div');
  panel.id = STYLE_PANEL_ID;
  panel.className = 'ytm-desktop-style-panel style-scope ytmusic-settings-page';
  panel.hidden = true;
  content.className = 'ytm-desktop-style-panel-content';
  content.append(
    createAppearanceSettingRow(
      'translucentSurfaces',
      strings.transparencyTitle,
      strings.transparencyDescription
    ),
    createAppearanceSettingRow(
      'animations',
      strings.animationsTitle,
      strings.animationsDescription
    ),
    createAppearanceSettingRow(
      'lrclibLyrics',
      strings.lyricsTitle,
      strings.lyricsDescription
    ),
    createAppearanceSettingRow(
      'neteaseLyrics',
      strings.neteaseTitle,
      strings.neteaseDescription
    ),
    createAppearanceSettingRow(
      'neteaseTranslationSource',
      strings.neteaseChineseSourceTitle,
      strings.neteaseChineseSourceDescription
    ),
    createAppearanceSettingRow(
      'autoTranslateLyrics',
      strings.autoTranslateTitle,
      strings.autoTranslateDescription
    ),
    createAppearanceSelectRow(
      'lyricsTranslationProvider',
      strings.translationProviderTitle,
      strings.translationProviderDescription,
      [
        { label: strings.translationProviderGoogle, value: 'google' },
        { label: strings.translationProviderDeepL, value: 'deepl' },
        { label: strings.translationProviderAzure, value: 'azure' }
      ]
    ),
    createDeepLKeyRow(strings),
    createAzureKeyRow(strings),
    createAppearanceSelectRow(
      'closeAction',
      strings.closeActionTitle,
      strings.closeActionDescription,
      [
        { label: strings.closeActionAsk, value: 'ask' },
        { label: strings.closeActionTray, value: 'tray' },
        { label: strings.closeActionQuit, value: 'quit' }
      ]
    )
  );
  panel.appendChild(content);
  return panel;
}

function getSettingsContent(settingsPage, styleActive) {
  return styleActive
    ? settingsPage.querySelector(`#${STYLE_PANEL_ID} .ytm-desktop-style-panel-content`)
    : settingsPage.querySelector('ytmusic-setting-category-collection-renderer > #items');
}

function playSettingsContentPhase(content, phase) {
  if (!appearanceSettings.animations || !content) {
    return;
  }

  const now = performance.now();
  const times = settingsContentAnimationTimes.get(content) || {};
  if (now - (times[phase] || 0) < 350) {
    return;
  }
  times[phase] = now;
  settingsContentAnimationTimes.set(content, times);

  content.classList.remove('ytm-desktop-settings-entering', 'ytm-desktop-settings-leaving');
  void content.offsetWidth;
  content.classList.add(`ytm-desktop-settings-${phase}`);
  window.setTimeout(() => content.classList.remove(`ytm-desktop-settings-${phase}`), 210);
}

function transitionSettingsContent(settingsPage, styleActive, activateContent) {
  if (!appearanceSettings.animations) {
    setStylePanelActive(settingsPage, styleActive);
    activateContent?.();
    return;
  }

  const transitionToken = (settingsPage.ytmDesktopTransitionToken || 0) + 1;
  settingsPage.ytmDesktopTransitionToken = transitionToken;
  const currentContent = getSettingsContent(
    settingsPage,
    settingsPage.classList.contains('ytm-desktop-style-active')
  );
  playSettingsContentPhase(currentContent, 'leaving');

  window.setTimeout(() => {
    if (settingsPage.ytmDesktopTransitionToken !== transitionToken) {
      return;
    }
    setStylePanelActive(settingsPage, styleActive);
    activateContent?.();
    playSettingsContentPhase(getSettingsContent(settingsPage, styleActive), 'entering');
  }, 180);
}

function updateSettingsSelectionIndicator(settingsPage, item) {
  const menu = settingsPage.querySelector('.category-menu');
  if (!menu || !item) {
    return;
  }

  let indicator = menu.querySelector(':scope > .ytm-desktop-settings-selection');
  const isNew = !indicator;
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.className = 'ytm-desktop-settings-selection';
    indicator.dataset.initializing = 'true';
    indicator.setAttribute('aria-hidden', 'true');
    menu.prepend(indicator);
  }

  indicator.style.height = `${item.offsetHeight}px`;
  indicator.style.width = `${item.offsetWidth}px`;
  indicator.style.transform = `translate3d(${item.offsetLeft}px, ${item.offsetTop}px, 0)`;
  if (isNew) {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      delete indicator.dataset.initializing;
      indicator.classList.add('ready');
    }));
  } else if (indicator.dataset.initializing !== 'true') {
    indicator.classList.add('ready');
  }
}

function refreshSettingsSelectionIndicators() {
  for (const settingsPage of document.querySelectorAll('ytmusic-settings-page')) {
    const selected = settingsPage.querySelector('.category-menu-item.iron-selected');
    updateSettingsSelectionIndicator(settingsPage, selected);
  }
}

function setStylePanelActive(settingsPage, active) {
  const styleItem = settingsPage.querySelector('.ytm-desktop-style-category');
  const nativeCollection = settingsPage.querySelector('ytmusic-setting-category-collection-renderer');
  const panel = settingsPage.querySelector(`#${STYLE_PANEL_ID}`);
  if (!styleItem || !nativeCollection || !panel) {
    return;
  }

  settingsPage.classList.toggle('ytm-desktop-style-active', active);
  nativeCollection.classList.toggle('ytm-desktop-native-settings-hidden', active);
  panel.hidden = !active;
  styleItem.classList.toggle('iron-selected', active);
  styleItem.setAttribute('aria-selected', String(active));
  styleItem.tabIndex = active ? 0 : -1;

  if (active) {
    for (const item of settingsPage.querySelectorAll('.category-menu-item:not(.ytm-desktop-style-category)')) {
      item.classList.remove('iron-selected');
      item.setAttribute('aria-selected', 'false');
      item.tabIndex = -1;
    }
    updateAppearanceControls();
  }
  updateSettingsSelectionIndicator(
    settingsPage,
    active ? styleItem : settingsPage.querySelector('.category-menu-item.iron-selected')
  );
}

function updateNativeSettingsSelection(settingsPage, item) {
  window.queueMicrotask(() => {
    for (const candidate of settingsPage.querySelectorAll('.category-menu-item')) {
      const selected = candidate === item;
      candidate.classList.toggle('iron-selected', selected);
      candidate.setAttribute('aria-selected', String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    }
    updateSettingsSelectionIndicator(settingsPage, item);
  });
}

function rememberSettingsTouchSelection(event) {
  if (!['touch', 'pen'].includes(event.pointerType)) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest('ytmusic-settings-page .category-menu-item');
  const settingsPage = item?.closest('ytmusic-settings-page');
  if (item && settingsPage) {
    settingsTouchSelections.set(settingsPage, {
      clientX: event.clientX,
      clientY: event.clientY,
      item,
      pointerId: event.pointerId,
      time: performance.now(),
      wasSelected: item.classList.contains('iron-selected')
        && !settingsPage.classList.contains('ytm-desktop-style-active')
    });
  }
}

function activateTouchedSettingsSelection(event) {
  if (!['touch', 'pen'].includes(event.pointerType)) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest('ytmusic-settings-page .category-menu-item');
  const settingsPage = item?.closest('ytmusic-settings-page');
  const selection = settingsPage ? settingsTouchSelections.get(settingsPage) : null;
  if (!item || !settingsPage || selection?.item !== item
    || selection.pointerId !== event.pointerId
    || performance.now() - selection.time > 1200
    || Math.hypot(event.clientX - selection.clientX, event.clientY - selection.clientY) > 12) {
    return;
  }

  settingsPage.ytmDesktopSuppressedTouchItem = item;
  settingsPage.ytmDesktopSuppressTouchClickUntil = performance.now() + 800;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (item.classList.contains('ytm-desktop-style-category')) {
    settingsTouchSelections.delete(settingsPage);
    activateStyleSettings(settingsPage, item);
  } else {
    activateNativeSettingsItem(settingsPage, item, event);
  }
}

function suppressSynthesizedSettingsClick(event) {
  if (!event.isTrusted) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest('ytmusic-settings-page .category-menu-item');
  const settingsPage = item?.closest('ytmusic-settings-page');
  if (item && settingsPage?.ytmDesktopSuppressedTouchItem === item
    && performance.now() < settingsPage.ytmDesktopSuppressTouchClickUntil) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

function activateNativeSettingsItem(settingsPage, item, event) {
  if (nativeSettingsClickBypass.has(item)) {
    return;
  }

  const touchSelection = settingsTouchSelections.get(settingsPage);
  const selectedByTouch = touchSelection?.item === item
    && performance.now() - touchSelection.time < 1000;
  if (selectedByTouch) {
    settingsTouchSelections.delete(settingsPage);
  }
  if (!appearanceSettings.animations) {
    setStylePanelActive(settingsPage, false);
    updateNativeSettingsSelection(settingsPage, item);
    return;
  }

  const isCurrentItem = item.classList.contains('iron-selected')
    && !settingsPage.classList.contains('ytm-desktop-style-active');
  if (isCurrentItem) {
    if (selectedByTouch && !touchSelection.wasSelected && appearanceSettings.animations) {
      window.requestAnimationFrame(() => playSettingsContentPhase(
        getSettingsContent(settingsPage, false),
        'entering'
      ));
    }
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  updateSettingsSelectionIndicator(settingsPage, item);
  transitionSettingsContent(settingsPage, false, () => {
    nativeSettingsClickBypass.add(item);
    try {
      item.click();
    } finally {
      nativeSettingsClickBypass.delete(item);
    }
    updateNativeSettingsSelection(settingsPage, item);
  });
}

function interceptNativeSettingsCategoryClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  const item = target?.closest(
    'ytmusic-settings-page .category-menu-item:not(.ytm-desktop-style-category)'
  );
  const settingsPage = item?.closest('ytmusic-settings-page');
  if (item && settingsPage) {
    activateNativeSettingsItem(settingsPage, item, event);
  }
}

function createStyleCategory(settingsPage) {
  const strings = getAppearanceStrings();
  const item = document.createElement('tp-yt-paper-item');
  const title = document.createElement('span');
  item.className = 'category-menu-item style-scope ytmusic-settings-page ytm-desktop-style-category';
  item.setAttribute('role', 'option');
  item.setAttribute('aria-disabled', 'false');
  item.setAttribute('aria-selected', 'false');
  item.tabIndex = -1;
  title.className = 'title style-scope ytmusic-settings-page';
  title.textContent = strings.otherCategory;
  item.appendChild(title);
  item.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    activateStyleSettings(settingsPage, item);
  });
  item.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopImmediatePropagation();
      activateStyleSettings(settingsPage, item);
    }
  });
  return item;
}

function activateStyleSettings(settingsPage, item) {
  updateSettingsSelectionIndicator(settingsPage, item);
  transitionSettingsContent(settingsPage, true);
  item.focus({ preventScroll: true });
}

function bindSettingsMenuKeyboard(settingsPage, menu, styleItem) {
  if (menu.dataset.ytmDesktopKeyboardBound === 'true') {
    return;
  }
  menu.dataset.ytmDesktopKeyboardBound = 'true';
  menu.addEventListener('keydown', (event) => {
    const nativeItems = [...menu.querySelectorAll('.category-menu-item:not(.ytm-desktop-style-category)')];
    const lastNativeItem = nativeItems.at(-1);
    if (event.key === 'ArrowDown' && document.activeElement === lastNativeItem) {
      event.preventDefault();
      event.stopImmediatePropagation();
      activateStyleSettings(settingsPage, styleItem);
    } else if (event.key === 'ArrowUp' && document.activeElement === styleItem && lastNativeItem) {
      event.preventDefault();
      event.stopImmediatePropagation();
      lastNativeItem.focus({ preventScroll: true });
      lastNativeItem.click();
    }
  }, true);
}

function bindSettingsCloseLifecycle(settingsDialog) {
  const overlay = settingsDialog?.querySelector('tp-yt-paper-dialog, paper-dialog')
    || settingsDialog;
  if (!overlay || settingsCloseOverlays.has(overlay)) {
    return;
  }
  settingsCloseOverlays.add(overlay);
  overlay.addEventListener('iron-overlay-closed', (event) => {
    if (event.target !== overlay) {
      return;
    }
    closeSettingPicker();
    applyPendingLyricsRefresh();
  });
}

function animateSettingsOpen(settingsDialog) {
  if (!settingsDialog || settingsOpenDialogs.has(settingsDialog)) {
    return;
  }
  settingsOpenDialogs.add(settingsDialog);
  if (!appearanceSettings.animations
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  settingsDialog.classList.add('ytm-desktop-settings-opening');
  window.setTimeout(() => {
    settingsDialog.classList.remove('ytm-desktop-settings-opening');
  }, 210);
}

function installAppearanceSettingsPage() {
  for (const settingsPage of document.querySelectorAll('ytmusic-settings-page')) {
    const menu = settingsPage.querySelector('.category-menu');
    const nativeCollection = settingsPage.querySelector('ytmusic-setting-category-collection-renderer');
    if (!menu || !nativeCollection) {
      continue;
    }

    let styleItem = settingsPage.querySelector('.ytm-desktop-style-category');
    if (!styleItem) {
      styleItem = createStyleCategory(settingsPage);
      menu.insertBefore(styleItem, menu.querySelector(':scope > dom-repeat'));
    }

    const needsStylePanel = !settingsPage.querySelector(`#${STYLE_PANEL_ID}`);
    if (needsStylePanel) {
      nativeCollection.insertAdjacentElement('afterend', createStylePanel());
    }

    bindSettingsMenuKeyboard(settingsPage, menu, styleItem);
    const settingsDialog = nativeCollection.closest('ytmusic-dialog');
    settingsDialog?.classList.add('ytm-desktop-settings-dialog');
    animateSettingsOpen(settingsDialog);
    bindSettingsCloseLifecycle(settingsDialog);
    if (needsStylePanel) {
      updateAppearanceControls();
    }
    updateSettingsSelectionIndicator(
      settingsPage,
      settingsPage.querySelector('.category-menu-item.iron-selected')
    );
  }
}

function animateSettingsClose(button) {
  const dialog = button.closest('ytmusic-dialog');
  if (!dialog || dialog.classList.contains('ytm-desktop-settings-closing')) {
    return;
  }

  dialog.classList.add('ytm-desktop-settings-closing');
  window.setTimeout(() => {
    settingsCloseBypass.add(button);
    button.click();
    settingsCloseBypass.delete(button);
    dialog.classList.remove('ytm-desktop-settings-closing');
  }, 170);
}

function applyPendingLyricsRefresh() {
  if (!pendingLyricsIntegrationRefresh) {
    return;
  }
  pendingLyricsIntegrationRefresh = false;
  refreshLyricsIntegration();
  window.queueMicrotask(refreshAutomaticLyricsTranslation);
}

function interceptSettingsClose(event) {
  const target = event.target instanceof Element ? event.target : null;
  const closeControl = target?.closest('ytmusic-settings-page .close-icon');
  const button = closeControl?.querySelector('button') || closeControl;
  if (button) {
    pendingLanguageMenuUntil = 0;
    closeSettingPicker();
    applyPendingLyricsRefresh();
  }
  if (!appearanceSettings.animations || !button || settingsCloseBypass.has(button)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  animateSettingsClose(button);
}

function interceptSettingsEscape(event) {
  if (event.key !== 'Escape') {
    return;
  }
  if (document.getElementById(CONSENT_DIALOG_ID)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeConsentDialog(false);
    return;
  }
  if (closeSettingPicker(true)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }

  const settingsPage = document.querySelector('ytmusic-settings-page');
  if (settingsPage) {
    applyPendingLyricsRefresh();
  }
  if (!appearanceSettings.animations) {
    return;
  }
  const button = settingsPage?.querySelector('.close-icon button');
  if (!button) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  animateSettingsClose(button);
}

function openPolicyLinkInSystemBrowser(event) {
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest('a[href]');
  if (!anchor || !isExternalPolicyUrl(anchor.href)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send('external:open-policy', anchor.href);
}

function ensureLanguageChangeReload(event) {
  const target = event.target instanceof Element ? event.target : null;
  const menuOption = target?.closest(
    '.menu-item, ytmusic-menu-navigation-item-renderer, ytmusic-menu-service-item-renderer'
  );
  if (menuOption && performance.now() < pendingLanguageMenuUntil
    && menuOption.getAttribute('aria-selected') !== 'true') {
    pendingLanguageMenuUntil = 0;
    window.clearTimeout(languageReloadTimer);
    languageReloadTimer = window.setTimeout(
      () => ipcRenderer.send('music:language-changed'),
      1600
    );
    return;
  }

  const renderer = target?.closest('ytmusic-setting-single-option-menu-renderer');
  if (renderer) {
    const settingsPage = renderer.closest('ytmusic-settings-page');
    const optionMenus = settingsPage
      ? [...settingsPage.querySelectorAll('ytmusic-setting-single-option-menu-renderer')]
      : [];
    const label = [
      renderer.getAttribute('aria-label'),
      renderer.querySelector('#title, .title, .label')?.textContent,
      renderer.textContent
    ].filter(Boolean).join(' ');
    const languageLabel = /(?:\blanguage\b|语言|語言|言語|언어|idioma|langue|sprache|lingua|язык|taal|język|dil|bahasa)/iu
      .test(label);
    if (languageLabel || (optionMenus.length >= 2 && renderer === optionMenus.at(-1))) {
      pendingLanguageMenuUntil = performance.now() + 30000;
    }
    return;
  }

  if (performance.now() >= pendingLanguageMenuUntil) {
    pendingLanguageMenuUntil = 0;
    return;
  }

  const option = target?.closest('tp-yt-paper-item');
  if (!option || option.getAttribute('aria-selected') === 'true') {
    return;
  }

  pendingLanguageMenuUntil = 0;
  window.clearTimeout(languageReloadTimer);
  languageReloadTimer = window.setTimeout(
    () => ipcRenderer.send('music:language-changed'),
    1600
  );
}

function interceptReloadShortcut(event) {
  const reload = event.key === 'F5'
    || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
  if (!reload || event.altKey) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send('music:reload');
}

function createButton(action, label, icon) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ytm-desktop-control ytm-desktop-${action}`;
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(createIcon(icon));
  button.addEventListener('click', () => {
    if (action === 'close') {
      ipcRenderer.send('window:close');
      return;
    }
    ipcRenderer.send(`window:${action}`);
  });
  return button;
}

function createDialogAction(label, variant, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `ytm-material-dialog-action ${variant}`;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function closeCloseDialog(immediate = false) {
  const dialog = document.getElementById(CLOSE_DIALOG_ID);
  if (!dialog) {
    return;
  }

  if (immediate || !appearanceSettings.animations) {
    dialog.remove();
    return;
  }

  dialog.classList.remove('open');
  dialog.classList.add('closing');
  window.setTimeout(() => dialog.remove(), 180);
}

async function runCloseDialogAction(action, remember, surface) {
  for (const button of surface.querySelectorAll('button')) {
    button.disabled = true;
  }
  if (remember) {
    try {
      const nextSettings = await ipcRenderer.invoke('appearance:set', { closeAction: action });
      applyAppearanceSettings(nextSettings);
    } catch (error) {
      console.warn('Unable to remember the close action:', error.message);
    }
  }
  closeCloseDialog(true);
  ipcRenderer.send(action === 'tray' ? 'window:minimize-to-tray' : 'window:quit');
}

function showCloseDialog() {
  const existing = document.getElementById(CLOSE_DIALOG_ID);
  if (existing) {
    if (existing.classList.contains('closing')) {
      existing.remove();
    } else {
      existing.querySelector('.primary')?.focus();
      return;
    }
  }

  closeMaterialContextMenu();
  const backdrop = document.createElement('div');
  const surface = document.createElement('section');
  const heading = document.createElement('h2');
  const description = document.createElement('p');
  const rememberLabel = document.createElement('label');
  const remember = document.createElement('input');
  const rememberText = document.createElement('span');
  const actions = document.createElement('div');
  const strings = getAppearanceStrings();

  backdrop.id = CLOSE_DIALOG_ID;
  backdrop.className = 'ytm-material-dialog-backdrop';
  surface.className = 'ytm-material-dialog';
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  surface.setAttribute('aria-labelledby', 'ytm-close-dialog-title');
  heading.id = 'ytm-close-dialog-title';
  heading.textContent = strings.closeDialogTitle;
  description.textContent = strings.closeDialogDescription;
  rememberLabel.className = 'ytm-material-dialog-checkbox';
  remember.type = 'checkbox';
  rememberText.textContent = strings.closeDialogRemember;
  rememberLabel.append(remember, rememberText);
  actions.className = 'ytm-material-dialog-actions';

  const cancel = createDialogAction(strings.closeDialogCancel, 'quiet', () => closeCloseDialog());
  const quit = createDialogAction(strings.closeDialogQuit, 'danger', () => (
    runCloseDialogAction('quit', remember.checked, surface)
  ));
  const minimize = createDialogAction(strings.closeDialogTray, 'primary', () => (
    runCloseDialogAction('tray', remember.checked, surface)
  ));

  actions.append(cancel, quit, minimize);
  surface.append(heading, description, rememberLabel, actions);
  backdrop.appendChild(surface);
  backdrop.addEventListener('pointerdown', (event) => {
    if (event.target === backdrop) {
      closeCloseDialog();
    }
  });
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCloseDialog();
    }
  });
  document.body.appendChild(backdrop);
  window.requestAnimationFrame(() => backdrop.classList.add('open'));
  minimize.focus();
}

function closeMaterialContextMenu() {
  document.getElementById(CONTEXT_MENU_ID)?.remove();
}

function createContextMenuItem(item, linkUrl, focusTarget) {
  if (item.separator) {
    const separator = document.createElement('div');
    separator.className = 'ytm-material-menu-separator';
    separator.setAttribute('role', 'separator');
    return separator;
  }

  const button = document.createElement('button');
  const icon = document.createElement('span');
  const label = document.createElement('span');
  button.type = 'button';
  button.className = 'ytm-material-menu-item';
  button.setAttribute('role', 'menuitem');
  icon.className = 'ytm-material-menu-icon';
  icon.appendChild(createIcon(icons[item.icon]));
  label.textContent = item.label;
  button.append(icon, label);
  button.addEventListener('click', () => {
    closeMaterialContextMenu();
    focusTarget?.focus?.({ preventScroll: true });
    ipcRenderer.send('context-menu:action', {
      action: item.action,
      url: item.usesLink ? linkUrl : undefined
    });
  });
  return button;
}

function showMaterialContextMenu(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  if (!target) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  if (target.closest(`#${CONTROL_ID}, #${CLOSE_DIALOG_ID}, #${CONTEXT_MENU_ID}`)) {
    return;
  }
  closeMaterialContextMenu();

  const editable = target.matches('input, textarea, [contenteditable="true"]')
    || Boolean(target.closest('[contenteditable="true"]'));
  const hasSelection = Boolean(window.getSelection()?.toString().trim());
  const anchor = target.closest('a[href]');
  const linkUrl = anchor?.href || '';
  const strings = getAppearanceStrings();
  const items = [];

  if (editable) {
    items.push(
      { action: 'undo', label: strings.contextUndo, icon: 'undo' },
      { action: 'redo', label: strings.contextRedo, icon: 'redo' },
      { separator: true },
      { action: 'cut', label: strings.contextCut, icon: 'cut' },
      { action: 'copy', label: strings.contextCopy, icon: 'copy' },
      { action: 'paste', label: strings.contextPaste, icon: 'paste' },
      { action: 'select-all', label: strings.contextSelectAll, icon: 'selectAll' }
    );
  } else if (hasSelection) {
    items.push({ action: 'copy', label: strings.contextCopy, icon: 'copy' });
  }

  if (linkUrl) {
    if (items.length) {
      items.push({ separator: true });
    }
    items.push(
      { action: 'open-link', label: strings.contextOpenLink, icon: 'external', usesLink: true },
      { action: 'copy-link', label: strings.contextCopyLink, icon: 'link', usesLink: true }
    );
  }

  if (items.length) {
    items.push({ separator: true });
  }
  items.push({ action: 'reload', label: strings.contextReload, icon: 'reload' });

  const menu = document.createElement('div');
  menu.id = CONTEXT_MENU_ID;
  menu.className = 'ytm-material-menu';
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    menu.appendChild(createContextMenuItem(item, linkUrl, editable ? target : null));
  }
  document.body.appendChild(menu);

  const bounds = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector('button')?.focus();

  menu.addEventListener('keydown', (keyboardEvent) => {
    const buttons = [...menu.querySelectorAll('button')];
    const current = buttons.indexOf(document.activeElement);
    if (keyboardEvent.key === 'Escape') {
      keyboardEvent.preventDefault();
      closeMaterialContextMenu();
    } else if (keyboardEvent.key === 'ArrowDown') {
      keyboardEvent.preventDefault();
      buttons[(current + 1) % buttons.length]?.focus();
    } else if (keyboardEvent.key === 'ArrowUp') {
      keyboardEvent.preventDefault();
      buttons[(current - 1 + buttons.length) % buttons.length]?.focus();
    }
  });
}

function getYouTubePlayer() {
  const players = [...document.querySelectorAll('#movie_player')];
  if (players.length <= 1) {
    return players[0] || null;
  }

  let selectedPlayer = players[0];
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const player of players) {
    const mediaElements = [...player.querySelectorAll('video, audio')];
    const hasPlayingMedia = mediaElements.some((media) => (
      !media.paused && !media.ended && Boolean(media.currentSrc)
    ));
    const hasVisibleMedia = mediaElements.some((media) => {
      const bounds = media.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
    const hasLoadedMedia = mediaElements.some((media) => Boolean(media.currentSrc));
    const score = (hasPlayingMedia ? 300 : 0)
      + (hasVisibleMedia ? 80 : 0)
      + (hasLoadedMedia ? 10 : 0);
    if (score >= selectedScore) {
      selectedPlayer = player;
      selectedScore = score;
    }
  }
  return selectedPlayer;
}

function getActiveMediaElement(player = getYouTubePlayer()) {
  const playerElements = player
    ? [...player.querySelectorAll('video, audio')]
    : [];
  const elements = player
    ? playerElements
    : [...document.querySelectorAll('video, audio')];
  return elements.find((media) => !media.paused && !media.ended && media.currentSrc)
    || elements.find((media) => media.currentSrc)
    || elements[0]
    || null;
}

function getLyricsPlaybackState() {
  const snapshot = currentPlaybackSnapshot;
  if (!snapshot?.timing) {
    return null;
  }
  const elapsed = snapshot.playing
    ? Math.max(0, performance.now() - snapshot.observedAt) / 1000 * snapshot.playbackRate
    : 0;
  return {
    currentTime: Math.min(snapshot.timing.duration, snapshot.timing.position + elapsed),
    duration: snapshot.timing.duration,
    playerVideoId: snapshot.videoId
  };
}

function seekLyricsPlayback(time, expectedVideoId) {
  if (!expectedVideoId || currentPlaybackSnapshot?.videoId !== expectedVideoId) {
    return false;
  }
  try {
    return contextBridge.executeInMainWorld({
      args: [expectedVideoId, Math.max(0, time)],
      func: seekPagePlayback
    }) === true;
  } catch (error) {
    console.warn('Unable to seek the current lyrics track:', error.message);
    return false;
  }
}

function collectPlaybackSnapshot() {
  let pageSample;
  try {
    pageSample = contextBridge.executeInMainWorld({ func: samplePagePlayback });
  } catch (error) {
    console.warn('Unable to sample the page player:', error.message);
    return null;
  }
  if (!pageSample) {
    return null;
  }
  const details = pageSample.details || {};
  const videoId = details.videoId;
  if (!videoId) {
    return null;
  }
  const playerBar = pageSample.playerBar || {};
  const playerBarVideoId = playerBar.videoId;
  const responseTitle = details.title.trim();
  const playerBarTitle = playerBar.title;
  const playerBarMatchesTrack = playerBarBelongsToTrack(playerBarVideoId, videoId)
    || playerBarTitleBelongsToTrack(playerBarTitle, responseTitle);
  if (!responseTitle && !playerBarMatchesTrack) {
    return null;
  }
  const title = playerBarMatchesTrack
    ? playerBarTitle || responseTitle
    : responseTitle || playerBarTitle;
  const byline = playerBarMatchesTrack ? playerBar.byline : '';
  const bylineParts = byline.split(/\s*[•·]\s*/).map((part) => part.trim()).filter(Boolean);
  const artist = bylineParts[0] || details.author.trim() || '';
  const album = bylineParts.slice(1).find((part) => (
    !/(?:views?|likes?|次观看|次播放|人赞)|^\d{4}$/i.test(part)
  )) || '';
  const thumbnails = details.thumbnails || [];
  const artwork = playerBarMatchesTrack
    ? selectSquareArtwork(playerBar.artwork || [])
    : [];
  if (!artwork.length) {
    artwork.push(...selectMediaArtwork(thumbnails.map((thumbnail) => ({
      height: thumbnail?.height,
      src: thumbnail?.url,
      width: thumbnail?.width
    }))));
  }
  const durationHint = Number(details.lengthSeconds) || 0;
  const playerBarTiming = playerBarMatchesTrack
    ? parsePlayerBarTiming(playerBar.timeText)
    : null;
  const playerTiming = {
    duration: pageSample.player?.duration,
    position: pageSample.player?.position
  };
  const mediaTiming = {
    duration: pageSample.media?.duration,
    position: pageSample.media?.position
  };
  const playerState = pageSample.player?.state;
  const playing = playerState !== null ? playerState === 1 : pageSample.media?.paused === false;
  const playerRate = pageSample.player?.playbackRate;
  const playbackRate = playerRate > 0
    ? playerRate
    : pageSample.media?.playbackRate > 0 ? pageSample.media.playbackRate : 1;
  const metadata = { album, artist, artwork, title };
  return {
    metadata,
    observedAt: performance.now(),
    playbackRate,
    playing: pageSample.isAd ? false : playing,
    durationHint,
    mediaTiming,
    playerBarTiming,
    playerTiming,
    track: {
      album,
      albumAliases: playerBarMatchesTrack ? bylineParts.slice(1) : [],
      artist,
      artistAliases: [details.author, playerBarMatchesTrack ? bylineParts[0] : ''].filter(Boolean),
      captionTracks: details.captionTracks,
      duration: durationHint || playerBarTiming?.duration || 0,
      isMusicVideo: /MUSIC_VIDEO_TYPE_(?:OMV|UGC)$/u.test(details.musicVideoType),
      language: document.documentElement.lang,
      title: stripPresentationNoise(title),
      titleAliases: [responseTitle, playerBarMatchesTrack ? playerBarTitle : '']
        .map(stripPresentationNoise)
        .filter(Boolean),
      videoTitle: stripPresentationNoise(responseTitle),
      videoId
    },
    videoId
  };
}

function publishMediaSession(snapshot, trackChanged) {
  const metadataKey = JSON.stringify(snapshot.metadata);
  const metadataChanged = snapshot.metadata.title && metadataKey !== currentMetadataKey;
  if (metadataChanged) {
    currentMetadataKey = metadataKey;
  }
  const playbackState = snapshot.playing ? 'playing' : 'paused';
  const positionState = snapshot.timing ? {
    duration: snapshot.timing.duration,
    playbackRate: snapshot.playbackRate,
    position: snapshot.timing.position
  } : null;
  try {
    contextBridge.executeInMainWorld({
      args: [{
        metadata: metadataChanged ? snapshot.metadata : null,
        playbackState,
        positionState,
        resetPosition: trackChanged
      }],
      func: (value) => window.__ytmDesktopMediaSessionController?.publish(value)
    });
  } catch (error) {
    console.warn('Unable to publish the media session:', error.message);
  }
  if (positionState) {
    document.documentElement.dataset.ytmDesktopSmtcPosition = JSON.stringify({
      ...positionState,
      playbackState,
      revision: snapshot.revision,
      videoId: snapshot.videoId,
    });
  } else if (trackChanged) {
    delete document.documentElement.dataset.ytmDesktopSmtcPosition;
  }
}

function pollPlayback() {
  playbackPollTimer = null;
  try {
    const sample = collectPlaybackSnapshot();
    if (!sample) {
      document.documentElement.dataset.ytmDesktopSongState = 'waiting-for-track';
      return;
    }
    let trackHandledEarly = false;
    if (currentPlaybackSnapshot?.videoId
      && currentPlaybackSnapshot.videoId !== sample.videoId
      && currentLyricsTrack?.videoId !== sample.videoId) {
      handleDetectedTrackChange(sample);
      trackHandledEarly = true;
    }
    const observation = songStateMonitor.observe({
      durationHint: sample.durationHint,
      media: sample.mediaTiming,
      player: sample.playerTiming,
      playerBar: sample.playerBarTiming,
      videoId: sample.videoId
    });
    if (!observation) {
      document.documentElement.dataset.ytmDesktopSongState = 'waiting-for-timing';
      return;
    }
    const snapshot = {
      ...sample,
      revision: observation.revision,
      timing: observation.timing,
      track: {
        ...sample.track,
        duration: observation.timing?.duration || sample.track.duration
      }
    };
    if (observation.initial || observation.trackChanged) {
      currentMetadataKey = '';
    }
    currentPlaybackSnapshot = snapshot;
    document.documentElement.dataset.ytmDesktopSongState = JSON.stringify({
      position: snapshot.timing?.position ?? null,
      revision: snapshot.revision,
      trackChanged: observation.trackChanged,
      videoId: snapshot.videoId
    });
    if ((observation.initial || observation.trackChanged) && !trackHandledEarly) {
      handleDetectedTrackChange(snapshot);
    }
    publishMediaSession(snapshot, observation.initial || observation.trackChanged);
    requestLyricsRefresh();
  } catch (error) {
    document.documentElement.dataset.ytmDesktopSongState = `error:${error.message}`;
    console.warn('Unable to monitor the current song:', error.message);
  }
}

function requestPlaybackPoll() {
  if (!playbackPollTimer) {
    playbackPollTimer = window.setTimeout(pollPlayback, 40);
  }
}

function installPlaybackMonitor() {
  if (playbackMonitorTimer) {
    return;
  }

  for (const eventName of [
    'play', 'pause', 'loadedmetadata', 'durationchange', 'emptied', 'playing', 'seeked'
  ]) {
    document.addEventListener(eventName, requestPlaybackPoll, true);
  }
  playbackMonitorTimer = window.setInterval(pollPlayback, 250);
  pollPlayback();
}

function updateVolumeSlider(playerBar, percent) {
  for (const slider of playerBar.querySelectorAll('#volume-slider')) {
    slider.value = percent;
    slider.setAttribute('value', String(percent));
    slider.setAttribute('aria-valuenow', String(percent));
    slider.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
}

function changeVolumeFromWheel(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
  const media = getActiveMediaElement();
  if (!media) {
    return;
  }

  const playerBar = event.currentTarget.closest('ytmusic-player-bar');
  const slider = playerBar?.querySelector('#volume-slider');
  const sliderPercent = Number(slider?.value);
  const direction = event.deltaY < 0 ? 1 : -1;
  const currentPercent = Number.isFinite(sliderPercent)
    ? Math.round(sliderPercent / 5) * 5
    : Math.round(media.volume * 100 / 5) * 5;
  const nextPercent = Math.max(0, Math.min(100, currentPercent + direction * 5));
  if (nextPercent > 0 && media.muted) {
    media.muted = false;
  }
  if (slider && playerBar) {
    updateVolumeSlider(playerBar, nextPercent);
  } else {
    media.volume = nextPercent / 100;
  }
}

function bindVolumeWheelControl() {
  for (const button of document.querySelectorAll('ytmusic-player-bar .volume')) {
    if (button.dataset.ytmDesktopVolumeWheelBound === 'true') {
      continue;
    }
    button.dataset.ytmDesktopVolumeWheelBound = 'true';
    button.addEventListener('wheel', changeVolumeFromWheel, { capture: true, passive: false });
  }
}

function findLyricsTab(playerPage) {
  const tabs = [...playerPage.querySelectorAll('#side-panel tp-yt-paper-tab')];
  return tabs.find((tab) => /^(lyrics|歌词|歌詞)$/i.test(tab.textContent.trim())) || tabs[1] || null;
}

function updateLyricsSelectionBar(playerPage, selectedTab) {
  const selectionBar = playerPage.querySelector('#side-panel #selectionBar');
  if (!selectionBar || !selectedTab) {
    return;
  }
  const selectedBounds = selectedTab.getBoundingClientRect();
  const trackBounds = (selectionBar.offsetParent || selectionBar.parentElement)?.getBoundingClientRect();
  if (!trackBounds || selectedBounds.width <= 0) {
    return;
  }
  selectionBar.classList.add('ytm-desktop-player-selection-bar');
  selectionBar.style.setProperty(
    '--ytm-desktop-player-tab-x',
    `${Math.round((selectedBounds.left - trackBounds.left) * 100) / 100}px`
  );
  selectionBar.style.setProperty(
    '--ytm-desktop-player-tab-width',
    `${Math.round(selectedBounds.width * 100) / 100}px`
  );
  if (selectionBar.dataset.ytmDesktopReady !== 'true') {
    window.requestAnimationFrame(() => {
      selectionBar.dataset.ytmDesktopReady = 'true';
    });
  }
}

function createLyricsPanel() {
  const strings = getAppearanceStrings();
  const panel = document.createElement('section');
  const scroller = document.createElement('div');
  const status = document.createElement('div');
  const lines = document.createElement('div');
  const source = document.createElement('div');
  const translateButton = document.createElement('button');
  panel.id = LYRICS_PANEL_ID;
  panel.hidden = true;
  panel.setAttribute('aria-label', strings.lyricsTitle);
  scroller.className = 'ytm-desktop-lyrics-scroll';
  status.className = 'ytm-desktop-lyrics-status';
  lines.className = 'ytm-desktop-lyrics-lines';
  source.className = 'ytm-desktop-lyrics-source';
  source.textContent = strings.lyricsSource;
  source.hidden = true;
  translateButton.type = 'button';
  translateButton.className = 'ytm-desktop-lyrics-translate';
  translateButton.hidden = true;
  translateButton.title = strings.translateLyrics;
  translateButton.setAttribute('aria-label', strings.translateLyrics);
  translateButton.setAttribute('aria-pressed', 'false');
  translateButton.appendChild(createIcon(icons.translate));
  translateButton.addEventListener('click', () => toggleLyricsTranslation(panel));
  scroller.append(status, lines, source);
  panel.append(scroller, translateButton);
  scroller.addEventListener('wheel', () => {
    lyricsUserScrollUntil = Date.now() + 3000;
  }, { passive: true });
  scroller.addEventListener('pointerdown', () => {
    lyricsUserScrollUntil = Date.now() + 3000;
  });
  return panel;
}

function getLyricsPanels() {
  return [...document.querySelectorAll(`#${LYRICS_PANEL_ID}`)];
}

function getCurrentLyricsPanel() {
  const panels = getLyricsPanels();
  const pageIsVisible = (panel) => {
    const page = panel.closest('ytmusic-player-page');
    if (!page) {
      return false;
    }
    const bounds = page.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  };
  return panels.find((panel) => panel.dataset.active === 'true' && pageIsVisible(panel))
    || panels.find(pageIsVisible)
    || panels.find((panel) => panel.dataset.active === 'true')
    || panels.at(-1)
    || null;
}

function setBoundedLyricsCache(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

function publishDesktopLyricsState(panel = getCurrentLyricsPanel()) {
  if (!currentLyricsResult?.lines?.length || !currentLyricsTrack) {
    ipcRenderer.send('desktop-lyrics:clear');
    return;
  }
  const renderedLines = panel
    ? [...panel.querySelectorAll('.ytm-desktop-lyrics-line')]
    : [];
  const translated = panel?.dataset.translated === 'true';
  const lines = currentLyricsResult.lines.map((line, index) => ({
    text: line.text,
    time: line.time,
    translation: translated
      ? renderedLines[index]?.querySelector?.('.ytm-desktop-lyrics-line-translation')?.textContent || ''
      : ''
  }));
  ipcRenderer.send('desktop-lyrics:update', {
    currentIndex: currentLyricsIndex,
    lines,
    source: currentLyricsResult.source,
    targetLanguage: translated
      ? normalizeTranslationLanguage(document.documentElement.lang)
      : '',
    track: currentLyricsTrack,
    translated
  });
}

function resetLyricsTranslation(panel, hideButton = false) {
  lyricsTranslationRequestToken += 1;
  panel.dataset.translated = 'false';
  panel.dataset.translationMode = 'none';
  delete panel.dataset.translationProvider;
  delete panel.dataset.translationInputSource;
  const strings = getAppearanceStrings();
  const button = panel.querySelector('.ytm-desktop-lyrics-translate');
  button.hidden = hideButton;
  button.disabled = false;
  button.classList.remove('active', 'error', 'loading');
  button.title = strings.translateLyrics;
  button.setAttribute('aria-label', strings.translateLyrics);
  button.setAttribute('aria-busy', 'false');
  button.setAttribute('aria-pressed', 'false');
}

function setLyricsTranslationUnavailable(panel, unavailable) {
  panel.dataset.translationUnavailable = String(unavailable);
  panel.querySelector('.ytm-desktop-lyrics-translate').hidden = unavailable;
}

function applyLyricsTranslation(
  panel,
  translatedLines,
  mode = 'manual',
  translationProvider = appearanceSettings.lyricsTranslationProvider,
  translationInputSource = 'original'
) {
  const lineElements = [...panel.querySelectorAll('.ytm-desktop-lyrics-line')];
  const translated = Array.isArray(translatedLines) && translatedLines.length === lineElements.length;
  for (const [index, element] of lineElements.entries()) {
    const translation = element.querySelector('.ytm-desktop-lyrics-line-translation');
    const metadataLine = isLyricsMetadataLine(element.dataset.originalText);
    translation.textContent = translated && !metadataLine ? translatedLines[index] || '' : '';
    translation.hidden = !translated || !translation.textContent;
  }

  const strings = getAppearanceStrings();
  const source = panel.querySelector('.ytm-desktop-lyrics-source');
  const button = panel.querySelector('.ytm-desktop-lyrics-translate');
  panel.dataset.translated = String(translated);
  panel.dataset.translationMode = translated ? mode : 'none';
  if (translated) {
    panel.dataset.translationProvider = translationProvider;
    panel.dataset.translationInputSource = translationInputSource;
  } else {
    delete panel.dataset.translationProvider;
    delete panel.dataset.translationInputSource;
  }
  source.textContent = getLyricsSourceAttribution(panel, source.dataset.originalText, strings);
  button.classList.toggle('active', translated);
  button.title = translated ? strings.showOriginalLyrics : strings.translateLyrics;
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-pressed', String(translated));
  publishDesktopLyricsState(panel);
}

async function toggleLyricsTranslation(panel, automatic = false) {
  const button = panel.querySelector('.ytm-desktop-lyrics-translate');
  if (button.disabled || panel.dataset.translationUnavailable === 'true') {
    return false;
  }
  if (panel.dataset.translated === 'true') {
    if (automatic) {
      return true;
    }
    applyLyricsTranslation(panel, null);
    return true;
  }

  const lineElements = [...panel.querySelectorAll('.ytm-desktop-lyrics-line')];
  const lines = lineElements.map((element) => element.dataset.originalText).filter(Boolean);
  if (!lines.length || lines.length !== lineElements.length) {
    return false;
  }
  const targetLanguage = normalizeTranslationLanguage(document.documentElement.lang);
  const timelineKey = panel.dataset.timelineKey || '';
  const timelineLines = lineElements.map((element) => ({
    text: element.dataset.originalText,
    time: Number(element.dataset.time)
  }));
  const embeddedTranslation = currentLyricsResult?.source === 'netease'
    && targetLanguage === 'zh-CN'
    ? alignSyncedTranslation(
      timelineLines,
      currentLyricsResult.translationLyrics
    )
    : null;
  if (embeddedTranslation) {
    applyLyricsTranslation(
      panel,
      embeddedTranslation,
      automatic ? 'auto' : 'manual',
      'netease'
    );
    return true;
  }
  const translationSource = selectLyricsTranslationSource(
    timelineLines,
    currentLyricsResult?.translationLyrics,
    appearanceSettings.neteaseTranslationSource
      && appearanceSettings.lrclibLyrics
      && appearanceSettings.neteaseLyrics
      && currentLyricsResult?.source === 'netease'
      && normalizeUiLocale(document.documentElement.lang) !== 'zh-cn'
  );
  const cacheKey = [
    timelineKey,
    targetLanguage,
    appearanceSettings.lyricsTranslationProvider,
    translationSource.kind
  ].join('\0');
  const cached = lyricsTranslationCache.get(cacheKey);
  if (cached) {
    if (automatic && haveSameLanguage(cached.sourceLanguage, targetLanguage)) {
      return true;
    }
    applyLyricsTranslation(
      panel,
      cached.lines,
      automatic ? 'auto' : 'manual',
      cached.provider,
      translationSource.kind
    );
    return true;
  }

  const strings = getAppearanceStrings();
  const requestToken = ++lyricsTranslationRequestToken;
  button.disabled = true;
  button.classList.remove('error');
  button.classList.add('loading');
  button.title = strings.translatingLyrics;
  button.setAttribute('aria-label', strings.translatingLyrics);
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await ipcRenderer.invoke('lyrics:translate', {
      lines: translationSource.lines,
      targetLanguage
    });
    if (requestToken !== lyricsTranslationRequestToken
      || panel.dataset.timelineKey !== timelineKey
      || !Array.isArray(result?.lines)
      || result.lines.length !== lines.length) {
      return false;
    }
    setBoundedLyricsCache(lyricsTranslationCache, cacheKey, result, 24);
    if (automatic && haveSameLanguage(result.sourceLanguage, targetLanguage)) {
      return true;
    }
    applyLyricsTranslation(
      panel,
      result.lines,
      automatic ? 'auto' : 'manual',
      result.provider,
      translationSource.kind
    );
    return true;
  } catch (error) {
    console.warn('Unable to translate lyrics:', error.message);
    if (requestToken === lyricsTranslationRequestToken) {
      button.classList.add('error');
      button.title = strings.translationError;
      button.setAttribute('aria-label', strings.translationError);
    }
    return false;
  } finally {
    if (requestToken === lyricsTranslationRequestToken) {
      button.disabled = false;
      button.classList.remove('loading');
      button.setAttribute('aria-busy', 'false');
      if (!button.classList.contains('error')) {
        button.title = panel.dataset.translated === 'true'
          ? strings.showOriginalLyrics
          : strings.translateLyrics;
        button.setAttribute('aria-label', button.title);
      }
    }
  }
}

async function maybeAutoTranslateLyrics(panel) {
  if (
    !appearanceSettings.autoTranslateLyrics
    || !panel
    || panel.hidden
    || panel.dataset.translationUnavailable === 'true'
    || !panel.querySelector('.ytm-desktop-lyrics-line')
  ) {
    return;
  }
  const timelineKey = panel.dataset.timelineKey || '';
  if (!timelineKey || panel.dataset.autoTranslationChecked === timelineKey) {
    return;
  }
  panel.dataset.autoTranslationChecked = timelineKey;
  const completed = await toggleLyricsTranslation(panel, true);
  if (!completed && panel.dataset.timelineKey === timelineKey) {
    delete panel.dataset.autoTranslationChecked;
  }
}

async function refreshLyricsTranslationAvailability(panel) {
  if (!panel || !currentLyricsResult?.lines?.length) {
    return;
  }
  const timelineKey = panel.dataset.timelineKey || '';
  const requestToken = ++lyricsLanguageDetectionRequestToken;
  const targetLanguage = normalizeTranslationLanguage(document.documentElement.lang);
  const declaredLanguage = currentLyricsResult.source === 'youtube-cc'
    ? currentLyricsResult.sourceLanguage
    : '';
  if (declaredLanguage && haveSameLanguage(declaredLanguage, targetLanguage)) {
    setLyricsTranslationUnavailable(panel, true);
    return;
  }

  const lines = currentLyricsResult.lines
    .filter((line) => !isLyricsMetadataLine(line.text))
    .map((line) => line.text)
    .filter(Boolean);
  try {
    const detection = await ipcRenderer.invoke('lyrics:detect-language', { lines });
    if (requestToken !== lyricsLanguageDetectionRequestToken
      || panel.dataset.timelineKey !== timelineKey) {
      return;
    }
    const detectedLanguage = String(detection?.language || '');
    const unavailable = !shouldOfferLyricsTranslation({
      declaredLanguage,
      detectedLanguage,
      source: currentLyricsResult.source,
      targetLanguage
    });
    setLyricsTranslationUnavailable(panel, unavailable);
    if (!unavailable && appearanceSettings.autoTranslateLyrics) {
      maybeAutoTranslateLyrics(panel);
    }
  } catch (error) {
    console.warn('Unable to detect lyrics language:', error.message);
    if (requestToken === lyricsLanguageDetectionRequestToken
      && panel.dataset.timelineKey === timelineKey) {
      setLyricsTranslationUnavailable(panel, true);
    }
  }
}

function refreshAutomaticLyricsTranslation() {
  const panel = getCurrentLyricsPanel();
  if (!panel) {
    return;
  }
  if (appearanceSettings.autoTranslateLyrics) {
    maybeAutoTranslateLyrics(panel);
    return;
  }
  delete panel.dataset.autoTranslationChecked;
  if (panel.dataset.translationMode === 'auto') {
    applyLyricsTranslation(panel, null);
  }
}

function setLyricsStatus(panel, message, loading = false) {
  const status = panel.querySelector('.ytm-desktop-lyrics-status');
  const lines = panel.querySelector('.ytm-desktop-lyrics-lines');
  const source = panel.querySelector('.ytm-desktop-lyrics-source');
  status.textContent = message;
  status.classList.toggle('loading', loading);
  status.hidden = false;
  lines.replaceChildren();
  lines.hidden = true;
  source.hidden = true;
  currentLyricsIndex = -1;
  lyricsLanguageDetectionRequestToken += 1;
  delete panel.dataset.translationUnavailable;
  resetLyricsTranslation(panel, true);
}

function getLyricsTrack() {
  return currentPlaybackSnapshot?.track || null;
}

function getLyricsTrackFingerprint(track = getLyricsTrack()) {
  const identity = createTrackFingerprint(track);
  if (!identity) {
    return '';
  }
  return JSON.stringify({
    captions: (track?.captionTracks || []).slice(0, 10).map((caption) => [
      caption?.vssId,
      caption?.languageCode,
      caption?.kind,
      caption?.isDefault === true
    ]),
    identity,
    videoTitle: String(track?.videoTitle || '')
  });
}

function normalizeLyricsResult(value, track) {
  const lines = parseSyncedLyrics(value?.syncedLyrics);
  if (!lines.length || isLikelyRomanizedLyrics(
    lines.map((line) => line.text).join('\n'),
    track
  )) {
    return null;
  }
  return { ...(value || {}), lines, source: value.source };
}

function renderLyricsResult(panel, result, timelineKey) {
  const strings = getAppearanceStrings();
  const sourceText = result.source === 'netease'
    ? strings.neteaseSource
    : result.source === 'youtube-cc' ? strings.captionSource : strings.lyricsSource;
  panel.dataset.timelineKey = timelineKey;
  panel.dataset.lyricsVideoId = String(currentLyricsTrack?.videoId || '');
  currentLyricsResult = result;
  renderTimedLyrics(panel, result.lines, sourceText);
}

function renderTimedLyrics(panel, lines, sourceText) {
  const linesElement = panel.querySelector('.ytm-desktop-lyrics-lines');
  const status = panel.querySelector('.ytm-desktop-lyrics-status');
  const source = panel.querySelector('.ytm-desktop-lyrics-source');
  if (!lines.length) {
    setLyricsStatus(panel, getAppearanceStrings().lyricsNotFound);
    return;
  }

  const renderedTimelineKey = panel.dataset.timelineKey || '';
  const renderedVideoId = panel.dataset.lyricsVideoId || '';

  const fragment = document.createDocumentFragment();
  for (const line of lines) {
    const button = document.createElement('button');
    const original = document.createElement('span');
    const translation = document.createElement('span');
    button.type = 'button';
    button.className = 'ytm-desktop-lyrics-line';
    button.dataset.time = String(line.time);
    button.dataset.originalText = line.text;
    original.className = 'ytm-desktop-lyrics-line-original';
    original.textContent = line.text;
    translation.className = 'ytm-desktop-lyrics-line-translation';
    translation.hidden = true;
    button.append(original, translation);
    button.addEventListener('click', () => {
      const timelineIsCurrent = canSeekLyricsTimeline({
        currentKey: currentLyricsKey,
        currentState: currentLyricsState,
        currentVideoId: currentPlaybackSnapshot?.videoId,
        expectedKey: renderedTimelineKey,
        expectedVideoId: renderedVideoId,
        lyricsVideoId: currentLyricsTrack?.videoId
      });
      if (!timelineIsCurrent) {
        setLyricsStatus(panel, getAppearanceStrings().lyricsLoading, true);
        requestPlaybackPoll();
        return;
      }
      if (seekLyricsPlayback(line.time, renderedVideoId)) {
        lyricsUserScrollUntil = 0;
        updateSyncedLyrics();
      } else {
        requestPlaybackPoll();
      }
    });
    fragment.appendChild(button);
  }

  status.hidden = true;
  status.textContent = '';
  status.classList.remove('loading');
  linesElement.hidden = false;
  linesElement.replaceChildren(fragment);
  source.textContent = sourceText;
  source.dataset.originalText = sourceText;
  source.hidden = false;
  resetLyricsTranslation(panel, true);
  setLyricsTranslationUnavailable(panel, true);
  currentLyricsIndex = -1;
  currentLyricsResult = {
    ...(currentLyricsResult || {}),
    lines,
    source: currentLyricsResult?.source || 'unknown'
  };
  startLyricsSync();
  updateSyncedLyrics();
  publishDesktopLyricsState(panel);
  refreshLyricsTranslationAvailability(panel);
}

function updateSyncedLyrics() {
  const panel = getCurrentLyricsPanel();
  const playback = getLyricsPlaybackState();
  const lineElements = panel
    ? [...panel.querySelectorAll('.ytm-desktop-lyrics-line')]
    : [];
  if (!panel || panel.hidden || !playback || !lineElements.length) {
    return;
  }

  const position = playback.currentTime + 0.12;
  let low = 0;
  let high = lineElements.length - 1;
  let activeIndex = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(lineElements[middle].dataset.time) <= position) {
      activeIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (activeIndex === currentLyricsIndex) {
    return;
  }
  lineElements[currentLyricsIndex]?.classList.remove('active');
  currentLyricsIndex = activeIndex;
  const activeLine = lineElements[activeIndex];
  activeLine?.classList.add('active');
  if (activeLine && Date.now() >= lyricsUserScrollUntil) {
    activeLine.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  publishDesktopLyricsState(panel);
}

function startLyricsSync() {
  if (!lyricsSyncTimer) {
    lyricsSyncTimer = window.setInterval(updateSyncedLyrics, 32);
  }
}

function stopLyricsSync() {
  if (lyricsSyncTimer) {
    window.clearInterval(lyricsSyncTimer);
    lyricsSyncTimer = null;
  }
}

function handleDetectedTrackChange(snapshot) {
  lyricsRequestToken += 1;
  currentLyricsKey = '';
  currentLyricsState = 'idle';
  currentLyricsIndex = -1;
  currentLyricsResult = null;
  currentLyricsTrack = snapshot.track;
  lyricsRetryAt = 0;
  lyricsRetryAttempted = false;
  lyricsRetryKey = '';
  lyricsProviderRetryPending = false;
  stopLyricsSync();
  forceLyricsRefreshKey = appearanceSettings.lrclibLyrics
    ? getLyricsTrackFingerprint(snapshot.track)
    : '';
  ipcRenderer.send('desktop-lyrics:clear');
  for (const panel of getLyricsPanels()) {
    panel.dataset.timelineKey = '';
    panel.dataset.lyricsVideoId = String(snapshot.track?.videoId || snapshot.videoId || '');
    delete panel.dataset.autoTranslationChecked;
    if (appearanceSettings.lrclibLyrics) {
      setLyricsStatus(panel, getAppearanceStrings().lyricsLoading, true);
    } else {
      panel.querySelector('.ytm-desktop-lyrics-lines')?.replaceChildren();
      resetLyricsTranslation(panel, true);
    }
  }
}

async function loadLyricsForCurrentTrack() {
  const panel = getCurrentLyricsPanel();
  if (!appearanceSettings.lrclibLyrics) {
    currentLyricsResult = null;
    currentLyricsTrack = null;
    ipcRenderer.send('desktop-lyrics:clear');
    return;
  }

  const track = getLyricsTrack();
  const trackFingerprint = getLyricsTrackFingerprint(track);
  if (!trackFingerprint) {
    return;
  }

  const key = JSON.stringify({
    identity: trackFingerprint,
    language: document.documentElement.lang.toLowerCase(),
    netease: appearanceSettings.neteaseLyrics
  });
  const retrying = key === currentLyricsKey
    && (
      ['empty', 'error'].includes(currentLyricsState)
      || (currentLyricsState === 'ready' && lyricsProviderRetryPending)
    )
    && !lyricsRetryAttempted
    && Date.now() >= lyricsRetryAt;
  const metadataRefresh = Boolean(key !== currentLyricsKey
    && currentLyricsState === 'ready'
    && currentLyricsResult
    && currentLyricsTrack?.videoId === track?.videoId);
  const preservedResult = (retrying || metadataRefresh) && currentLyricsState === 'ready'
    ? currentLyricsResult
    : null;
  if (key === currentLyricsKey && currentLyricsState === 'loading') {
    return;
  }
  if (key === currentLyricsKey && currentLyricsState === 'ready'
    && currentLyricsResult && !retrying) {
    if (panel && !panel.hidden && panel.dataset.timelineKey !== key) {
      renderLyricsResult(panel, currentLyricsResult, key);
    }
    return;
  }
  if (key === currentLyricsKey && ['empty', 'error'].includes(currentLyricsState)
    && !retrying) {
    return;
  }
  if (key !== currentLyricsKey) {
    lyricsRequestToken += 1;
    lyricsRetryAt = 0;
    lyricsRetryAttempted = false;
    lyricsRetryKey = key;
    lyricsProviderRetryPending = false;
  } else if (retrying) {
    lyricsRetryAttempted = true;
    lyricsProviderRetryPending = false;
  }
  currentLyricsKey = key;
  currentLyricsState = preservedResult ? 'ready' : 'loading';
  currentLyricsResult = preservedResult;
  currentLyricsTrack = track;
  if (preservedResult && panel && panel.dataset.timelineKey !== key) {
    if (panel.querySelector('.ytm-desktop-lyrics-line')) {
      panel.dataset.timelineKey = key;
      panel.dataset.lyricsVideoId = String(track?.videoId || '');
      delete panel.dataset.autoTranslationChecked;
      publishDesktopLyricsState(panel);
      refreshLyricsTranslationAvailability(panel);
    } else {
      renderLyricsResult(panel, preservedResult, key);
    }
  }
  if (!preservedResult) {
    currentLyricsIndex = -1;
    ipcRenderer.send('desktop-lyrics:clear');
  }
  const requestToken = ++lyricsRequestToken;
  const forceRefresh = forceLyricsRefreshKey === trackFingerprint || retrying;
  if (forceRefresh) {
    forceLyricsRefreshKey = '';
  }
  if (panel && !preservedResult) {
    panel.dataset.timelineKey = key;
    setLyricsStatus(panel, getAppearanceStrings().lyricsLoading, true);
  }

  try {
    const value = await ipcRenderer.invoke('lyrics:resolve', {
      forceRefresh,
      neteaseEnabled: appearanceSettings.neteaseLyrics,
      track
    });
    document.documentElement.dataset.ytmDesktopLyricsProviders = Array.isArray(value?.providerAttempts)
      ? value.providerAttempts.join(',')
      : value?.source || 'none';
    const result = normalizeLyricsResult(value, track);
    if (requestToken !== lyricsRequestToken) {
      return;
    }
    if (!result?.lines?.length) {
      if (preservedResult) {
        currentLyricsState = 'ready';
        currentLyricsResult = preservedResult;
        currentLyricsTrack = track;
        lyricsProviderRetryPending = false;
        lyricsRetryAt = 0;
        return;
      }
      currentLyricsState = 'empty';
      currentLyricsResult = null;
      currentLyricsTrack = track;
      lyricsProviderRetryPending = false;
      ipcRenderer.send('desktop-lyrics:clear');
      if (panel) {
        setLyricsStatus(panel, getAppearanceStrings().lyricsNotFound);
      }
      if (!lyricsRetryAttempted && lyricsRetryKey === key) {
        lyricsRetryAt = Date.now() + 1500;
      }
      return;
    }
    lyricsProviderRetryPending = value?.retryRecommended === true && !lyricsRetryAttempted;
    lyricsRetryAt = lyricsProviderRetryPending ? Date.now() + 5000 : 0;
    currentLyricsState = 'ready';
    currentLyricsResult = result;
    currentLyricsTrack = track;
    currentLyricsIndex = -1;
    publishDesktopLyricsState(null);
    if (panel) {
      renderLyricsResult(panel, result, key);
    }
    if (lyricsProviderRetryPending) {
      window.setTimeout(requestLyricsRefresh, 5050);
    }
  } catch (error) {
    console.warn('Unable to load lyrics:', error.message);
    if (requestToken === lyricsRequestToken) {
      if (preservedResult) {
        currentLyricsState = 'ready';
        currentLyricsResult = preservedResult;
        currentLyricsTrack = track;
        lyricsProviderRetryPending = false;
        lyricsRetryAt = 0;
        return;
      }
      currentLyricsState = 'error';
      currentLyricsResult = null;
      lyricsProviderRetryPending = false;
      ipcRenderer.send('desktop-lyrics:clear');
      if (panel) {
        setLyricsStatus(panel, getAppearanceStrings().lyricsError);
      }
      if (!lyricsRetryAttempted && lyricsRetryKey === key) {
        lyricsRetryAt = Date.now() + 4000;
      }
    }
  }
}

function requestLyricsRefresh() {
  if (!appearanceSettings.lrclibLyrics) {
    return;
  }
  const fingerprint = getLyricsTrackFingerprint();
  if (!fingerprint) {
    return;
  }
  const key = JSON.stringify({
    identity: fingerprint,
    language: document.documentElement.lang.toLowerCase(),
    netease: appearanceSettings.neteaseLyrics
  });
  if (key === currentLyricsKey) {
    const providerRetryReady = currentLyricsState === 'ready'
      && lyricsProviderRetryPending
      && !lyricsRetryAttempted
      && Date.now() >= lyricsRetryAt;
    if (currentLyricsState === 'loading'
      || (currentLyricsState === 'ready' && !providerRetryReady)) {
      return;
    }
    if (['empty', 'error'].includes(currentLyricsState)
      && (lyricsRetryAttempted || Date.now() < lyricsRetryAt)) {
      return;
    }
  }
  window.queueMicrotask(loadLyricsForCurrentTrack);
}

function deactivateCustomLyrics(playerPage, selectedTab = null) {
  const panel = playerPage.querySelector(`#${LYRICS_PANEL_ID}`);
  const nativeRenderers = playerPage.querySelectorAll(
    '#side-panel > ytmusic-tab-renderer, #side-panel ytmusic-tab-renderer'
  );
  if (panel) {
    panel.hidden = true;
    panel.dataset.active = 'false';
  }
  for (const nativeRenderer of nativeRenderers) {
    nativeRenderer.classList.remove('ytm-desktop-native-tab-hidden');
  }
  if (selectedTab) {
    for (const tab of playerPage.querySelectorAll('#side-panel tp-yt-paper-tab')) {
      const selected = tab === selectedTab;
      tab.classList.toggle('iron-selected', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    updateLyricsSelectionBar(playerPage, selectedTab);
  }
}

function applyCustomLyricsView(playerPage, lyricsTab) {
  const tabs = [...playerPage.querySelectorAll('#side-panel tp-yt-paper-tab')];
  const panel = playerPage.querySelector(`#${LYRICS_PANEL_ID}`);
  const nativeRenderer = playerPage.querySelector(
    '#side-panel > ytmusic-tab-renderer, #side-panel ytmusic-tab-renderer'
  );
  if (!panel) {
    return;
  }

  for (const tab of tabs) {
    const selected = tab === lyricsTab;
    tab.classList.toggle('iron-selected', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  updateLyricsSelectionBar(playerPage, lyricsTab);
  nativeRenderer?.classList.add('ytm-desktop-native-tab-hidden');
  panel.hidden = false;
  panel.dataset.active = 'true';
  maybeAutoTranslateLyrics(panel);
}

function activateCustomLyrics(playerPage, lyricsTab) {
  applyCustomLyricsView(playerPage, lyricsTab);
  requestLyricsRefresh();
  window.requestAnimationFrame(() => {
    const panel = playerPage.querySelector(`#${LYRICS_PANEL_ID}`);
    if (panel?.dataset.active === 'true') {
      applyCustomLyricsView(playerPage, lyricsTab);
    }
  });
}

function installLyricsIntegration() {
  for (const playerPage of document.querySelectorAll('ytmusic-player-page')) {
    const sidePanel = playerPage.querySelector('#side-panel');
    const lyricsTab = findLyricsTab(playerPage);
    if (!sidePanel || !lyricsTab) {
      continue;
    }

    if (!lyricsTab.dataset.ytmDesktopOriginalDisabled) {
      lyricsTab.dataset.ytmDesktopOriginalDisabled = String(lyricsTab.hasAttribute('disabled'));
    }
    if (!playerPage.querySelector(`#${LYRICS_PANEL_ID}`)) {
      sidePanel.appendChild(createLyricsPanel());
    }

    if (lyricsTab.dataset.ytmDesktopBound !== 'true') {
      lyricsTab.dataset.ytmDesktopBound = 'true';
      lyricsTab.addEventListener('click', (event) => {
        if (!appearanceSettings.lrclibLyrics) {
          return;
        }
        const panel = playerPage.querySelector(`#${LYRICS_PANEL_ID}`);
        if (!panel) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        activateCustomLyrics(playerPage, lyricsTab);
      }, true);
    }

    for (const tab of playerPage.querySelectorAll('#side-panel tp-yt-paper-tab')) {
      if (tab !== lyricsTab && tab.dataset.ytmDesktopLyricsExitBound !== 'true') {
        tab.dataset.ytmDesktopLyricsExitBound = 'true';
        tab.addEventListener('click', () => {
          deactivateCustomLyrics(playerPage, tab);
          window.requestAnimationFrame(() => updateLyricsSelectionBar(playerPage, tab));
        }, true);
      }
    }

    const selectedTab = playerPage.querySelector('#side-panel tp-yt-paper-tab.iron-selected')
      || playerPage.querySelector('#side-panel tp-yt-paper-tab[aria-selected="true"]')
      || playerPage.querySelector('#side-panel tp-yt-paper-tab');
    if (appearanceSettings.lrclibLyrics) {
      lyricsTab.removeAttribute('disabled');
      lyricsTab.setAttribute('aria-disabled', 'false');
      lyricsTab.style.pointerEvents = '';
      const panel = playerPage.querySelector(`#${LYRICS_PANEL_ID}`);
      if (panel?.dataset.active === 'true' || selectedTab === lyricsTab) {
        applyCustomLyricsView(playerPage, lyricsTab);
      }
    } else {
      const wasDisabled = lyricsTab.dataset.ytmDesktopOriginalDisabled === 'true';
      lyricsTab.toggleAttribute('disabled', wasDisabled);
      lyricsTab.setAttribute('aria-disabled', String(wasDisabled));
      lyricsTab.style.pointerEvents = wasDisabled ? 'none' : '';
      if (playerPage.querySelector(`#${LYRICS_PANEL_ID}`)?.dataset.active === 'true') {
        const firstTab = playerPage.querySelector('#side-panel tp-yt-paper-tab');
        deactivateCustomLyrics(playerPage, firstTab);
        firstTab?.click();
      }
    }
    updateLyricsSelectionBar(playerPage, selectedTab);
  }
}

function refreshLyricsIntegration() {
  installLyricsIntegration();
  if (appearanceSettings.lrclibLyrics) {
    requestLyricsRefresh();
  } else {
    stopLyricsSync();
    forceLyricsRefreshKey = '';
    lyricsRetryAt = 0;
    lyricsRetryAttempted = false;
    lyricsRetryKey = '';
    lyricsProviderRetryPending = false;
    lyricsRequestToken += 1;
    currentLyricsKey = '';
    currentLyricsState = 'idle';
    currentLyricsResult = null;
    currentLyricsTrack = null;
    ipcRenderer.send('desktop-lyrics:clear');
  }
}

function getScrollMetrics(track) {
  const root = document.scrollingElement || document.documentElement;
  const viewportHeight = window.innerHeight;
  const scrollHeight = root.scrollHeight;
  const maxScroll = Math.max(0, scrollHeight - viewportHeight);
  const trackHeight = track.clientHeight;
  const thumbHeight = Math.min(trackHeight, Math.max(34, trackHeight * viewportHeight / scrollHeight));
  const thumbTravel = Math.max(0, trackHeight - thumbHeight);

  return { maxScroll, root, thumbHeight, thumbTravel, trackHeight };
}

function updateScrollbar() {
  scrollbarFrame = null;
  const track = document.getElementById(SCROLLBAR_ID);
  const thumb = track?.firstElementChild;
  if (!track || !thumb) {
    return;
  }

  const metrics = getScrollMetrics(track);
  track.hidden = metrics.maxScroll <= 1;
  if (track.hidden) {
    return;
  }

  const progress = metrics.maxScroll === 0 ? 0 : metrics.root.scrollTop / metrics.maxScroll;
  thumb.style.height = `${metrics.thumbHeight}px`;
  thumb.style.transform = `translateY(${Math.round(progress * metrics.thumbTravel)}px)`;
}

function requestScrollbarUpdate() {
  if (!scrollbarFrame) {
    scrollbarFrame = window.requestAnimationFrame(updateScrollbar);
  }
}

function showScrollbar(autoHide = true) {
  const track = document.getElementById(SCROLLBAR_ID);
  if (!track || track.hidden) {
    return;
  }

  track.classList.add('visible');
  clearTimeout(hideScrollbarTimer);
  if (autoHide) {
    hideScrollbarTimer = window.setTimeout(() => track.classList.remove('visible'), 1400);
  }
}

function installScrollbar() {
  if (document.getElementById(SCROLLBAR_ID)) {
    return;
  }

  const track = document.createElement('div');
  const thumb = document.createElement('div');
  track.id = SCROLLBAR_ID;
  track.setAttribute('aria-hidden', 'true');
  thumb.className = 'ytm-desktop-scrollbar-thumb';
  track.appendChild(thumb);
  document.body.appendChild(track);

  let dragStartY = 0;
  let dragStartScroll = 0;
  let dragging = false;

  document.addEventListener('scroll', () => {
    requestScrollbarUpdate();
    showScrollbar();
  }, { capture: true, passive: true });

  window.addEventListener('resize', requestScrollbarUpdate, { passive: true });
  track.addEventListener('mouseenter', () => showScrollbar(false));
  track.addEventListener('mouseleave', () => {
    if (!dragging) {
      showScrollbar();
    }
  });

  track.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const metrics = getScrollMetrics(track);

    if (event.target !== thumb) {
      const bounds = track.getBoundingClientRect();
      const targetProgress = Math.max(0, Math.min(1, (event.clientY - bounds.top - metrics.thumbHeight / 2) / metrics.thumbTravel));
      window.scrollTo({ top: targetProgress * metrics.maxScroll, behavior: 'smooth' });
      showScrollbar();
      return;
    }

    dragging = true;
    dragStartY = event.clientY;
    dragStartScroll = metrics.root.scrollTop;
    thumb.setPointerCapture(event.pointerId);
    track.classList.add('dragging', 'visible');
    clearTimeout(hideScrollbarTimer);
  });

  thumb.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }

    const metrics = getScrollMetrics(track);
    const delta = event.clientY - dragStartY;
    const scrollDelta = metrics.thumbTravel === 0 ? 0 : delta / metrics.thumbTravel * metrics.maxScroll;
    window.scrollTo({ top: dragStartScroll + scrollDelta });
  });

  thumb.addEventListener('pointerup', (event) => {
    dragging = false;
    thumb.releasePointerCapture(event.pointerId);
    track.classList.remove('dragging');
    showScrollbar();
  });

  requestScrollbarUpdate();
}

function installWindowControls() {
  const navBar = document.querySelector('ytmusic-nav-bar');
  if (!navBar) {
    return false;
  }

  document.documentElement.classList.add('ytm-desktop-app');
  hidePageLoadingGuard();
  installScrollbar();
  bindVolumeWheelControl();

  if (!document.getElementById(CONTROL_ID)) {
    const strings = getAppearanceStrings();
    const controls = document.createElement('div');
    controls.id = CONTROL_ID;
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', strings.windowControls);
    controls.append(
      createButton('minimize', strings.minimize, icons.minimize),
      createButton('toggle-maximize', strings.maximize, icons.maximize),
      createButton('close', strings.close, icons.close)
    );
    document.body.appendChild(controls);
    ipcRenderer.send('window:get-state');
  }

  if (!readySent) {
    readySent = true;
    window.setTimeout(() => ipcRenderer.send('pwa:ready'), 250);
  }

  return true;
}

function watchPage() {
  installLanguageMonitor();
  installWindowControls();
  installPlaybackMonitor();
  installSurfaceAnimations();
  installAppearanceSettingsPage();
  installLyricsIntegration();
  ipcRenderer.invoke('appearance:get')
    .then(applyAppearanceSettings)
    .catch((error) => console.warn('Unable to read appearance settings:', error.message));
  document.addEventListener('pointerdown', rememberSettingsTouchSelection, true);
  document.addEventListener('pointerdown', rememberSurfaceTriggerPoint, true);
  document.addEventListener('pointerup', activateTouchedSettingsSelection, true);
  document.addEventListener('pointerdown', (event) => {
    const picker = document.getElementById(SETTING_PICKER_ID);
    if (picker && !picker.contains(event.target) && !picker._trigger?.contains(event.target)) {
      closeSettingPicker();
    }
  }, true);
  document.addEventListener('scroll', closeSettingPickerOnSettingsScroll, true);
  document.addEventListener('click', suppressSynthesizedSettingsClick, true);
  document.addEventListener('click', openPolicyLinkInSystemBrowser, true);
  document.addEventListener('click', interceptNativeSettingsCategoryClick, true);
  document.addEventListener('click', interceptSettingsClose, true);
  document.addEventListener('click', ensureLanguageChangeReload, true);
  document.addEventListener('keydown', interceptSettingsEscape, true);
  document.addEventListener('keydown', interceptReloadShortcut, true);
  document.addEventListener('contextmenu', showMaterialContextMenu, true);
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.(`#${CONTEXT_MENU_ID}`)) {
      closeMaterialContextMenu();
    }
  }, true);
  window.addEventListener('blur', closeMaterialContextMenu);
  window.addEventListener('resize', closeMaterialContextMenu);
  window.addEventListener('resize', () => closeSettingPicker());
  window.addEventListener('resize', requestSurfaceAnimationRefresh, { passive: true });
  window.addEventListener('resize', refreshSettingsSelectionIndicators, { passive: true });

  const observer = new MutationObserver(() => {
    if (!document.getElementById(CONTROL_ID)) {
      installWindowControls();
    }
    installAppearanceSettingsPage();
    installLyricsIntegration();
    bindVolumeWheelControl();
    requestScrollbarUpdate();
    requestPlaybackPoll();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.setTimeout(() => {
    if (!readySent && document.querySelector('ytmusic-app')) {
      readySent = true;
      ipcRenderer.send('pwa:ready');
    }
  }, 7000);
}

ipcRenderer.on('window:maximized', (_event, isMaximized) => {
  windowIsMaximized = isMaximized;
  const button = document.querySelector('.ytm-desktop-toggle-maximize');
  if (!button) {
    return;
  }

  button.replaceChildren(createIcon(isMaximized ? icons.restore : icons.maximize));
  const strings = getAppearanceStrings();
  button.title = isMaximized ? strings.restore : strings.maximize;
  button.setAttribute('aria-label', button.title);
});

ipcRenderer.on('window:request-close', showCloseDialog);
ipcRenderer.on('appearance:changed', (_event, value) => applyAppearanceSettings(value));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', watchPage, { once: true });
} else {
  watchPage();
}
