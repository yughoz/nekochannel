'use strict';
// WhatsApp adapter: one account = one WebContentsView with its own persistent
// session partition, full-Chrome UA, injected reader, IPC → shared driver wiring.
// The driver lives in the main process (one instance for all accounts — the queue
// is keyed per phone account, not per view). Channel behavior comes from the
// adapter descriptor (adapters/index.js registry).
const path = require('node:path');
const electron = require('electron');
const { WebContentsView, session, ipcMain } = electron;
const adapter = require('../index').whatsapp;
const owners = new Map(); // channel capture → token view pemilik handler aktif (#57)

function createAccountView({ index, label = '', driver, onStatus, log = console.log, url = adapter.url }) {
  const id = `${adapter.name}-${index}`;
  const channel = `capture:${id}`;
  const partition = adapter.partition(index);
  session.fromPartition(partition).setUserAgent(adapter.userAgent(process.versions.chrome));

  // #57: view lama (akun dihapus lalu ditambah lagi) bisa belum hancur → ganti handler-nya.
  const token = Symbol(channel);
  let disposed = false;
  ipcMain.removeHandler(channel);
  owners.set(channel, token);
  ipcMain.handle(channel, (event, payload) => {
    if (disposed) return { stored: false, error: 'disposed' }; // kiriman telat saat shutdown: diam, bukan error
    if (event.sender !== view.webContents || event.senderFrame !== view.webContents.mainFrame) return { stored: false, error: 'untrusted sender' };
    const result = driver.handle(payload);
    if (driver.isEnabled() && payload && payload.type === 'wa-status' && payload.account) {
      driver.setLabel(payload.account, label); // PRD: label akun dikirim ke /ingest
      if (onStatus) onStatus(payload);
    }
    return result;
  });

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'bridge.js'),
      additionalArguments: [`--capture-channel=${channel}`], // bridge derives its IPC channel from argv
      sandbox: false, // bridge requires vendor/normalize.js — full require, contextIsolation stays on
      backgroundThrottling: false, // capture must run for hidden views too (M1: ALL accounts live)
    },
  });

  let injectedResolve;
  const injected = new Promise(resolve => { injectedResolve = resolve; });
  view.webContents.loadURL(url);
  view.webContents.on('dom-ready', async () => {
    try {
      await adapter.inject(view.webContents, driver.isEnabled());
      view.webContents.send('reader-command', { type: 'reader-control', enabled: driver.isEnabled() });
      log('reader injected');
      injectedResolve(true);
    } catch (error) {
      log(`injection failed: ${error.message}`);
      injectedResolve(false);
    }
  });
  view.webContents.on('did-fail-load', (_e, code, desc) => log(`load failed: ${code} ${desc}`));
  view.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason}`));

  return {
    id, view, wc: view.webContents, injected,
    setLabel: value => { label = String(value || ''); },
    // #57: tutup halaman WA dulu (bridge berhenti kirim capture + view tidak bocor), lepas handler
    // setelah webContents benar-benar hancur — sebelumnya handler dilepas duluan → kiriman telat
    // memicu "No handler registered for 'capture:…'". Partisi/sesi WA di disk tidak tersentuh.
    dispose: () => {
      disposed = true;
      const release = () => { if (owners.get(channel) === token) { owners.delete(channel); ipcMain.removeHandler(channel); } };
      const wc = view.webContents;
      if (wc.isDestroyed()) return release();
      wc.once('destroyed', release);
      try { wc.close(); } catch { release(); }
    },
  };
}

module.exports = { createAccountView };
