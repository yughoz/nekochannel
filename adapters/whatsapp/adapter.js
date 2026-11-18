'use strict';
// WhatsApp adapter: one account = one WebContentsView with its own persistent
// session partition, full-Chrome UA, injected reader, IPC → driver wiring.
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { WebContentsView, session, ipcMain, app } = electron;
const { makeDriver } = require('./driver');

const chromeUA = () => {
  const platform = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64';
  // Drop the "Electron" token: WA Web treats the Electron UA differently.
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
};

const VENDOR = path.join(__dirname, 'vendor');

function createAccountView({ window, index, serverEndpoint, log = console.log }) {
  const id = `whatsapp-${index}`;
  const channel = `capture:${id}`;
  const partition = `persist:${id}`;
  session.fromPartition(partition).setUserAgent(chromeUA());

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
  view.webContents.loadURL('https://web.whatsapp.com/');
  view.webContents.on('dom-ready', async () => {
    try {
      await view.webContents.executeJavaScript(fs.readFileSync(path.join(VENDOR, 'page-main.bundle.js'), 'utf8'), true);
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
