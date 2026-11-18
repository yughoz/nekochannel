'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neko', {
  state: () => ipcRenderer.invoke('nekochannel', 'state'),
  add: channel => ipcRenderer.invoke('nekochannel', 'add', { channel }),
  rename: (id, label) => ipcRenderer.invoke('nekochannel', 'rename', { id, label }),
  reload: id => ipcRenderer.invoke('nekochannel', 'reload', { id }),
  remove: id => ipcRenderer.invoke('nekochannel', 'remove', { id }),
  setActive: id => ipcRenderer.invoke('nekochannel', 'active', { id }),
  onState: fn => ipcRenderer.on('nekochannel:state', (_e, s) => fn(s)),
});
