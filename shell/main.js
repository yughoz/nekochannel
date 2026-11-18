'use strict';
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const registry = require('../adapters');
const { makeDriver, normalizeAccount } = require('../adapters/whatsapp/driver');
const store = require('./accounts');

app.setName('nekochannel');
app.setPath('userData', path.join(app.getPath('appData'), 'nekochannel'));

const endpoint = process.env.NEKOCHANNEL_SERVER || 'http://127.0.0.1:4317';
const SIDEBAR_W = 232;
const PROBE_MS = 30000; // PRD: status probe ringan sekali per 30s per akun
const file = () => path.join(app.getPath('userData'), 'accounts.json');

let win, driver;
const accounts = []; // live: { channel, n, label, id, view, wc, injected, account, status }
let activeId = null;
let serverOk = false;

const snapshot = () => ({
  accounts: accounts.map(({ id, channel, n, label, account, status }) => ({ id, channel, n, label, account: account || null, status })),
  activeId,
  server: { ok: serverOk, endpoint },
});
const broadcast = () => { if (win && !win.isDestroyed()) win.webContents.send('nekochannel:state', snapshot()); };

function contentBounds() {
  const b = win.contentView.getBounds();
  return { x: SIDEBAR_W, y: 0, width: Math.max(1, b.width - SIDEBAR_W), height: Math.max(1, b.height) };
}

// All views stay attached & live (capture runs for every account simultaneously,
// backgroundThrottling:false); only the active one is visible/on top.
function setActive(id) {
  activeId = id;
  for (const a of accounts) {
    if (a.id === id) {
      win.contentView.removeChildView(a.view); // re-add = raise to top
      win.contentView.addChildView(a.view);
      a.view.setBounds(contentBounds());
      a.view.setVisible(true);
    } else {
      a.view.setVisible(false);
    }
  }
  broadcast();
}

function readerStatus(a, payload) {
  const account = normalizeAccount(payload.account);
  if (account) {
    a.account = account;
    driver.setLabel(account, a.label);
  }
  const state = payload.connected ? 'connected' : account ? 'reconnecting' : 'qr';
  a.status = { state, detail: payload.detail || '', at: new Date().toISOString() };
  broadcast();
}

function spawn(rec) {
  const adapterMod = require(`../adapters/${rec.channel}/adapter`); // builder per channel; descriptor (registry) holds url/partition/UA/status
  const a = { ...rec, account: null, status: { state: 'loading', detail: 'memuat…', at: new Date().toISOString() } };
  Object.assign(a, adapterMod.createAccountView({
    index: rec.n,
    label: rec.label,
    driver,
    log: m => console.log(`[${a.id}] ${m}`),
    onStatus: p => readerStatus(a, p),
  }));
  accounts.push(a);
  win.contentView.addChildView(a.view);
  a.view.setBounds(contentBounds());
  return a;
}

// Refine pre-login states (loading/qr) with the light DOM probe + server health.
// Reader-derived states (connected/reconnecting) always win.
function startWatch() {
  const tick = async () => {
    for (const a of accounts) {
      if (a.status.state === 'connected' || a.status.state === 'reconnecting') continue;
      try {
        const probe = await registry[a.channel].status(a.wc);
        const map = { chat: ['connected', 'chat list terdeteksi'], qr: ['qr', 'menunggu scan QR'], loading: ['loading', 'memuat halaman…'] };
        const [state, detail] = map[probe] || ['error', `probe: ${probe}`];
        a.status = { state, detail, at: new Date().toISOString() };
      } catch (error) {
        a.status = { state: 'error', detail: String(error.message || error).slice(0, 120), at: new Date().toISOString() };
      }
    }
    try {
      const h = await (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) })).json();
      serverOk = Boolean(h.ok);
    } catch { serverOk = false; }
    broadcast();
  };
  tick().catch(() => {}); // first tick at boot — dots resolve immediately
  setInterval(() => { tick().catch(() => {}); }, PROBE_MS);
}

ipcMain.handle('nekochannel', (_e, cmd, arg) => {
  if (cmd === 'add') {
    const channel = arg && registry[arg.channel] ? arg.channel : 'whatsapp';
    const plain = accounts.map(({ channel: c, n, label }) => ({ channel: c, n, label }));
    setActive(spawn(store.add(file(), plain, channel, registry[channel].short)).id);
  } else if (cmd === 'rename') {
    const a = accounts.find(x => x.id === arg?.id);
    const label = String(arg?.label || '').trim().slice(0, 80);
    if (a && label) {
      a.label = label;
      a.setLabel(label);
      if (a.account) driver.setLabel(a.account, label);
      store.save(file(), accounts.map(({ channel, n, label }) => ({ channel, n, label })));
    }
  } else if (cmd === 'active') {
    if (arg?.id === 'agent' || accounts.some(x => x.id === arg?.id)) setActive(arg.id);
  } else {
    return { error: `unknown cmd: ${cmd}` };
  }
  return snapshot();
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280, height: 860, title: 'Nekochannel', backgroundColor: '#111b21',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  driver = makeDriver({ queueDir: path.join(app.getPath('userData'), 'queue'), endpoint, log: m => console.log(`[queue] ${m}`) });
  let recs = store.load(file());
  if (!recs.length) recs = [store.add(file(), [], 'whatsapp', registry.whatsapp.short)]; // first run: seed wa-1
  for (const rec of recs) spawn(rec);
  setActive(accounts[0].id);
  win.on('resize', () => { if (activeId) { const b = contentBounds(); for (const a of accounts) if (a.id === activeId) a.view.setBounds(b); } });
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); });
  startWatch();
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts, driver, endpoint);
});

app.on('window-all-closed', () => { driver?.dispose(); app.quit(); });
