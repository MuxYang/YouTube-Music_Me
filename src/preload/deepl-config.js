'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const strings = ipcRenderer.sendSync('translation:get-deepl-strings');
if (!strings) {
  throw new Error('DeepL configuration translations are unavailable.');
}

contextBridge.exposeInMainWorld('deeplConfig', {
  close: () => ipcRenderer.send('translation:deepl-close'),
  save: (authKey) => ipcRenderer.invoke('translation:deepl-save', { authKey }),
  strings
});
