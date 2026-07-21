'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const strings = ipcRenderer.sendSync('translation:get-azure-strings');
if (!strings) {
  throw new Error('Azure Translator configuration translations are unavailable.');
}

contextBridge.exposeInMainWorld('azureConfig', {
  close: () => ipcRenderer.send('translation:azure-close'),
  save: (config) => ipcRenderer.invoke('translation:azure-save', config),
  strings
});
