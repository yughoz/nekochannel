'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, Notification, shell } = require('electron');
const registry = require('../adapters');
const { makeDriver, normalizeAccount } = require('../adapters/whatsapp/driver');
const store = require('./accounts');
const settingsStore = require('./settings');
const { STR, t } = require('./i18n');
const buildNotif = require('./notify');
const { createAgentView, splitBounds, AGENT_URL } = require('./agent');

app.setName('nekochannel');
app.setPath('userData', path.join(app.getPath('appData'), 'nekochannel'));

// #13: satu instance per userData — yang kedua keluar diam-diam, event di
// instance pertama menampilkan + memfokuskan window (tanpa dobel capture).
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => {
  console.log('[instance] second instance → show + focus existing window');
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const settings = settingsStore.load(app.getPath('userData'));
// ponytail: lokasi checkout wa-reader ikut konvensi dev lokal; override lewat env
// (dipakai E2E terisolasi). Kalau nanti dipackaging beneran, jadikan field setting.
const WAREADER_ENV = process.env.NEKOCHANNEL_WAREADER_ENV || path.join(app.getPath('home'), 'Projects', 'wa-reader', '.env');
const repoRaw = require('../package.json').repository || '';
const REPO = repoRaw.startsWith('github:') ? `https://github.com/${repoRaw.slice('github:'.length)}` : repoRaw;

// Renderer tepercaya: window utama + jendela settings (didata saat dibuat).
const senders = new Set();
const trusted = wc => senders.has(wc) && !wc.isDestroyed();

// Kamus UI untuk preload (sendSync sekali saat load renderer).
ipcMain.on('nekochannel:i18n', e => { if (trusted(e.sender)) e.returnValue = { id: STR.id, en: STR.en }; });

const endpoint = process.env.NEKOCHANNEL_SERVER || 'http://127.0.0.1:4317';
const SIDEBAR_W = 232;
const PROBE_MS = 30000; // PRD: status probe ringan sekali per 30s per akun
const file = () => path.join(app.getPath('userData'), 'accounts.json');

let win, driver, agent, tray, settingsWin;
let quitting = false;
const accounts = []; // live: { channel, n, label, id, view, wc, injected, account, status }
let activeId = null;
let agentDock = !!settings.agentDock; // #11: chat agent dock kanan (persist)
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

// icon: field opsional (#15) — undefined di JSON = akun tanpa icon (default inisial).
const persistList = () => accounts.map(({ channel, n, label, icon }) => ({ channel, n, label, icon }));
const snapshot = () => ({
  accounts: accounts.map(({ id, channel, n, label, icon, account, status }) => ({ id, channel, n, label, icon, account: account || null, status })),
  activeId,
  agentDock,
  server: { ok: serverOk, endpoint },
  lang: settings.lang,
  notif: settings.notif,
});
const broadcast = () => { if (win && !win.isDestroyed()) win.webContents.send('nekochannel:state', snapshot()); };

// #14 quick switcher: Ctrl+K. Sinyal focus/intercept level browser SEMUANYA mati
// untuk WebContentsView di XWayland ini (diuji E2E: before-input-event gak fire
// untuk key real/CDP, globalShortcut X11 grab flaky, menu accelerator gak fire,
// isFocused()/blur jadi false palsu pas klik ke view). Yang reliable: keydown DOM
// di dalam halaman — jadi tiap view di-inject hook kecil yang nandaai lewat
// console, main tangkap via console-message (bukan capture path, nol preload).
const SW_MARK = '__neko_switcher__';
const SW_HOOK = `(() => {
  if (window.__nekoSwHook) return;
  window.__nekoSwHook = true;
  addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault(); console.log('${SW_MARK}');
    }
  }, true);
})()`;
const injectSwitcherKey = wc => wc.executeJavaScript(SW_HOOK, true).catch(() => {});
const hookSwitcher = wc => {
  wc.on('console-message', (_e, _level, message) => {
    if (message === SW_MARK) openSwitcher();
  });
  wc.on('dom-ready', () => injectSwitcherKey(wc));
  injectSwitcherKey(wc);
};
const openSwitcher = () => {
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  win.webContents.focus(); // #14: paksa fokus Chromium balik ke shell (dari view) sebelum renderer fokus-in input
  win.webContents.send('nekochannel:switcher');
};

// #12 auto-recovery renderer crash: tandai error di sidebar, reload dengan
// backoff 1s→30s (berlipat tiap crash beruntun; counter reset kalau halaman
// stabil ≥30s pasca load — crash loop tidak jadi churn CPU). Bridge reader &
// hook Ctrl+K re-inject sendiri via dom-ready; antrean aman karena tersimpan
// di main process, bukan di renderer yang mati.
const hookRecovery = a => {
  let fails = 0, stable = null;
  a.wc.on('render-process-gone', (_e, d) => {
    if (quitting || !accounts.includes(a)) return;
    clearTimeout(stable);
    const wait = Math.min(1000 * 2 ** fails++, 30000);
    console.log(`[${a.id}] renderer gone (${d.reason}); reload dalam ${wait}ms`);
    a.status = { state: 'error', detail: `renderer crash: ${d.reason}`, at: new Date().toISOString() };
    broadcast();
    setTimeout(() => { if (!quitting && accounts.includes(a)) a.wc.reload(); }, wait);
  });
  a.wc.on('did-finish-load', () => {
    clearTimeout(stable);
    stable = setTimeout(() => { fails = 0; }, 30000);
  });
};

// Bounds per mode: dock → kiri akun + kanan agent; sisanya satu panel penuh.
function panes() {
  const b = win.contentView.getBounds();
  return { ...splitBounds(b.width, b.height, SIDEBAR_W), dock: agentDock && accounts.length > 0 && activeId !== 'agent' };
}

// All views stay attached & live (capture runs for every account simultaneously,
// backgroundThrottling:false); only the active one is visible/on top.
function setActive(id) {
  activeId = id;
  const p = panes();
  for (const a of accounts) {
    if (a.id === id) {
      win.contentView.removeChildView(a.view); // re-add = raise to top
      win.contentView.addChildView(a.view);
      a.view.setBounds(p.dock ? p.left : p.full);
      a.view.setVisible(true);
    } else {
      a.view.setVisible(false);
    }
  }
  if (p.dock || id === 'agent') {
    win.contentView.removeChildView(agent.view); // raise to top
    win.contentView.addChildView(agent.view);
    agent.view.setBounds(p.dock ? p.right : p.full);
    agent.view.setVisible(true);
  } else {
    agent.view.setVisible(false);
  }
  broadcast();
  // #14: fokus keyboard ikut ke view aktif — abis switch user langsung ngetik di
  // akun tsb, dan Ctrl+K berikutnya nangkep lewat hook halaman (hookSwitcher).
  if (id === 'agent') agent.wc.focus();
  else accounts.find(x => x.id === id)?.wc.focus();
}

// #11: toggle dock kanan — kiri harus akun, jadi kalau lagi tab Agent penuh,
// pindah ke akun pertama; tanpa akun sama sekali dock jatuh ke tab penuh.
function setAgentDock(on) {
  agentDock = !!on;
  settings.agentDock = agentDock;
  settingsStore.save(app.getPath('userData'), settings);
  if (agentDock && !accounts.some(x => x.id === activeId)) return setActive(accounts[0]?.id || 'agent');
  setActive(activeId);
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
  if (!settings.notif) return; // #10: toggle disable notif di menu Settings
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
  const a = { ...rec, account: null, status: { state: 'loading', detail: t(settings.lang, 'stLoading'), at: new Date().toISOString() } };
  Object.assign(a, adapterMod.createAccountView({
    index: rec.n,
    label: rec.label,
    driver,
    log: m => console.log(`[${a.id}] ${m}`),
    onStatus: p => readerStatus(a, p),
  }));
  hookSwitcher(a.wc); // #14: Ctrl+K dari dalam halaman
  hookRecovery(a); // #12: pulih sendiri kalau renderer-nya crash
  accounts.push(a);
  win.contentView.addChildView(a.view);
  a.view.setBounds(panes().full);
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
        const map = { chat: ['connected', t(settings.lang, 'stChat')], qr: ['qr', t(settings.lang, 'stQr')], loading: ['loading', t(settings.lang, 'stLoadingPage')] };
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

// ---- #10: menu Settings ----------------------------------------------------
function buildTray() {
  if (!tray) return;
  const s = k => t(settings.lang, k);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s('trayShow'), click: () => { win.show(); win.focus(); } },
    { label: s('traySettings'), click: () => openSettings() },
    { type: 'separator' },
    { label: 'Autostart', type: 'checkbox', checked: autostartOn(),
      click: i => setAutostart(i.checked) },
    { label: s('trayTheme'), submenu: [['system', s('trayThemeSys')], ['light', s('trayLight')], ['dark', s('trayDark')]].map(([v, label]) => ({
      label, type: 'radio', checked: nativeTheme.themeSource === v,
      click: () => { nativeTheme.themeSource = v; },
    })) },
    { type: 'separator' },
    { label: s('trayQuit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    parent: win, width: 560, height: 640, title: t(settings.lang, 'settingsTitle'), icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  senders.add(settingsWin.webContents);
  // Link GitHub (About) dibuka di browser bawaan, bukan navigasi in-app.
  settingsWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
}

const liveModel = async () => {
  try {
    const h = await (await fetch(`${AGENT_URL}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
    return h.ok ? h.model || null : null;
  } catch { return null; }
};

const settingsPayload = async () => ({
  lang: settings.lang,
  notif: settings.notif,
  llm: settingsStore.readLlm(WAREADER_ENV),
  about: { version: app.getVersion(), repo: REPO },
  liveModel: await liveModel(),
});

function applySettings(arg = {}) {
  if (typeof arg.lang === 'string' && arg.lang !== settings.lang) {
    settings.lang = arg.lang === 'en' ? 'en' : 'id';
    settingsStore.save(app.getPath('userData'), settings);
    buildTray(); broadcast();
  }
  if (typeof arg.notif === 'boolean' && arg.notif !== settings.notif) {
    settings.notif = arg.notif;
    settingsStore.save(app.getPath('userData'), settings);
    broadcast();
  }
  if (arg.llmReset) {
    settingsStore.writeLlm(WAREADER_ENV, { url: null, name: null, key: null });
  } else if (arg.llm && typeof arg.llm === 'object') {
    const patch = {};
    for (const f of ['url', 'name']) if (typeof arg.llm[f] === 'string') patch[f] = arg.llm[f].trim().slice(0, 500);
    if (typeof arg.llm.key === 'string' && arg.llm.key.trim()) patch.key = arg.llm.key.trim().slice(0, 500);
    settingsStore.writeLlm(WAREADER_ENV, patch);
  }
}

ipcMain.handle('nekochannel', async (_e, cmd, arg) => {
  if (!trusted(_e.sender)) return { error: 'untrusted sender' };
  if (cmd === 'add') {
    const channel = arg && registry[arg.channel] ? arg.channel : 'whatsapp';
    setActive(spawn(store.add(file(), persistList(), channel, registry[channel].short)).id);
  } else if (cmd === 'rename') {
    const a = accounts.find(x => x.id === arg?.id);
    const label = String(arg?.label || '').trim().slice(0, 80);
    if (a && label) {
      a.label = label;
      a.setLabel(label);
      if (a.account) driver.setLabel(a.account, label);
      store.save(file(), persistList());
      broadcast(); // langsung, jangan tunggu probe 30s
    }
  } else if (cmd === 'set-icon') { // #15: '' = hapus icon → balik ke inisial
    const a = accounts.find(x => x.id === arg?.id);
    const icon = typeof arg?.icon === 'string' ? [...arg.icon.trim()].slice(0, 4).join('') : null;
    if (a && icon !== null) {
      if (icon) a.icon = icon; else delete a.icon;
      store.save(file(), persistList());
      broadcast();
    }
  } else if (cmd === 'reorder' && Array.isArray(arg?.ids)) {
    const byId = new Map(accounts.map(a => [a.id, a]));
    const next = arg.ids.map(id => byId.get(id)).filter(Boolean); // id asing/duplikat → panjang beda → ditolak
    if (next.length === accounts.length) {
      accounts.splice(0, accounts.length, ...next);
      store.save(file(), persistList());
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
      store.save(file(), persistList());
      if (activeId === a.id) setActive(accounts[0]?.id || 'agent'); else broadcast();
    }
    // ponytail: view dibuang via removeChildView + drop ref (GC yang reclaim);
    // partisi & queue file sengaja disisakan — re-add dengan n yang sama langsung
    // reconnect sesi lama tanpa QR. Tambah opsi "hapus sesi" kalau pernah diminta.
  } else if (cmd === 'active') {
    if (arg?.id === 'agent' && agentDock && accounts.length) setAgentDock(false); // klik Agent saat dock → balik tab penuh
    else if (arg?.id === 'agent' || accounts.some(x => x.id === arg?.id)) setActive(arg.id);
  } else if (cmd === 'agent-dock') {
    setAgentDock(!agentDock);
  } else if (cmd === 'open-settings') {
    openSettings();
  } else if (cmd === 'settings-get') {
    return settingsPayload();
  } else if (cmd === 'settings-set') {
    applySettings(arg);
    return settingsPayload();
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
  senders.add(win.webContents);
  // #12: shell renderer mati → reload UI-nya saja (view capture milik main
  // process, tetap hidup); tanpa ini sidebar hilang diam-diam.
  win.webContents.on('render-process-gone', () => { console.log('[shell] renderer gone; reload UI'); win.webContents.reload(); });
  // Tutup window = sembunyi ke tray; semua view tetap live (backgroundThrottling:false)
  // (renderer window.close() merusak tanpa event close — jalur X titlebar/Alt+F4 aman)
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  tray = new Tray(icon().resize({ width: 22, height: 22 }));
  tray.setToolTip('Nekochannel');
  buildTray();
  app.on('before-quit', () => { quitting = true; });
  agent = createAgentView({ log: m => console.log(`[agent] ${m}`), lang: () => settings.lang });
  agent.start();
  hookSwitcher(agent.wc); // #14: Ctrl+K juga dari tab agent
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
  win.on('resize', () => {
    if (!activeId) return;
    const p = panes();
    for (const a of accounts) if (a.id === activeId) a.view.setBounds(p.dock ? p.left : p.full);
    if (p.dock || activeId === 'agent') agent.view.setBounds(p.dock ? p.right : p.full);
  });
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); agent.dispose(); });
  startWatch();
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts, driver, endpoint);
});

app.on('window-all-closed', () => { driver?.dispose(); app.quit(); });
