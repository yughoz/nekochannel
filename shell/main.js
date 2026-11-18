'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, Notification } = require('electron');
const registry = require('../adapters');
const { makeDriver, normalizeAccount } = require('../adapters/whatsapp/driver');
const store = require('./accounts');
const buildNotif = require('./notify');
const { createAgentView } = require('./agent');

app.setName('nekochannel');
app.setPath('userData', path.join(app.getPath('appData'), 'nekochannel'));

const endpoint = process.env.NEKOCHANNEL_SERVER || 'http://127.0.0.1:4317';
const SIDEBAR_W = 232;
const PROBE_MS = 30000; // PRD: status probe ringan sekali per 30s per akun
const file = () => path.join(app.getPath('userData'), 'accounts.json');

let win, driver, agent, tray;
let quitting = false;
const accounts = []; // live: { channel, n, label, id, view, wc, injected, account, status }
let activeId = null;
let serverOk = false;
const icon = () => nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
// Electron's setLoginItemSettings is a silent no-op on Linux (probed on 45.3.4) —
// write the XDG autostart entry ourselves there; native API stays for mac/win.
// ponytail: Exec/Icon pakai path absolut dev+APPIMAGE; kalau rilis packaged Linux
// nanti butuh desktop-integration rapi (icon ter-install), serahkan ke AppImageLauncher.
const autostartFile = () => path.join(app.getPath('appData'), 'autostart', `${app.getName()}.desktop`);
const autostartOn = () => process.platform === 'linux' ? fs.existsSync(autostartFile()) : app.getLoginItemSettings().openAtLogin;
function setAutostart(on) {
  if (process.platform !== 'linux') return void app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return void (fs.existsSync(autostartFile()) && fs.rmSync(autostartFile()));
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const exec = app.isPackaged ? (process.env.APPIMAGE || process.execPath) : `${process.execPath} ${app.getAppPath()}`;
  fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
  fs.writeFileSync(autostartFile(), [
    '[Desktop Entry]', 'Type=Application', 'Version=1.0', `Name=${app.getName()}`,
    'Comment=Channel hub — capture tetap jalan di tray', `Exec="${exec.replace(/"/g, '\\"')}"`,
    fs.existsSync(iconPath) ? `Icon=${iconPath}` : null, 'Terminal=false',
    'Categories=Network;InstantMessaging;', 'X-GNOME-Autostart-enabled=true', '',
  ].filter(l => l !== null).join('\n'));
}

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
  if (id === 'agent') {
    win.contentView.removeChildView(agent.view); // raise to top
    win.contentView.addChildView(agent.view);
    agent.view.setBounds(contentBounds());
    agent.view.setVisible(true);
  } else {
    agent.view.setVisible(false);
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

// #9 desktop notification for live incoming messages (backfill deliberately silent).
// Suppressed while the window is focused — user is looking at the chats anyway.
function showNotif(account, items) {
  if (!Notification.isSupported() || (win && !win.isDestroyed() && win.isFocused())) return;
  const rec = accounts.find(x => x.account === account);
  const n = buildNotif(items, rec?.label);
  if (!n) return;
  const notif = new Notification({ title: n.title, body: n.body, icon: icon() });
  notif.on('click', () => {
    if (!win || win.isDestroyed()) return;
    win.show(); win.focus();
    const a = accounts.find(x => x.account === account);
    if (a) setActive(a.id);
  });
  notif.show();
  console.log('[notif] desktop notification requested'); // never log private message previews
  notif.on('failed', (_event, error) => console.error('[notif] delivery failed:', error));
  notif.on('show', () => console.log('[notif] desktop notification shown'));
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
    broadcast();
  };
  tick().catch(() => {}); // first tick at boot — dots resolve immediately
  setInterval(() => { tick().catch(() => {}); }, PROBE_MS);
  // Server health poll on its own 60s cadence (PRD M2); probe stays 30s.
  const healthTick = async () => {
    try {
      const h = await (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) })).json();
      serverOk = Boolean(h.ok);
    } catch { serverOk = false; }
    broadcast();
  };
  healthTick().catch(() => {});
  setInterval(() => { healthTick().catch(() => {}); }, 60000);
}

ipcMain.handle('nekochannel', (_e, cmd, arg) => {
  if (!win || _e.sender !== win.webContents) return { error: 'untrusted sender' };
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
      broadcast(); // langsung, jangan tunggu probe 30s
    }
  } else if (cmd === 'reorder' && Array.isArray(arg?.ids)) {
    const byId = new Map(accounts.map(a => [a.id, a]));
    const next = arg.ids.map(id => byId.get(id)).filter(Boolean); // id asing/duplikat → panjang beda → ditolak
    if (next.length === accounts.length) {
      accounts.splice(0, accounts.length, ...next);
      store.save(file(), accounts.map(({ channel, n, label }) => ({ channel, n, label })));
      broadcast();
    }
  } else if (cmd === 'reload') {
    accounts.find(x => x.id === arg?.id)?.wc.reload();
  } else if (cmd === 'remove') {
    const i = accounts.findIndex(x => x.id === arg?.id);
    if (i >= 0) {
      const [a] = accounts.splice(i, 1);
      win.contentView.removeChildView(a.view);
      a.dispose();
      store.save(file(), accounts.map(({ channel, n, label }) => ({ channel, n, label })));
      if (activeId === a.id) setActive(accounts[0]?.id || 'agent'); else broadcast();
    }
    // ponytail: view dibuang via removeChildView + drop ref (GC yang reclaim);
    // partisi & queue file sengaja disisakan — re-add dengan n yang sama langsung
    // reconnect sesi lama tanpa QR. Tambah opsi "hapus sesi" kalau pernah diminta.
  } else if (cmd === 'active') {
    if (arg?.id === 'agent' || accounts.some(x => x.id === arg?.id)) setActive(arg.id);
  } else if (cmd !== 'state') {
    return { error: `unknown cmd: ${cmd}` };
  }
  return snapshot();
});

app.whenReady().then(() => {
  setAutostart(true); // PRD M4: autostart saat login (checkbox di tray untuk matikan)
  win = new BrowserWindow({
    width: 1280, height: 860, title: 'Nekochannel', icon: icon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111b21' : '#f0f2f5',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // Tutup window = sembunyi ke tray; semua view tetap live (backgroundThrottling:false)
  // (renderer window.close() merusak tanpa event close — jalur X titlebar/Alt+F4 aman)
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  tray = new Tray(icon().resize({ width: 22, height: 22 }));
  tray.setToolTip('Nekochannel');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Tampilkan', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: 'Autostart', type: 'checkbox', checked: autostartOn(),
      click: i => setAutostart(i.checked) },
    { label: 'Tema', submenu: [['system', 'Ikuti sistem'], ['light', 'Terang'], ['dark', 'Gelap']].map(([v, label]) => ({
      label, type: 'radio', checked: nativeTheme.themeSource === v,
      click: () => { nativeTheme.themeSource = v; },
    })) },
    { type: 'separator' },
    { label: 'Keluar', click: () => { quitting = true; app.quit(); } },
  ]));
  app.on('before-quit', () => { quitting = true; });
  agent = createAgentView({ log: m => console.log(`[agent] ${m}`) });
  agent.start();
  driver = makeDriver({
    queueDir: path.join(app.getPath('userData'), 'queue'),
    stateFile: path.join(app.getPath('userData'), 'state.json'),
    endpoint,
    log: m => console.log(`[queue] ${m}`),
    // Auto-backfill pasca offline: driver memutuskan, adapter menyalurkan
    // perintah start ke view milik akun tersebut (page engine yang jalan).
    onAutoBackfill: (account, progress) => {
      const a = accounts.find(x => x.account === account);
      if (a) a.wc.send('reader-command', { type: 'backfill-command', action: 'start', progress });
      else console.log(`[backfill] no live view for ${account}; resume saat view reconnect`);
    },
    // #9: notif desktop per batch pesan live yang baru masuk antrean
    onMessages: showNotif,
  });
  let recs = store.load(file());
  if (!recs.length) recs = [store.add(file(), [], 'whatsapp', registry.whatsapp.short)]; // first run: seed wa-1
  for (const rec of recs) spawn(rec);
  setActive(accounts[0].id);
  win.on('resize', () => { if (activeId) { const b = contentBounds(); for (const a of accounts) if (a.id === activeId) a.view.setBounds(b); if (activeId === 'agent') agent.view.setBounds(b); } });
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); agent.dispose(); });
  startWatch();
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts, driver, endpoint);
});

app.on('window-all-closed', () => { driver?.dispose(); app.quit(); });
