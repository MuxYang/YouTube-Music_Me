'use strict';

const { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, net, safeStorage, screen, session, shell, Tray, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  APP_NAME,
  DEFAULT_SETTINGS,
  MUSIC_URL,
  isExternalPolicyUrl,
  isTrustedAppUrl,
  normalizeSettings
} = require('./config');
const {
  hasGoogleAccountCookies,
  isAuthenticationEntryUrl,
  isGoogleAccountCookie,
  isYouTubeSignInUrl,
  isYouTubeUrl
} = require('./auth');
const {
  normalizeTranslationLanguage
} = require('./lyrics');
const { createLyricsService } = require('./lyrics-service');
const {
  getAppStrings,
  getDeepLConfigStrings,
  parseYouTubeLanguagePreference
} = require('./i18n');
const {
  createDeepLLyricsPayloads,
  createGoogleLyricsBatches,
  joinGoogleLyricsLines,
  normalizeDeepLAuthKey,
  normalizeTranslationProvider,
  splitGoogleLyricsText
} = require('./translation');

app.commandLine.appendSwitch(
  'disable-features',
  'WebAuthenticationConditionalUI,WebAuthnEnclaveAuthenticator,WebAuthnUseNativeWinApi'
);
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling');

const iconPath = path.join(__dirname, 'assets', 'icon.png');
const splashPath = path.join(__dirname, 'renderer', 'splash.html');
const musicPreloadPath = path.join(__dirname, 'preload', 'music.js');
const splashPreloadPath = path.join(__dirname, 'preload', 'splash.js');
const deeplConfigPreloadPath = path.join(__dirname, 'preload', 'deepl-config.js');
const deeplConfigPath = path.join(__dirname, 'renderer', 'deepl-config.html');
const titlebarCssPath = path.join(__dirname, 'renderer', 'titlebar.css');

let mainWindow = null;
let musicView = null;
let authWindow = null;
let deeplConfigWindow = null;
let deeplConfigPromise = null;
let tray = null;
let isQuitting = false;
let cacheCaptureTimer = null;
let cacheCapturePromise = null;
let snapshotActionInProgress = false;
let startupRevealTimer = null;
let splashFallbackTimer = null;
let splashTransitionStarted = false;
let musicDocumentLoaded = false;
let musicInterfaceReady = false;
let musicLoadFailed = false;
let settings = DEFAULT_SETTINGS;
let electronUserAgent = '';
let youtubeLanguagePreference = '';
let restartRequested = false;
let deeplAuthKey = '';
const lyricsTranslationCache = new Map();
let desktopLyricsState = null;

function getUserDataPath(fileName) {
  return path.join(app.getPath('userData'), fileName);
}

function readSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(getUserDataPath('settings.json'), 'utf8'));
    return normalizeSettings(value);
  } catch {
    return normalizeSettings();
  }
}

function writeSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getUserDataPath('settings.json'), JSON.stringify(settings, null, 2));
}

function loadDeepLAuthKey() {
  deeplAuthKey = '';
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return;
    }
    const encrypted = fs.readFileSync(getUserDataPath('deepl-auth-key.bin'));
    deeplAuthKey = normalizeDeepLAuthKey(safeStorage.decryptString(encrypted));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Unable to read the encrypted DeepL API key:', error.message);
    }
  }
}

function storeDeepLAuthKey(authKey) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system.');
  }
  const normalized = normalizeDeepLAuthKey(authKey);
  const encrypted = safeStorage.encryptString(normalized);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(getUserDataPath('deepl-auth-key.bin'), encrypted, { mode: 0o600 });
  deeplAuthKey = normalized;
}

function openInSystemBrowser(url) {
  shell.openExternal(url).catch((error) => {
    console.warn('Unable to open the external URL:', error.message);
  });
}

function getAppearanceSettings() {
  return {
    ...settings.appearance,
    autoTranslateLyrics: settings.lyrics.autoTranslate,
    closeAction: settings.closeAction,
    deeplConfigured: Boolean(deeplAuthKey),
    lrclibLyrics: settings.lyrics.lrclibEnabled,
    lyricsTranslationProvider: settings.lyrics.translationProvider,
    neteaseLyrics: settings.lyrics.neteaseEnabled,
    neteaseTranslationSource: settings.lyrics.neteaseTranslationSource
  };
}

function sanitizeDesktopLyricsPayload(payload = {}) {
  const track = payload.track && typeof payload.track === 'object'
    ? {
      artist: String(payload.track.artist || '').slice(0, 500),
      title: String(payload.track.title || '').slice(0, 500),
      videoId: String(payload.track.videoId || '').slice(0, 100)
    }
    : null;
  const lines = Array.isArray(payload.lines)
    ? payload.lines.slice(0, 1000).map((line) => ({
      text: String(line?.text || '').slice(0, 2000),
      time: Number.isFinite(Number(line?.time)) ? Math.max(0, Number(line.time)) : 0,
      translation: String(line?.translation || '').slice(0, 2000)
    }))
    : [];
  const currentIndex = Number.isInteger(payload.currentIndex)
    ? Math.max(-1, Math.min(payload.currentIndex, lines.length - 1))
    : -1;
  return {
    currentIndex,
    lines,
    source: String(payload.source || '').slice(0, 50),
    targetLanguage: payload.translated === true
      ? normalizeTranslationLanguage(payload.targetLanguage)
      : '',
    track,
    translated: payload.translated === true,
    updatedAt: Date.now()
  };
}

function nextLyricsEnabled(currentSettings, patch = {}) {
  const syncEnabled = typeof patch.lrclibLyrics === 'boolean'
    ? patch.lrclibLyrics
    : currentSettings.lyrics.lrclibEnabled;
  const neteaseEnabled = typeof patch.neteaseLyrics === 'boolean'
    ? patch.neteaseLyrics
    : currentSettings.lyrics.neteaseEnabled;
  return syncEnabled && neteaseEnabled;
}

function nextAutoTranslateEnabled(currentSettings, patch = {}) {
  const syncEnabled = typeof patch.lrclibLyrics === 'boolean'
    ? patch.lrclibLyrics
    : currentSettings.lyrics.lrclibEnabled;
  const autoTranslate = typeof patch.autoTranslateLyrics === 'boolean'
    ? patch.autoTranslateLyrics
    : currentSettings.lyrics.autoTranslate;
  return syncEnabled && autoTranslate;
}

function nextNeteaseTranslationSourceEnabled(currentSettings, patch = {}) {
  const syncEnabled = typeof patch.lrclibLyrics === 'boolean'
    ? patch.lrclibLyrics
    : currentSettings.lyrics.lrclibEnabled;
  const neteaseEnabled = typeof patch.neteaseLyrics === 'boolean'
    ? patch.neteaseLyrics
    : currentSettings.lyrics.neteaseEnabled;
  const sourceEnabled = typeof patch.neteaseTranslationSource === 'boolean'
    ? patch.neteaseTranslationSource
    : currentSettings.lyrics.neteaseTranslationSource;
  return syncEnabled && neteaseEnabled && sourceEnabled;
}

function setBoundedCache(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    map.delete(map.keys().next().value);
  }
}

async function requestLyricsJson(rawUrl, options = {}) {
  const url = new URL(rawUrl);
  const isConfiguredProvider = url.hostname === 'lrclib.net'
    || url.hostname === 'music.163.com';
  const isYouTubeTimedText = (url.hostname === 'youtube.com'
    || url.hostname.endsWith('.youtube.com'))
    && url.pathname === '/api/timedtext';
  if (url.protocol !== 'https:' || (!isConfiguredProvider && !isYouTubeTimedText)) {
    throw new Error('Lyrics requests are limited to configured providers.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const response = await net.fetch(url.href, {
      headers: {
        'User-Agent': electronUserAgent || 'YouTube Music Me/0.1.0',
        ...(options.headers || {})
      },
      signal: controller.signal
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`${url.hostname} returned HTTP ${response.status}`);
    }
    const body = await response.text();
    if (!body || Buffer.byteLength(body, 'utf8') > 8 * 1024 * 1024) {
      throw new Error(`${url.hostname} returned an empty or oversized response.`);
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

const lyricsService = createLyricsService({
  getUserAgent: () => electronUserAgent,
  requestJson: requestLyricsJson
});

async function translateGoogleText(text, targetLanguage) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const body = new URLSearchParams({
    client: 'gtx',
    dt: 't',
    q: text,
    sl: 'auto',
    tl: targetLanguage
  });
  try {
    const response = await net.fetch('https://translate.googleapis.com/translate_a/single', {
      body: body.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': electronUserAgent || 'YouTube Music Me/0.1.0'
      },
      method: 'POST',
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Google Translate returned HTTP ${response.status}`);
    }
    const responseBody = await response.text();
    if (!responseBody || Buffer.byteLength(responseBody, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('Google Translate response was empty or too large.');
    }
    const value = JSON.parse(responseBody);
    const translated = Array.isArray(value?.[0])
      ? value[0].map((segment) => segment?.[0] || '').join('')
      : '';
    if (!translated) {
      throw new Error('Google Translate returned no translated text.');
    }
    return {
      detectedLanguage: typeof value?.[2] === 'string' ? value[2] : '',
      text: translated.replace(/\r/g, '')
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function translateGoogleBatch(lines, targetLanguage) {
  const response = await translateGoogleText(joinGoogleLyricsLines(lines), targetLanguage);
  return {
    detectedLanguage: response.detectedLanguage,
    lines: splitGoogleLyricsText(response.text, lines.length)
  };
}

async function requestDeepL(pathname, authKey, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await net.fetch(`https://api-free.deepl.com${pathname}`, {
      body: options.body,
      headers: {
        Accept: 'application/json',
        Authorization: `DeepL-Auth-Key ${authKey}`,
        'Content-Type': 'application/json',
        'User-Agent': electronUserAgent || 'YouTube Music Me/0.1.0'
      },
      method: options.method || 'GET',
      signal: controller.signal
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`DeepL returned HTTP ${response.status}`);
    }
    if (!responseBody || Buffer.byteLength(responseBody, 'utf8') > 2 * 1024 * 1024) {
      throw new Error('DeepL returned an empty or oversized response.');
    }
    return JSON.parse(responseBody);
  } finally {
    clearTimeout(timeout);
  }
}

async function validateDeepLAuthKey(authKey) {
  await requestDeepL('/v2/usage', authKey, { timeoutMs: 10000 });
}

async function translateDeepLPayload(payload, authKey) {
  const value = await requestDeepL('/v2/translate', authKey, {
    body: JSON.stringify(payload),
    method: 'POST'
  });
  const translations = Array.isArray(value?.translations) ? value.translations : [];
  if (translations.length !== payload.text.length
    || translations.some((translation) => typeof translation?.text !== 'string')) {
    throw new Error('DeepL did not preserve the lyrics timeline.');
  }
  return {
    detectedLanguage: translations.find((translation) => translation.detected_source_language)
      ?.detected_source_language || '',
    lines: translations.map((translation) => translation.text.trim())
  };
}

async function translateLyricsLines(payload = {}) {
  const targetLanguage = normalizeTranslationLanguage(payload.targetLanguage);
  const lines = Array.isArray(payload.lines)
    ? payload.lines.slice(0, 500).map((line) => String(line || '').trim().slice(0, 1000))
    : [];
  if (!lines.length || lines.some((line) => !line)
    || lines.reduce((total, line) => total + line.length, 0) > 50000) {
    throw new Error('Invalid lyrics translation request.');
  }

  const provider = normalizeTranslationProvider(settings.lyrics.translationProvider);
  const cacheKey = `${provider}\0${targetLanguage}\0${lines.join('\n')}`;
  if (lyricsTranslationCache.has(cacheKey)) {
    return lyricsTranslationCache.get(cacheKey);
  }
  if (provider === 'deepl' && !deeplAuthKey) {
    throw new Error('DeepL is selected but no API Free key is configured.');
  }
  const translatedBatches = provider === 'deepl'
    ? await Promise.all(createDeepLLyricsPayloads(lines, targetLanguage)
      .map((batch) => translateDeepLPayload(batch, deeplAuthKey)))
    : await Promise.all(createGoogleLyricsBatches(lines)
      .map((batch) => translateGoogleBatch(batch, targetLanguage)));
  const translatedLines = translatedBatches.flatMap((batch) => batch.lines);
  if (translatedLines.length !== lines.length) {
    throw new Error('The translation service did not preserve the lyrics timeline.');
  }
  const result = {
    lines: translatedLines,
    provider,
    sourceLanguage: translatedBatches.find((batch) => batch.detectedLanguage)?.detectedLanguage || '',
    targetLanguage
  };
  setBoundedCache(lyricsTranslationCache, cacheKey, result, 30);
  return result;
}

async function suppressAutomaticPasskeyUi(contents) {
  try {
    if (!contents.debugger.isAttached()) {
      contents.debugger.attach('1.3');
    }
    await contents.debugger.sendCommand('WebAuthn.enable', { enableUI: false });
  } catch (error) {
    console.warn('Unable to suppress automatic passkey prompts:', error.message);
  }
}

function getVisibleWindowBounds(savedBounds) {
  const candidate = { ...savedBounds };

  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) {
    return candidate;
  }

  const intersectsDisplay = screen.getAllDisplays().some(({ workArea }) => {
    const horizontalOverlap = candidate.x < workArea.x + workArea.width
      && candidate.x + candidate.width > workArea.x;
    const verticalOverlap = candidate.y < workArea.y + workArea.height
      && candidate.y + candidate.height > workArea.y;
    return horizontalOverlap && verticalOverlap;
  });

  if (!intersectsDisplay) {
    delete candidate.x;
    delete candidate.y;
  }

  return candidate;
}

function loadSplash() {
  return mainWindow.loadFile(splashPath);
}

function getCachedMusicUrl() {
  try {
    const metadata = JSON.parse(fs.readFileSync(getUserDataPath('ui-cache.json'), 'utf8'));
    const url = new URL(metadata.url);
    if (url.protocol === 'https:' && url.hostname === 'music.youtube.com') {
      return url.href;
    }
  } catch {
    // The first launch has no cache metadata yet.
  }

  return MUSIC_URL;
}

function persistWindowSettings() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMaximized()) {
    settings = { ...settings, windowBounds: mainWindow.getBounds() };
  }
  writeSettings();
}

function restartApplication() {
  if (restartRequested) {
    return;
  }

  restartRequested = true;
  isQuitting = true;
  clearTimeout(cacheCaptureTimer);
  clearStartupRevealTimers();

  try {
    persistWindowSettings();
  } catch (error) {
    console.warn('Unable to save settings before restarting:', error.message);
  }

  try {
    app.relaunch();
  } catch (error) {
    restartRequested = false;
    isQuitting = false;
    console.warn('Unable to restart the application:', error.message);
    return;
  }

  const forceExitTimer = setTimeout(() => app.exit(0), 1500);
  forceExitTimer.unref?.();
  app.quit();
}

function getDeepLConfigWindowTitle(locale) {
  return `${getDeepLConfigStrings(locale).title} - ${APP_NAME}`;
}

function openDeepLConfigWindow(locale = '') {
  if (deeplConfigWindow && !deeplConfigWindow.isDestroyed()) {
    deeplConfigWindow.focus();
    return deeplConfigPromise;
  }

  const currentWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: '#202124',
    closable: true,
    frame: true,
    fullscreenable: false,
    height: 360,
    icon: iconPath,
    maximizable: false,
    minimizable: false,
    modal: true,
    parent: mainWindow,
    resizable: false,
    show: false,
    title: getDeepLConfigWindowTitle(locale),
    webPreferences: {
      contextIsolation: true,
      devTools: false,
      preload: deeplConfigPreloadPath,
      sandbox: true
    },
    width: 500
  });
  deeplConfigWindow = currentWindow;
  currentWindow.setMenuBarVisibility(false);
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  currentWindow.once('ready-to-show', () => currentWindow.show());
  deeplConfigPromise = new Promise((resolve) => {
    currentWindow.once('closed', () => {
      if (deeplConfigWindow === currentWindow) {
        deeplConfigWindow = null;
      }
      const result = getAppearanceSettings();
      deeplConfigPromise = null;
      resolve(result);
    });
  });
  currentWindow.loadFile(deeplConfigPath, {
    query: { locale: String(locale || '').slice(0, 35) }
  }).catch((error) => {
    console.warn('Unable to open DeepL configuration:', error.message);
    if (!currentWindow.isDestroyed()) {
      currentWindow.close();
    }
  });
  return deeplConfigPromise;
}

function installYouTubeLanguageMonitor(musicSession) {
  musicSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
    const domain = String(cookie.domain || '').replace(/^\./u, '');
    if (removed || cookie.name !== 'PREF'
      || (domain !== 'youtube.com' && !domain.endsWith('.youtube.com'))) {
      return;
    }
    const nextLanguage = parseYouTubeLanguagePreference(cookie.value);
    if (!nextLanguage || nextLanguage === youtubeLanguagePreference) {
      return;
    }
    youtubeLanguagePreference = nextLanguage;
    restartApplication();
  });
}

function resizeMusicView() {
  if (!mainWindow || !musicView || mainWindow.isDestroyed()) {
    return;
  }

  const [width, height] = mainWindow.getContentSize();
  musicView.setBounds({ x: 0, y: 0, width, height });
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || !musicView || musicView.webContents.isDestroyed()) {
    return;
  }

  musicView.webContents.send('window:maximized', mainWindow.isMaximized());
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.show();
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

function openAuthWindow(url) {
  if (authWindow && !authWindow.isDestroyed()) {
    authWindow.show();
    authWindow.focus();
    if (authWindow.webContents.getURL() !== url) {
      authWindow.loadURL(url);
    }
    return;
  }

  authWindow = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    parent: mainWindow,
    modal: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#f8fafd',
    icon: iconPath,
    title: `${getAppStrings(app.getLocale()).authTitle} - ${APP_NAME}`,
    webPreferences: {
      partition: 'persist:youtube-music',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  const currentAuthWindow = authWindow;
  const authContents = currentAuthWindow.webContents;
  const authSession = authContents.session;
  let authenticationCompleted = false;
  let authenticationCheckInFlight = false;
  let authenticationCheckTimer = null;

  currentAuthWindow.setMenuBarVisibility(false);
  authContents.setUserAgent(electronUserAgent);
  suppressAutomaticPasskeyUi(authContents);
  authContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (isExternalPolicyUrl(popupUrl)) {
      openInSystemBrowser(popupUrl);
      return { action: 'deny' };
    }

    if (isTrustedAppUrl(popupUrl)) {
      return { action: 'allow' };
    }

    openInSystemBrowser(popupUrl);
    return { action: 'deny' };
  });
  const scheduleAuthenticationCheck = (nextUrl = authContents.getURL()) => {
    if (!isYouTubeUrl(nextUrl) || isYouTubeSignInUrl(nextUrl)) {
      return;
    }
    clearTimeout(authenticationCheckTimer);
    authenticationCheckTimer = setTimeout(async () => {
      if (authenticationCheckInFlight || currentAuthWindow.isDestroyed()) {
        return;
      }
      authenticationCheckInFlight = true;
      try {
        const cookies = await authSession.cookies.get({});
        if (!hasGoogleAccountCookies(cookies)) {
          return;
        }
        await authSession.cookies.flushStore();
        authenticationCompleted = true;
        if (!currentAuthWindow.isDestroyed()) {
          currentAuthWindow.close();
        }
      } catch (error) {
        console.warn('Unable to verify the Google login session:', error.message);
      } finally {
        authenticationCheckInFlight = false;
      }
    }, 650);
  };
  const handleAuthCookieChange = (_event, cookie, _cause, removed) => {
    if (!removed && isGoogleAccountCookie(cookie)) {
      scheduleAuthenticationCheck();
    }
  };

  authContents.on('will-navigate', (event, nextUrl) => {
    if (!isTrustedAppUrl(nextUrl)) {
      event.preventDefault();
      openInSystemBrowser(nextUrl);
    }
  });
  authContents.on('will-redirect', (event, nextUrl) => {
    if (!isTrustedAppUrl(nextUrl)) {
      event.preventDefault();
      openInSystemBrowser(nextUrl);
    }
  });
  authContents.on('did-navigate', (_event, nextUrl) => scheduleAuthenticationCheck(nextUrl));
  authContents.on('did-navigate-in-page', (_event, nextUrl) => scheduleAuthenticationCheck(nextUrl));
  authContents.on('did-finish-load', () => scheduleAuthenticationCheck());
  authSession.cookies.on('changed', handleAuthCookieChange);
  currentAuthWindow.on('closed', () => {
    clearTimeout(authenticationCheckTimer);
    authSession.cookies.removeListener('changed', handleAuthCookieChange);
    if (authWindow === currentAuthWindow) {
      authWindow = null;
    }
    showMainWindow();
    if (authenticationCompleted && musicView && !musicView.webContents.isDestroyed()) {
      setTimeout(() => {
        if (musicView && !musicView.webContents.isDestroyed()) {
          musicView.webContents.reloadIgnoringCache();
        }
      }, 250);
    }
  });
  currentAuthWindow.loadURL(url).catch((error) => {
    console.warn('Unable to open the Google login page:', error.message);
  });
}

function captureUiCache(maxAttempts = 1) {
  if (cacheCapturePromise) {
    return cacheCapturePromise;
  }

  cacheCapturePromise = (async () => {
    if (!mainWindow || !musicView || musicView.webContents.isDestroyed() || !musicView.getVisible()) {
      return false;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const contents = musicView.webContents;
        const attachedHere = !contents.debugger.isAttached();
        if (attachedHere) {
          contents.debugger.attach('1.3');
        }

        try {
          const { data } = await contents.debugger.sendCommand('Page.captureScreenshot', {
            captureBeyondViewport: false,
            format: 'png',
            fromSurface: true
          });
          const [width, height] = mainWindow.getContentSize();
          fs.mkdirSync(app.getPath('userData'), { recursive: true });
          fs.writeFileSync(getUserDataPath('ui-cache.png'), Buffer.from(data, 'base64'));
          fs.writeFileSync(getUserDataPath('ui-cache.json'), JSON.stringify({
            capturedAt: new Date().toISOString(),
            height,
            url: contents.getURL(),
            width
          }, null, 2));
          return true;
        } finally {
          if (attachedHere && contents.debugger.isAttached()) {
            contents.debugger.detach();
          }
        }
      } catch (error) {
        if (attempt + 1 >= maxAttempts) {
          console.warn('Unable to update the startup UI cache:', error.message);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    return false;
  })().finally(() => {
    cacheCapturePromise = null;
  });

  return cacheCapturePromise;
}

function scheduleUiCacheCapture() {
  clearTimeout(cacheCaptureTimer);
  cacheCaptureTimer = setTimeout(() => captureUiCache(3), 6500);
}

async function captureBeforeWindowAction(action) {
  if (snapshotActionInProgress) {
    return;
  }

  snapshotActionInProgress = true;
  clearTimeout(cacheCaptureTimer);
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (cacheCapturePromise) {
    await cacheCapturePromise;
  }
  await captureUiCache(2);
  action();
  snapshotActionInProgress = false;
}

function clearStartupRevealTimers() {
  clearTimeout(startupRevealTimer);
  clearTimeout(splashFallbackTimer);
  startupRevealTimer = null;
  splashFallbackTimer = null;
}

function revealMusicView() {
  if (!musicView || !mainWindow || musicView.webContents.isDestroyed()) {
    return;
  }

  clearStartupRevealTimers();
  resizeMusicView();
  musicView.setVisible(true);
  sendWindowState();
  scheduleUiCacheCapture();
}

function requestSplashReveal(reason) {
  if (
    splashTransitionStarted
    || musicLoadFailed
    || !mainWindow
    || mainWindow.isDestroyed()
    || !musicView
    || musicView.webContents.isDestroyed()
  ) {
    return;
  }

  splashTransitionStarted = true;
  clearTimeout(startupRevealTimer);
  startupRevealTimer = null;
  mainWindow.webContents.send('splash:state', { reason, status: 'ready' });
  splashFallbackTimer = setTimeout(() => revealMusicView(), 3200);
}

function maybeRevealSplash() {
  if (musicDocumentLoaded && musicInterfaceReady) {
    requestSplashReveal('loaded');
  }
}

function loadMusic() {
  if (!musicView || musicView.webContents.isDestroyed()) {
    return;
  }

  clearStartupRevealTimers();
  splashTransitionStarted = false;
  musicDocumentLoaded = false;
  musicInterfaceReady = false;
  musicLoadFailed = false;
  mainWindow.webContents.send('splash:state', { status: 'loading' });
  musicView.setVisible(false);
  startupRevealTimer = setTimeout(() => requestSplashReveal('timeout'), 7000);
  musicView.webContents.loadURL(getCachedMusicUrl()).catch((error) => {
    musicLoadFailed = true;
    clearStartupRevealTimers();
    mainWindow?.webContents.send('splash:state', {
      status: 'error',
      message: error.message
    });
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(process.platform === 'linux' ? icon.resize({ width: 22, height: 22 }) : icon);
  tray.setToolTip(APP_NAME);

  const refreshMenu = () => {
    const strings = getAppStrings(app.getLocale());
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: strings.trayOpen,
        click: showMainWindow
      },
      { type: 'separator' },
      {
        label: strings.trayHide,
        click: () => captureBeforeWindowAction(() => mainWindow?.hide())
      },
      {
        label: strings.trayQuit,
        click: () => captureBeforeWindowAction(() => {
          isQuitting = true;
          app.quit();
        })
      }
    ]));
  };

  refreshMenu();
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function configureMusicView() {
  const contents = musicView.webContents;
  suppressAutomaticPasskeyUi(contents);

  contents.on('dom-ready', async () => {
    try {
      const css = fs.readFileSync(titlebarCssPath, 'utf8');
      await contents.insertCSS(css, { cssOrigin: 'user' });
    } catch (error) {
      console.warn('Unable to inject the title bar styles:', error.message);
    }
  });

  contents.on('did-start-loading', () => {
    if (!musicView?.getVisible()) {
      mainWindow?.webContents.send('splash:state', { status: 'loading' });
    }
  });

  contents.on('did-finish-load', () => {
    if (!musicView?.getVisible()) {
      musicDocumentLoaded = true;
      maybeRevealSplash();
    }
  });

  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) {
      return;
    }

    musicLoadFailed = true;
    clearStartupRevealTimers();
    mainWindow?.webContents.send('splash:state', {
      status: 'error',
      message: `${errorDescription} (${errorCode})`,
      url: validatedUrl
    });
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalPolicyUrl(url)) {
      openInSystemBrowser(url);
      return { action: 'deny' };
    }

    if (isAuthenticationEntryUrl(url)) {
      openAuthWindow(url);
      return { action: 'deny' };
    }

    if (isTrustedAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#030303',
          closable: true,
          frame: true,
          fullscreenable: false,
          icon: iconPath,
          maximizable: true,
          minimizable: true,
          parent: mainWindow,
          title: `${getAppStrings(app.getLocale()).authTitle} - ${APP_NAME}`,
          titleBarStyle: 'default',
          webPreferences: {
            partition: 'persist:youtube-music',
            contextIsolation: true,
            sandbox: true
          }
        }
      };
    }

    openInSystemBrowser(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (childWindow) => {
    childWindow.setMenuBarVisibility(false);
    childWindow.on('closed', showMainWindow);
  });

  contents.on('will-navigate', (event, url) => {
    if (isExternalPolicyUrl(url)) {
      event.preventDefault();
      openInSystemBrowser(url);
      return;
    }

    if (isAuthenticationEntryUrl(url)) {
      event.preventDefault();
      openAuthWindow(url);
      return;
    }

    if (!isTrustedAppUrl(url)) {
      event.preventDefault();
      openInSystemBrowser(url);
    }
  });
}

function installIpcHandlers() {
  ipcMain.on('translation:get-deepl-strings', (event) => {
    if (!deeplConfigWindow || event.sender !== deeplConfigWindow.webContents) {
      event.returnValue = null;
      return;
    }
    let locale = '';
    try {
      locale = new URL(event.sender.getURL()).searchParams.get('locale') || '';
    } catch {}
    event.returnValue = {
      ...getDeepLConfigStrings(locale),
      languageTag: getAppStrings(locale).languageTag
    };
  });
  ipcMain.handle('appearance:get', (event) => {
    if (!musicView || event.sender !== musicView.webContents) {
      throw new Error('Appearance settings are only available to the music view.');
    }
    return getAppearanceSettings();
  });
  ipcMain.handle('appearance:set', (event, patch = {}) => {
    if (!musicView || event.sender !== musicView.webContents) {
      throw new Error('Appearance settings are only available to the music view.');
    }
    const requestedTranslationProvider = normalizeTranslationProvider(
      patch.lyricsTranslationProvider ?? settings.lyrics.translationProvider
    );
    if (patch.lyricsTranslationProvider !== undefined
      && requestedTranslationProvider === 'deepl' && !deeplAuthKey) {
      throw new Error('Configure a DeepL API Free key before selecting DeepL.');
    }

    const nextAppearance = {
      animations: typeof patch.animations === 'boolean'
        ? patch.animations
        : settings.appearance.animations,
      translucentSurfaces: typeof patch.translucentSurfaces === 'boolean'
        ? patch.translucentSurfaces
        : settings.appearance.translucentSurfaces
    };
    const nextLyrics = {
      autoTranslate: nextAutoTranslateEnabled(settings, patch),
      lrclibEnabled: typeof patch.lrclibLyrics === 'boolean'
        ? patch.lrclibLyrics
        : settings.lyrics.lrclibEnabled,
      neteaseEnabled: nextLyricsEnabled(settings, patch),
      neteaseTranslationSource: nextNeteaseTranslationSourceEnabled(settings, patch),
      translationProvider: requestedTranslationProvider
    };
    const previousTranslationProvider = settings.lyrics.translationProvider;
    const previousNeteaseTranslationSource = settings.lyrics.neteaseTranslationSource;
    settings = normalizeSettings({
      ...settings,
      appearance: nextAppearance,
      closeAction: ['ask', 'tray', 'quit'].includes(patch.closeAction)
        ? patch.closeAction
        : settings.closeAction,
      lyrics: nextLyrics
    });
    if (previousTranslationProvider !== settings.lyrics.translationProvider
      || previousNeteaseTranslationSource !== settings.lyrics.neteaseTranslationSource) {
      lyricsTranslationCache.clear();
    }
    writeSettings();
    return getAppearanceSettings();
  });
  ipcMain.handle('translation:open-deepl-config', (event, payload = {}) => {
    if (!musicView || event.sender !== musicView.webContents) {
      throw new Error('DeepL configuration is only available to the music view.');
    }
    return openDeepLConfigWindow(payload.locale);
  });
  ipcMain.handle('translation:deepl-save', async (event, payload = {}) => {
    if (!deeplConfigWindow || event.sender !== deeplConfigWindow.webContents) {
      throw new Error('DeepL credentials are only accepted from the local configuration window.');
    }
    const configContents = event.sender;
    const authKey = normalizeDeepLAuthKey(payload.authKey);
    await validateDeepLAuthKey(authKey);
    if (!deeplConfigWindow || deeplConfigWindow.isDestroyed()
      || configContents !== deeplConfigWindow.webContents) {
      throw new Error('DeepL configuration was closed before validation completed.');
    }
    storeDeepLAuthKey(authKey);
    lyricsTranslationCache.clear();
    return { configured: true };
  });
  ipcMain.on('translation:deepl-close', (event) => {
    if (deeplConfigWindow && event.sender === deeplConfigWindow.webContents) {
      deeplConfigWindow.close();
    }
  });
  ipcMain.handle('lyrics:resolve', (event, payload = {}) => {
    if (!musicView || event.sender !== musicView.webContents) {
      throw new Error('Lyrics lookup is only available to the music view.');
    }
    return lyricsService.resolve(payload.track, {
      forceRefresh: payload.forceRefresh === true,
      neteaseEnabled: settings.lyrics.neteaseEnabled && payload.neteaseEnabled === true,
      syncEnabled: settings.lyrics.lrclibEnabled
    });
  });
  ipcMain.handle('lyrics:translate', (event, payload) => {
    if (!musicView || event.sender !== musicView.webContents) {
      throw new Error('Lyrics translation is only available to the music view.');
    }
    return translateLyricsLines(payload);
  });
  ipcMain.on('desktop-lyrics:update', (event, payload) => {
    if (musicView && event.sender === musicView.webContents) {
      desktopLyricsState = sanitizeDesktopLyricsPayload(payload);
    }
  });
  ipcMain.on('desktop-lyrics:clear', (event) => {
    if (musicView && event.sender === musicView.webContents) {
      desktopLyricsState = null;
    }
  });
  ipcMain.on('music:reload', (event) => {
    if (musicView && event.sender === musicView.webContents
      && !musicView.webContents.isDestroyed()) {
      restartApplication();
    }
  });
  ipcMain.on('music:language-changed', (event) => {
    if (!musicView || event.sender !== musicView.webContents
      || musicView.webContents.isDestroyed()) {
      return;
    }
    restartApplication();
  });
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) {
      return;
    }
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  });
  ipcMain.on('window:close', () => requestCloseDecision());
  ipcMain.on('window:minimize-to-tray', () => captureBeforeWindowAction(() => mainWindow?.hide()));
  ipcMain.on('window:quit', () => captureBeforeWindowAction(() => {
    isQuitting = true;
    app.quit();
  }));
  ipcMain.on('window:get-state', sendWindowState);
  ipcMain.on('context-menu:action', (event, payload = {}) => {
    if (!musicView || event.sender !== musicView.webContents || musicView.webContents.isDestroyed()) {
      return;
    }

    const contents = musicView.webContents;
    switch (payload.action) {
      case 'undo': contents.undo(); break;
      case 'redo': contents.redo(); break;
      case 'cut': contents.cut(); break;
      case 'copy': contents.copy(); break;
      case 'paste': contents.paste(); break;
      case 'select-all': contents.selectAll(); break;
      case 'reload': restartApplication(); break;
      case 'copy-link':
        if (typeof payload.url === 'string') {
          clipboard.writeText(payload.url);
        }
        break;
      case 'open-link':
        if (typeof payload.url === 'string' && /^https?:\/\//i.test(payload.url)) {
          openInSystemBrowser(payload.url);
        }
        break;
      default:
        break;
    }
  });
  ipcMain.on('external:open-policy', (event, url) => {
    if (musicView && event.sender === musicView.webContents && isExternalPolicyUrl(url)) {
      openInSystemBrowser(url);
    }
  });
  ipcMain.on('pwa:ready', (event) => {
    if (!musicView || event.sender !== musicView.webContents || musicView.getVisible()) {
      return;
    }

    musicInterfaceReady = true;
    maybeRevealSplash();
  });
  ipcMain.on('splash:transition-complete', (event) => {
    if (mainWindow && event.sender === mainWindow.webContents) {
      revealMusicView();
    }
  });
  ipcMain.on('splash:retry', loadMusic);
  ipcMain.on('splash:quit', () => {
    isQuitting = true;
    app.quit();
  });
}

function requestCloseDecision() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (settings.closeAction === 'tray') {
    captureBeforeWindowAction(() => mainWindow?.hide());
    return;
  }

  if (settings.closeAction === 'quit') {
    captureBeforeWindowAction(() => {
      isQuitting = true;
      app.quit();
    });
    return;
  }

  if (musicView && !musicView.webContents.isDestroyed() && musicView.getVisible()) {
    musicView.webContents.send('window:request-close');
    return;
  }

  mainWindow.hide();
}

function createMainWindow() {
  settings = readSettings();
  const bounds = getVisibleWindowBounds(settings.windowBounds);

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 880,
    minHeight: 600,
    show: false,
    frame: false,
    thickFrame: true,
    roundedCorners: true,
    backgroundColor: '#030303',
    icon: iconPath,
    webPreferences: {
      preload: splashPreloadPath,
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    loadMusic();
  });

  mainWindow.on('resize', resizeMusicView);
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);
  mainWindow.on('move', () => {
    if (!mainWindow.isMaximized()) {
      settings = { ...settings, windowBounds: mainWindow.getBounds() };
    }
  });
  mainWindow.on('resized', () => {
    if (!mainWindow.isMaximized()) {
      settings = { ...settings, windowBounds: mainWindow.getBounds() };
    }
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    requestCloseDecision();
  });
  mainWindow.on('closed', () => {
    musicView = null;
    mainWindow = null;
  });

  musicView = new WebContentsView({
    webPreferences: {
      preload: musicPreloadPath,
      partition: 'persist:youtube-music',
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  musicView.setBackgroundColor('#000000');
  musicView.setVisible(false);
  mainWindow.contentView.addChildView(musicView);
  configureMusicView();
  resizeMusicView();

  loadSplash();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(async () => {
    app.setName(APP_NAME);
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.muxyang.youtubemusicme');
    }
    loadDeepLAuthKey();
    const musicSession = session.fromPartition('persist:youtube-music');
    electronUserAgent = musicSession.getUserAgent();
    try {
      const preferenceCookies = await musicSession.cookies.get({ name: 'PREF', url: MUSIC_URL });
      youtubeLanguagePreference = parseYouTubeLanguagePreference(
        preferenceCookies.at(-1)?.value
      );
    } catch {
      youtubeLanguagePreference = '';
    }
    installYouTubeLanguageMonitor(musicSession);

    musicSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://accounts.google.com/*'] },
      (details, callback) => {
        details.requestHeaders['User-Agent'] = electronUserAgent;
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    musicSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const trusted = isTrustedAppUrl(webContents.getURL());
      callback(trusted && ['fullscreen', 'media', 'notifications', 'pointerLock'].includes(permission));
    });

    installIpcHandlers();
    createTray();
    createMainWindow();
  });
}

app.on('activate', showMainWindow);
app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(cacheCaptureTimer);
  clearStartupRevealTimers();
  persistWindowSettings();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
