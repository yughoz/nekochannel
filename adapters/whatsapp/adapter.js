'use strict';
// WhatsApp adapter: one account = one WebContentsView with its own persistent
// session partition, full-Chrome UA, injected reader, IPC → driver wiring.
// Channel behavior comes from the adapter descriptor (adapters/index.js registry).
const path = require('node:path');
const electron = require('electron');
const { WebContentsView, session, ipcMain, app } = electron;
const { makeDriver } = require('./driver');
const adapter = require('../index').whatsapp;

const VENDOR = path.join(__dirname, 'vendor');

function createAccountView({ index, serverEndpoint, log = console.log }) {
  const id = `${adapter.name}-${index}`;
  const channel = `capture:${id}`;
  const partition = adapter.partition(index);
  session.fromPartition(partition).setUserAgent(adapter.userAgent(process.versions.chrome));

  const driver = makeDriver({ queueDir: path.join(app.getPath('userData'), 'queue'), endpoint: serverEndpoint, log: m => log(`[${id}] ${m}`) });
  ipcMain.handle(channel, (event, payload) => {
    if (event.sender !== view.webContents) return { stored: false, error: 'untrusted sender' };
    return driver.handle(payload);
  });

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'bridge.js'),
      additionalArguments: [`--capture-channel=${channel}`], // bridge derives its IPC channel from argv
      sandbox: false, // bridge requires vendor/normalize.js — full require, contextIsolation stays on
      backgroundThrottling: false, // capture must run for hidden views too
    },
  });

  let injectedResolve;
  const injected = new Promise(resolve => { injectedResolve = resolve; });
  view.webContents.loadURL(adapter.url);
  view.webContents.on('dom-ready', async () => {
    try {
      await adapter.inject(view.webContents);
      log(`[${id}] reader injected`);
      injectedResolve(true);
    } catch (error) {
      log(`[${id}] injection failed: ${error.message}`);
      injectedResolve(false);
    }
  });
  view.webContents.on('did-fail-load', (_e, code, desc) => log(`[${id}] load failed: ${code} ${desc}`));
  view.webContents.on('render-process-gone', (_e, details) => log(`[${id}] renderer gone: ${details.reason}`));

  return { id, view, wc: view.webContents, driver, injected, dispose: () => { driver.dispose(); ipcMain.removeHandler(channel); } };
}

module.exports = { createAccountView };
