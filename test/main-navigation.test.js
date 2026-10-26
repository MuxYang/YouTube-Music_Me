'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const mainPath = path.join(__dirname, '..', 'src', 'main.js');
const mainRequire = createRequire(mainPath);

function createApp() {
  const timers = new Map();
  let timerId = 0;
  const states = [];
  const windows = [];
  const externalUrls = [];
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const cookies = new EventEmitter();
  cookies.values = [
    { name: 'SAPISID', domain: '.youtube.com' },
    { name: 'SID', domain: '.youtube.com' }
  ];
  cookies.get = async (filter = {}) => cookies.values.filter((cookie) => (
    !filter.url || new URL(filter.url).hostname.endsWith(cookie.domain.replace(/^\./u, ''))
  ));
  cookies.flushStore = async () => {};

  function createContents() {
    const contents = new EventEmitter();
    Object.assign(contents, {
      session: { cookies },
      url: 'https://music.youtube.com/',
      debugger: { isAttached: () => true, sendCommand: async () => {} },
      isDestroyed: () => false,
      getURL: () => contents.url,
      send: (channel, state) => states.push({ channel, ...state }),
      setUserAgent: () => {},
      setWindowOpenHandler: (handler) => { contents.openWindow = handler; },
      insertCSS: async () => {},
      loadURL: async (url) => { contents.url = url; },
      reloadIgnoringCache: () => { contents.reloaded = true; }
    });
    return contents;
  }

  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = createContents();
      this.destroyed = false;
      windows.push(this);
    }
    setMenuBarVisibility() {}
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    show() {}
    focus() {}
    getContentSize() { return [1280, 800]; }
    loadURL(url) { return this.webContents.loadURL(url); }
    close() { this.destroyed = true; this.emit('closed'); }
  }

  const mainWindow = new BrowserWindow();
  const musicView = {
    visible: false,
    webContents: createContents(),
    getVisible() { return this.visible; },
    setVisible(value) { this.visible = value; },
    setBounds() {}
  };
  const electron = {
    BrowserWindow,
    ipcMain,
    app: {
      commandLine: { appendSwitch() {} },
      requestSingleInstanceLock: () => false,
      quit() {},
      on() {},
      getLocale: () => 'en-US',
      getPath: () => path.join(__dirname, '..', '.test-profile', 'navigation')
    },
    shell: { openExternal: async (url) => externalUrls.push(url) }
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : mainRequire(name),
    __dirname: path.dirname(mainPath),
    process,
    console,
    URL,
    URLSearchParams,
    Buffer,
    AbortController,
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(fs.readFileSync(mainPath, 'utf8'), context, { filename: mainPath });
  context.testMainWindow = mainWindow;
  context.testMusicView = musicView;
  vm.runInContext('mainWindow = testMainWindow; musicView = testMusicView; configureMusicView(); installIpcHandlers();', context);
  return {
    states, windows, externalUrls, musicView, cookies, ipcMain, mainWindow,
    run: (code) => vm.runInContext(code, context),
    async advance(delay) {
      // Run only timers pending at this boundary, including promise continuations.
      for (const [id, timer] of [...timers]) {
        if (timer.delay <= delay && timers.delete(id)) {
          await timer.callback();
        }
      }
    }
  };
}

function navigationEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

test('account sign-out stays in a shared-session auth window', () => {
  const app = createApp();
  const event = navigationEvent();
  app.musicView.webContents.emit('will-navigate', event, 'https://music.youtube.com/logout');
  assert.equal(event.prevented, true);
  assert.equal(app.windows.length, 2);
});

test('authentication redirects cannot replace the music document', () => {
  const app = createApp();
  const event = navigationEvent();
  app.musicView.webContents.emit('will-redirect', event, 'https://accounts.google.com/AddSession', false, true);
  assert.equal(event.prevented, true);
  assert.equal(app.windows.length, 2);
});

test('existing cookies do not close a sign-out window before sign-out finishes', async () => {
  const app = createApp();
  app.run("openAuthWindow('https://accounts.google.com/Logout');");
  const auth = app.windows.at(-1);
  auth.webContents.url = 'https://www.youtube.com/logout';
  auth.webContents.emit('did-finish-load');
  await app.advance(650);
  assert.equal(auth.isDestroyed(), false);
});

test('sign-out finishes without login cookies and refreshes the music view', async () => {
  const app = createApp();
  app.cookies.values = [];
  app.run("openAuthWindow('https://accounts.google.com/Logout');");
  const auth = app.windows.at(-1);
  auth.webContents.url = 'https://music.youtube.com/';
  auth.webContents.emit('did-finish-load');
  await app.advance(650);
  await app.advance(250);
  assert.equal(auth.isDestroyed(), true);
  assert.equal(app.musicView.webContents.url, 'https://music.youtube.com/');
  assert.equal(app.states.some((state) => state.status === 'loading'), true);
});

test('switching accounts preserves the returned authuser selection', async () => {
  const app = createApp();
  app.run("openAuthWindow('https://accounts.google.com/AddSession');");
  const auth = app.windows.at(-1);
  auth.webContents.url = 'https://music.youtube.com/?authuser=1';
  auth.webContents.emit('did-finish-load');
  await app.advance(650);
  await app.advance(250);
  assert.equal(auth.isDestroyed(), true);
  assert.equal(app.musicView.webContents.url, 'https://music.youtube.com/?authuser=1');
  app.musicView.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', auth.webContents.url, true);
  app.ipcMain.emit('splash:retry', { sender: app.mainWindow.webContents });
  assert.equal(app.musicView.webContents.url, 'https://music.youtube.com/?authuser=1');
});

test('loading timeout shows a retry screen instead of revealing an unready page', async () => {
  const app = createApp();
  app.run('loadMusic();');
  await app.advance(30000);
  await app.advance(3200);
  assert.equal(app.musicView.getVisible(), false);
  assert.equal(app.states.at(-1).status, 'error');
});

test('load failure after startup uncovers the local retry screen', () => {
  const app = createApp();
  app.musicView.setVisible(true);
  app.musicView.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://music.youtube.com/', true);
  assert.equal(app.musicView.getVisible(), false);
  assert.equal(app.states.at(-1).status, 'error');
});

test('a stale splash transition cannot reveal a failed document', () => {
  const app = createApp();
  app.run('loadMusic();');
  app.musicView.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://music.youtube.com/', true);
  app.ipcMain.emit('splash:transition-complete', { sender: app.mainWindow.webContents });
  assert.equal(app.musicView.getVisible(), false);
});

test('subframe failures do not replace a working page', () => {
  const app = createApp();
  app.musicView.setVisible(true);
  app.musicView.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/', false);
  assert.equal(app.musicView.getVisible(), true);
});

test('Google-only cookies cannot complete a YouTube account switch', async () => {
  const app = createApp();
  app.cookies.values = [
    { name: 'SAPISID', domain: '.google.com' },
    { name: 'SID', domain: '.google.com' }
  ];
  app.run("openAuthWindow('https://accounts.google.com/AddSession');");
  const auth = app.windows.at(-1);
  auth.webContents.url = 'https://music.youtube.com/?authuser=1';
  auth.webContents.emit('did-finish-load');
  await app.advance(650);
  assert.equal(auth.isDestroyed(), false);
});

test('closing an account window after cookie removal refreshes the signed-out page', async () => {
  const app = createApp();
  app.run("openAuthWindow('https://accounts.google.com/Logout');");
  app.cookies.emit('changed', {}, { name: 'SID', domain: '.youtube.com' }, 'explicit', true);
  app.windows.at(-1).close();
  await app.advance(250);
  assert.equal(app.states.some((state) => state.status === 'loading'), true);
  assert.equal(app.musicView.webContents.url, 'https://music.youtube.com/');
});

test('retry can reveal a ready document after a network failure', () => {
  const app = createApp();
  app.musicView.webContents.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://music.youtube.com/', true);
  app.ipcMain.emit('splash:retry', { sender: app.mainWindow.webContents });
  app.musicView.webContents.emit('did-finish-load');
  app.ipcMain.emit('pwa:ready', { sender: app.musicView.webContents });
  assert.equal(app.states.at(-1).status, 'ready');
  app.ipcMain.emit('splash:transition-complete', { sender: app.mainWindow.webContents });
  assert.equal(app.musicView.getVisible(), true);
});

test('HTTP errors and renderer crashes show the local retry screen', () => {
  for (const [event, args] of [
    ['did-navigate', [{}, 'https://music.youtube.com/', 503]],
    ['render-process-gone', [{}, { reason: 'crashed' }]]
  ]) {
    const app = createApp();
    app.musicView.setVisible(true);
    app.musicView.webContents.emit(event, ...args);
    assert.equal(app.musicView.getVisible(), false);
    assert.equal(app.states.at(-1).status, 'error');
  }
});

test('reloads get their own readiness deadline while in-page navigation keeps working', async () => {
  const app = createApp();
  const contents = app.musicView.webContents;
  app.musicView.setVisible(true);
  contents.emit('did-start-navigation', {}, 'https://music.youtube.com/watch?v=next', true, true);
  assert.equal(app.musicView.getVisible(), true);
  contents.emit('did-start-navigation', {}, 'https://music.youtube.com/', false, true);
  assert.equal(app.musicView.getVisible(), false);
  await app.advance(20000);
  assert.equal(app.states.at(-1).status, 'error');
});

test('offline IPC is sender-checked and splash initialization receives the current error', () => {
  const app = createApp();
  app.musicView.setVisible(true);
  app.ipcMain.emit('pwa:load-failed', { sender: {} });
  assert.equal(app.musicView.getVisible(), true);
  app.ipcMain.emit('pwa:load-failed', { sender: app.musicView.webContents });
  assert.equal(app.musicView.getVisible(), false);
  app.ipcMain.emit('splash:ready', { sender: app.mainWindow.webContents });
  assert.equal(app.states.at(-1).status, 'error');
});

test('opening a policy link keeps the working music view visible', () => {
  const app = createApp();
  app.musicView.setVisible(true);
  app.musicView.webContents.emit('did-start-navigation', {}, 'https://music.youtube.com/t/terms', false, true);
  const event = navigationEvent();
  app.musicView.webContents.emit('will-navigate', event, 'https://music.youtube.com/t/terms');
  assert.equal(event.prevented, true);
  assert.equal(app.musicView.getVisible(), true);
});

test('sign-out also completes on a Google logout landing page after YouTube cookies disappear', async () => {
  const app = createApp();
  app.cookies.values = [];
  app.run("openAuthWindow('https://accounts.google.com/Logout');");
  const auth = app.windows.at(-1);
  auth.webContents.emit('did-finish-load');
  await app.advance(650);
  assert.equal(auth.isDestroyed(), true);
});
