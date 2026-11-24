'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Kamus UI dikirim sekali saat preload (sendSync) — renderer memilih locale
// dari state.lang tanpa IPC tambahan.
const strings = ipcRenderer.sendSync('nekochannel:i18n');
let sentryEnabled = false;
try { sentryEnabled = ipcRenderer.sendSync('nekochannel:sentry-flag') === true; } catch {}
if (sentryEnabled) {
  try {
    if (!window.__SENTRY_IPC__) {
      const api = {
        sendRendererStart: () => ipcRenderer.send('sentry-electron.renderer-start'),
        sendScope: body => ipcRenderer.send('sentry-electron.scope', body),
        sendEnvelope: body => ipcRenderer.send('sentry-electron.envelope', body),
        sendStatus: status => ipcRenderer.send('sentry-electron.status', status),
        sendStructuredLog: log => ipcRenderer.send('sentry-electron.structured-log', log),
      };
      window.__SENTRY_IPC__ = api;
      try { contextBridge.exposeInMainWorld('__SENTRY_IPC__', api); } catch {}
    }
    require('@sentry/electron/renderer').init();
  } catch {}
}

contextBridge.exposeInMainWorld('neko', {
  waAction: args => ipcRenderer.invoke('nekochannel', 'wa-action', args),
  readerBackfill: (id, action) => ipcRenderer.invoke('nekochannel', 'reader-backfill', { id, action }),
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
  sidebarToggle: () => ipcRenderer.invoke('nekochannel', 'sidebar-toggle'), // #18
  accountMenu: id => ipcRenderer.send('nekochannel:account-menu', id), // #23b: native menu > WebContentsView
  openSettings: () => ipcRenderer.invoke('nekochannel', 'open-settings'),
  getSettings: () => ipcRenderer.invoke('nekochannel', 'settings-get'),
  saveSettings: patch => ipcRenderer.invoke('nekochannel', 'settings-set', patch),
  aipackStatus: () => ipcRenderer.invoke('nekochannel', 'aipack-status'),
  aipackLogin: () => ipcRenderer.invoke('nekochannel', 'aipack-login'),
  aipackLogout: () => ipcRenderer.invoke('nekochannel', 'aipack-logout'),
  testWebhook: () => ipcRenderer.invoke('nekochannel', 'webhook-test'),
  copyMcpKey: () => ipcRenderer.invoke('nekochannel', 'mcp-copy-key'),
  onState: fn => ipcRenderer.on('nekochannel:state', (_e, s) => fn(s)),
  onSwitcher: fn => ipcRenderer.on('nekochannel:switcher', () => fn()), // #14 Ctrl+K dari view lain
  onBackfill: fn => ipcRenderer.on('nekochannel:backfill', (_e, data) => fn(data)), // progress backfill live (Settings)
  runSchedule: id => ipcRenderer.invoke('nekochannel', 'schedule-run', { id }), // #31 Jadwal Agent (Settings saja)
  onSchedule: fn => ipcRenderer.on('nekochannel:schedule', (_e, data) => fn(data)),
  onAccountMenu: fn => ipcRenderer.on('nekochannel:account-action', (_e, action) => fn(action)),
});
