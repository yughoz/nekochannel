'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Kamus UI dikirim sekali saat preload (sendSync) — renderer memilih locale
// dari state.lang tanpa IPC tambahan.
const strings = ipcRenderer.sendSync('nekochannel:i18n');

contextBridge.exposeInMainWorld('neko', {
  strings,
  state: () => ipcRenderer.invoke('nekochannel', 'state'),
  add: channel => ipcRenderer.invoke('nekochannel', 'add', { channel }),
  rename: (id, label) => ipcRenderer.invoke('nekochannel', 'rename', { id, label }),
  setIcon: (id, icon) => ipcRenderer.invoke('nekochannel', 'set-icon', { id, icon }),
  reload: id => ipcRenderer.invoke('nekochannel', 'reload', { id }),
  remove: id => ipcRenderer.invoke('nekochannel', 'remove', { id }),
  reorder: ids => ipcRenderer.invoke('nekochannel', 'reorder', { ids }),
  setActive: id => ipcRenderer.invoke('nekochannel', 'active', { id }),
  agentDock: () => ipcRenderer.invoke('nekochannel', 'agent-dock'),
  openSettings: () => ipcRenderer.invoke('nekochannel', 'open-settings'),
  getSettings: () => ipcRenderer.invoke('nekochannel', 'settings-get'),
  saveSettings: patch => ipcRenderer.invoke('nekochannel', 'settings-set', patch),
  onState: fn => ipcRenderer.on('nekochannel:state', (_e, s) => fn(s)),
  onSwitcher: fn => ipcRenderer.on('nekochannel:switcher', () => fn()), // #14 Ctrl+K dari view lain
  getAction: () => ipcRenderer.invoke('nekochannel', 'action-get'), // M6 tab Action
  onAction: fn => ipcRenderer.on('nekochannel:action', (_e, ev) => fn(ev)),
  setActionMaster: on => ipcRenderer.invoke('nekochannel', 'action-master', { on }),
});
