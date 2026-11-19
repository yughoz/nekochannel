'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lock', {
  unlock: password => ipcRenderer.invoke('privacy:unlock', password),
  onStrings: callback => ipcRenderer.on('lock:strings', (_event, strings) => callback(strings)),
});
