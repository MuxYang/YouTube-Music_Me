'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { getAppStrings } = require('../i18n');

contextBridge.exposeInMainWorld('startup', {
  onState: (callback) => ipcRenderer.on('splash:state', (_event, state) => callback(state)),
  quit: () => ipcRenderer.send('splash:quit'),
  retry: () => ipcRenderer.send('splash:retry'),
  strings: getAppStrings(globalThis.navigator?.language || process.env.LANG),
  transitionComplete: () => ipcRenderer.send('splash:transition-complete')
});
