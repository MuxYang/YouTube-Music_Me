'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startup', {
  onState: (callback) => ipcRenderer.on('splash:state', (_event, state) => callback(state)),
  quit: () => ipcRenderer.send('splash:quit'),
  retry: () => ipcRenderer.send('splash:retry'),
  transitionComplete: () => ipcRenderer.send('splash:transition-complete')
});
