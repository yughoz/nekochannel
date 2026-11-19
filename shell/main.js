'use strict';
const path = require('node:path');
const fs = require('node:fs');
const electron = require('electron');
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, Notification, shell, WebContentsView, globalShortcut } = electron;
const { pathToFileURL } = require('node:url');
const privacy = require('./privacy');
const { createLock } = require('./lock');
const registry = require('../adapters');
const { makeDriver, normalizeAccount } = require('../adapters/whatsapp/driver');
const store = require('./accounts');
const settingsStore = require('./settings');
const integrations = require('./integrations');
const { STR, t } = require('./i18n');
const buildNotif = require('./notify');
const { makeEngine } = require('./action');
const waAction = require('../adapters/whatsapp/action');
const { createAgentView, splitBounds } = require('./agent');
const { startBackend } = require('../backend');

app.setName('nekochannel');
app.setPath('userData', process.env.NEKOCHANNEL_USER_DATA || path.join(app.getPath('appData'), 'nekochannel'));

// #13: satu instance per userData — yang kedua keluar diam-diam, event di
// instance pertama menampilkan + memfokuskan window (tanpa dobel capture).
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on('second-instance', () => {
  console.log('[instance] second instance → show + focus existing window');
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const settings = settingsStore.load(app.getPath('userData'));
let integrationStore, activeIntegrations, integrationError = false;
const repoRaw = require('../package.json').repository || '';
const REPO = repoRaw.startsWith('github:') ? `https://github.com/${repoRaw.slice('github:'.length)}` : repoRaw;

// Renderer tepercaya: window utama + jendela settings (didata saat dibuat).
const senders = new Set();
const localPages = ['index.html', 'settings.html', 'action.html'].map(name => pathToFileURL(path.join(__dirname, name)).href);
const trusted = wc => senders.has(wc) && !wc.isDestroyed() && localPages.includes(wc.getURL());
const trustedEvent = event => trusted(event.sender) && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === event.sender.getURL();
const protectLocal = wc => {
  wc.on('will-navigate', event => event.preventDefault());
  wc.on('will-attach-webview', event => event.preventDefault());
};

// Kamus UI untuk preload (sendSync sekali saat load renderer).
ipcMain.on('nekochannel:i18n', e => { e.returnValue = trustedEvent(e) ? { id: STR.id, en: STR.en } : null; });

let endpoint, AGENT_URL, backend;
const SIDEBAR_W = 232;
const SIDEBAR_W_COLLAPSED = 48; // #18: rail icon-only saat collapse
const PROBE_MS = 30000; // PRD: status probe ringan sekali per 30s per akun
const file = () => path.join(app.getPath('userData'), 'accounts.json');

let win, driver, agent, tray, settingsWin;
let engine, actionView; // M6: action engine + tab Action
let quitting = false;
let lock;
const blur = privacy.createInjector(() => settings.privacy, () => console.error('[privacy] CSS injection failed; retry on next load/settings change'));
const accounts = []; // live: { channel, n, label, id, view, wc, injected, account, status }
let activeId = null;
let agentDock = !!settings.agentDock; // #11: chat agent dock kanan (persist)
let sidebarCollapsed = !!settings.sidebarCollapsed; // #18: rail 48px (persist)
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
  accounts: accounts.map(({ id, channel, n, label, icon, account, status }) => {
    const masked = settings.privacy.enabled && settings.privacy.accountLabels;
    return { id, channel, n, label: masked ? `WA ${n}` : label, icon: masked ? '' : icon,
      account: masked ? null : account || null, status: masked ? { ...status, detail: '' } : status };
  }),
  activeId,
  agentDock,
  sidebarCollapsed,
  server: { ok: serverOk && !!driver && accounts.some(account => {
    const status = driver.status.get(account.account);
    return !account.wc.isDestroyed() && status?.connected && Date.now() - Date.parse(status.at) < 90000;
  }), enabled: settings.reader },
  lang: settings.lang,
  notif: settings.notif,
  reader: settings.reader,
  privacy: privacy.publicSettings(settings.privacy),
  locked: !!lock?.isLocked(),
});
const broadcast = () => {
  for (const window of [win, settingsWin]) if (window && !window.isDestroyed()) window.webContents.send('nekochannel:state', snapshot());
};

// #14 quick switcher: Ctrl+K. Sinyal focus/intercept level browser SEMUANYA mati
// untuk WebContentsView di XWayland ini (diuji E2E: before-input-event gak fire
// untuk key real/CDP, globalShortcut X11 grab flaky, menu accelerator gak fire,
// isFocused()/blur jadi false palsu pas klik ke view). Yang reliable: keydown DOM
// di dalam halaman — jadi tiap view di-inject hook kecil yang nandaai lewat
// console, main tangkap via console-message (bukan capture path, nol preload).
const SW_MARK = '__neko_switcher__';
const SB_MARK = '__neko_sidebar__'; // #18: Ctrl+B collapse dari dalam view
const SW_HOOK = `(() => {
  if (window.__nekoSwHook) return;
  window.__nekoSwHook = true;
  addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); console.log('${SW_MARK}'); }
      else if (k === 'b') { e.preventDefault(); console.log('${SB_MARK}'); } // #18 collapse sidebar
    }
  }, true);
})()`;
const injectSwitcherKey = wc => wc.executeJavaScript(SW_HOOK, true).catch(() => {});
const hookSwitcher = wc => {
  wc.on('console-message', (_e, _level, message) => {
    if (message === SW_MARK) openSwitcher();
    else if (message === SB_MARK) toggleSidebar();
  });
  wc.on('dom-ready', () => injectSwitcherKey(wc));
  injectSwitcherKey(wc);
};

// M6 view-busy: ketikan di view akun = human aktif di akun itu. Pola sama
// dengan hook Ctrl+K (keydown DOM selalu diterima; console-message ke main).
const ACT_MARK = '__neko_activity__';
const ACT_HOOK = `(() => {
  if (window.__nekoActHook) return;
  window.__nekoActHook = true;
  addEventListener('keydown', () => console.log('${ACT_MARK}'), true);
})()`;
const hookActivity = a => {
  a.wc.on('console-message', (_e, _level, message) => { if (message === ACT_MARK) a.lastInput = Date.now(); });
  a.wc.on('dom-ready', () => a.wc.executeJavaScript(ACT_HOOK, true).catch(() => {}));
  a.wc.executeJavaScript(ACT_HOOK, true).catch(() => {});
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

// Bounds per mode: dock → kiri akun + kanan agent; tab Action = panel penuh
// (dock cuma pasangan akun+agent); sisanya satu panel penuh.
function panes() {
  const b = win.contentView.getBounds();
  return {
    ...splitBounds(b.width, b.height, sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W),
    dock: agentDock && accounts.length > 0 && activeId !== 'agent' && activeId !== 'action',
  };
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
  if (id === 'action' && actionView) {
    win.contentView.removeChildView(actionView.view);
    win.contentView.addChildView(actionView.view);
    actionView.view.setBounds(p.full);
    actionView.view.setVisible(true);
  } else if (actionView) {
    actionView.view.setVisible(false);
  }
  broadcast();
  // #14: fokus keyboard ikut ke view aktif — abis switch user langsung ngetik di
  // akun tsb, dan Ctrl+K berikutnya nangkep lewat hook halaman (hookSwitcher).
  if (id === 'agent') agent.wc.focus();
  else if (id === 'action') actionView.wc.focus();
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

// #18: collapse sidebar jadi rail 48px — persist, lalu setActive pasang ulang
// bounds semua view dengan lebar sidebar baru (pola sama dengan setAgentDock).
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  settings.sidebarCollapsed = sidebarCollapsed;
  settingsStore.save(app.getPath('userData'), settings);
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
  if (lock?.isLocked() || settings.privacy.enabled) return;
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
    ...(process.env.NEKOCHANNEL_READER_SMOKE ? { url: require('./reader-smoke').fixture(rec.n) } : {}),
    ...(process.env.NEKOCHANNEL_INTEGRATIONS_SMOKE ? { url: 'data:text/html,Local%20integration%20fixture' } : {}),
    log: m => console.log(`[${a.id}] ${m}`),
    onStatus: p => readerStatus(a, p),
  }));
  if (rec.channel === 'whatsapp') blur.attach(a.wc);
  hookSwitcher(a.wc); // #14: Ctrl+K dari dalam halaman
  hookActivity(a); // M6: sinyal view-busy (human ngetik di akun itu)
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
// M6: kill switch cepat — checkbox tray + toggle di tab Action + Settings.
function setActionMaster(on) {
  settings.action = { ...(settings.action || { accounts: {} }), master: !!on };
  settingsStore.save(app.getPath('userData'), settings);
  engine?.setMaster(!!on);
  buildTray();
}

function buildTray() {
  if (!tray) return;
  const s = k => t(settings.lang, k);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: s('privacyBlur'), type: 'checkbox', checked: settings.privacy.enabled,
      enabled: !lock?.isLocked(), click: () => toggleBlur() },
    { label: s('lockNow'), enabled: !!settings.privacy.passwordHash, click: () => lock.lock() },
    { label: s('trayShow'), click: () => { win.show(); win.focus(); } },
    { label: s('traySettings'), enabled: !lock?.isLocked(), click: () => openSettings() },
    { type: 'separator' },
    { label: s('trayAction'), type: 'checkbox', checked: !!settings.action?.master, enabled: !lock?.isLocked(),
      click: i => setActionMaster(i.checked) },
    { label: 'Autostart', type: 'checkbox', checked: autostartOn(), enabled: !lock?.isLocked(),
      click: i => setAutostart(i.checked) },
    { label: s('trayTheme'), enabled: !lock?.isLocked(), submenu: [['system', s('trayThemeSys')], ['light', s('trayLight')], ['dark', s('trayDark')]].map(([v, label]) => ({
      label, type: 'radio', checked: nativeTheme.themeSource === v,
      click: () => { nativeTheme.themeSource = v; },
    })) },
    { type: 'separator' },
    { label: s('trayQuit'), enabled: !lock?.isLocked(), click: () => app.quit() },
  ]));
}

function openSettings() {
  if (lock?.isLocked()) return lock.cover();
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus();
  settingsWin = new BrowserWindow({
    parent: win, width: 560, height: 640, title: t(settings.lang, 'settingsTitle'), icon: icon(),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  senders.add(settingsWin.webContents);
  protectLocal(settingsWin.webContents);
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
  reader: settings.reader,
  lang: settings.lang,
  notif: settings.notif,
  llm: { ...(integrationStore?.public().llm || {}), fbUrl: integrationStore?.public().summary.url || '', fbName: integrationStore?.public().summary.name || '' },
  integrations: integrationStore?.public() || integrations.publicConfig(integrations.defaults()),
  integrationStatus: { secure: !integrationError, restartRequired: integrationStore ? JSON.stringify(integrationStore.get()) !== JSON.stringify(activeIntegrations) : false,
    mcpUrl: backend?.mcpUrl ? `${backend.mcpUrl}/mcp` : null, mcpEnabled: !!activeIntegrations?.mcp.enabled },
  about: { version: app.getVersion(), repo: REPO },
  liveModel: await liveModel(),
  action: { master: !!settings.action?.master, accounts: { ...(settings.action?.accounts || {}) } },
  accountsList: snapshot().accounts.map(({ id, label, icon }) => ({ id, label, icon })),
  privacy: privacy.publicSettings(settings.privacy),
});

async function applySettings(arg = {}) {
  if (lock?.isLocked()) throw new Error('Locked');
  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some(key => !['reader', 'lang', 'notif', 'action', 'llm', 'llmReset', 'privacy', 'integrations'].includes(key))) throw new TypeError('Invalid settings');
  const integrationPatch = { ...(arg.integrations || {}), ...(arg.llm ? { llm: arg.llm } : {}), ...(arg.llmReset ? { llm: { reset: true } } : {}) };
  if ('integrations' in arg) integrations.validate(arg.integrations);
  if (Object.keys(integrationPatch).length) {
    if (!integrationStore) throw new Error('Secure storage unavailable');
    integrations.patchConfig(integrationStore.get(), integrationPatch);
  }
  if ('lang' in arg && !['id', 'en'].includes(arg.lang)) throw new TypeError('Invalid language');
  for (const key of ['reader', 'notif', 'llmReset']) if (key in arg && typeof arg[key] !== 'boolean') throw new TypeError('Invalid boolean');
  if (arg.privacy !== undefined) privacy.validatePatch(arg.privacy);
  if ('action' in arg && (!arg.action || typeof arg.action !== 'object' || Array.isArray(arg.action) ||
    Object.keys(arg.action).some(key => !['master', 'accounts'].includes(key)) ||
    ('master' in arg.action && typeof arg.action.master !== 'boolean') ||
    ('accounts' in arg.action && (!arg.action.accounts || typeof arg.action.accounts !== 'object' || Array.isArray(arg.action.accounts) ||
      Object.entries(arg.action.accounts).some(([id, value]) => !accounts.some(account => account.id === id) || typeof value !== 'boolean'))))) throw new TypeError('Invalid action settings');
  if ('llm' in arg && (!arg.llm || typeof arg.llm !== 'object' || Array.isArray(arg.llm) ||
    Object.entries(arg.llm).some(([key, value]) => !['url', 'name', 'key'].includes(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)))) throw new TypeError('Invalid LLM settings');
  if (arg.privacy) {
    const { password, ...patch } = arg.privacy;
    const passwordHash = password === undefined ? undefined : await privacy.hashPassword(password);
    if (lock?.isLocked()) throw new Error('Locked');
    const next = { ...settings.privacy, ...patch, ...(passwordHash ? { passwordHash } : {}) };
    settingsStore.save(app.getPath('userData'), { ...settings, privacy: next });
    settings.privacy = next;
    await blur.apply();
    buildTray(); broadcast();
  }
  if (lock?.isLocked()) throw new Error('Locked');
  if ('reader' in arg && arg.reader !== settings.reader) {
    settingsStore.save(app.getPath('userData'), { ...settings, reader: arg.reader });
    settings.reader = arg.reader;
    driver.setEnabled(arg.reader);
    backend.setReaderEnabled(arg.reader);
    for (const account of accounts) {
      if (!account.wc.isDestroyed()) account.wc.send('reader-command', { type: 'reader-control', enabled: arg.reader });
    }
    broadcast();
  }
  if (typeof arg.lang === 'string' && arg.lang !== settings.lang) {
    settings.lang = arg.lang === 'en' ? 'en' : 'id';
    settingsStore.save(app.getPath('userData'), settings);
    buildTray(); broadcast();
    lock?.refresh();
  }
  if (typeof arg.notif === 'boolean' && arg.notif !== settings.notif) {
    settings.notif = arg.notif;
    settingsStore.save(app.getPath('userData'), settings);
    broadcast();
  }
  if (arg.action && typeof arg.action === 'object') { // M6: master + toggle per akun
    const prev = settings.action || { master: false, accounts: {} };
    const next = {
      master: typeof arg.action.master === 'boolean' ? arg.action.master : !!prev.master,
      accounts: { ...prev.accounts, ...(arg.action.accounts && typeof arg.action.accounts === 'object' ? arg.action.accounts : {}) },
    };
    settings.action = next;
    settingsStore.save(app.getPath('userData'), settings);
    if (prev.master !== next.master) engine?.setMaster(next.master);
    for (const [id, v] of Object.entries(next.accounts)) if (!!prev.accounts[id] !== !!v) engine?.setAccount(id, !!v);
    buildTray();
  }
  if (Object.keys(integrationPatch).length) integrationStore.save(integrationPatch);
}

function toggleBlur() {
  settingsWrite = settingsWrite.catch(() => {}).then(() => applySettings({ privacy: { enabled: !settings.privacy.enabled } }));
  settingsWrite.catch(() => console.error('[privacy] Cannot save settings'));
}

ipcMain.handle('privacy:unlock', (event, password) => lock ? lock.unlock(event, password) : { ok: false });
let settingsWrite = Promise.resolve();
let webhookTesting = false;

ipcMain.handle('nekochannel', async (_e, cmd, arg) => {
  if (!trustedEvent(_e)) return { error: 'untrusted sender' };
  if (lock?.isLocked() && cmd !== 'state') return { error: 'locked' };
  if (['settings-set', 'settings-get', 'reader-backfill', 'webhook-test', 'mcp-copy-key'].includes(cmd) && _e.sender !== settingsWin?.webContents && (cmd !== 'settings-get' || _e.sender !== win?.webContents)) return { error: 'untrusted settings sender' };
  if (cmd === 'webhook-test' || cmd === 'mcp-copy-key') {
    if (arg !== undefined || !integrationStore || integrationError) return { error: 'integration-unavailable' };
    if (cmd === 'mcp-copy-key') {
      try { await electron.clipboard.writeText(integrationStore.get().mcp.key); return { ok: true }; }
      catch { return { ok: false }; }
    }
    if (webhookTesting) return { error: 'test-in-progress' };
    webhookTesting = true;
    try { return await integrations.testWebhook(integrationStore.get()); }
    finally { webhookTesting = false; }
  }
  if (cmd === 'reader-backfill') {
    if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some(key => !['id', 'action'].includes(key)) ||
      typeof arg.id !== 'string' || !['start', 'pause'].includes(arg.action)) return { error: 'invalid-backfill' };
    const account = accounts.find(account => account.id === arg.id && normalizeAccount(account.account));
    if (!account || !settings.reader) return { error: 'reader-unavailable' };
    try {
      const progress = driver.backfill(account.account, arg.action);
      account.wc.send('reader-command', { type: 'backfill-command', action: arg.action === 'start' ? 'resume' : 'pause', progress });
      return { ok: true };
    } catch { return { error: 'backfill-failed' }; }
  }
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
    else if (arg?.id === 'agent' || arg?.id === 'action' || accounts.some(x => x.id === arg?.id)) setActive(arg.id);
  } else if (cmd === 'agent-dock') {
    setAgentDock(!agentDock);
  } else if (cmd === 'sidebar-toggle') { // #18
    toggleSidebar();
  } else if (cmd === 'open-settings') {
    openSettings();
  } else if (cmd === 'settings-get') {
    return settingsPayload();
  } else if (cmd === 'settings-set') {
    settingsWrite = settingsWrite.catch(() => {}).then(() => applySettings(arg));
    try { await settingsWrite; } catch { return { error: 'invalid-settings' }; }
    return settingsPayload();
  } else if (cmd === 'action-get') { // M6
    return engine ? engine.snapshot() : { error: 'engine belum siap' };
  } else if (cmd === 'action-master') {
    setActionMaster(arg?.on);
    return engine ? engine.snapshot() : { error: 'engine belum siap' };
  } else if (cmd !== 'state') {
    return { error: `unknown cmd: ${cmd}` };
  }
  return snapshot();
});

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  try { integrationStore = integrations.openStore(app.getPath('userData'), electron.safeStorage); }
  catch { integrationError = true; console.error('[integrations] Secure configuration unavailable; external integrations disabled. Existing files retained for recovery.'); }
  activeIntegrations = integrationStore?.get() || integrations.defaults();
  if (integrationError) activeIntegrations.mcp.enabled = false;
  backend = await startBackend({ dir: app.getPath('userData'), integrations: activeIntegrations, readerEnabled: settings.reader,
    ...(process.env.NEKOCHANNEL_USER_DATA && process.env.NEKOCHANNEL_MCP_PORT === '0' ? { mcpPort: 0 } : {}) });
  endpoint = backend.ingestUrl;
  AGENT_URL = backend.chatUrl;
  if (process.env.NEKOCHANNEL_BACKEND_SMOKE === '1') {
    await require('./backend-smoke')(backend, app.getPath('userData'));
    app.quit();
    return;
  }
  if (process.platform === 'darwin' && app.dock) app.dock.setIcon(icon()); // logo dock macOS (dev)
  if (!process.env.NEKOCHANNEL_USER_DATA) setAutostart(true); // isolated profiles must not change login items
  lock = createLock({ electron, settings: () => settings.privacy, strings: () => ({ ...STR[settings.lang], lang: settings.lang }), onChange: () => { buildTray(); broadcast(); } });
  for (const [shortcut, callback] of [['Alt+Z', toggleBlur], ['Alt+X', () => lock.lock()]]) {
    if (!globalShortcut.register(shortcut, callback)) console.error(`[privacy] Shortcut unavailable: ${shortcut}`);
  }
  win = new BrowserWindow({
    width: 1280, height: 860, title: 'Nekochannel', icon: icon(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111b21' : '#f0f2f5',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  senders.add(win.webContents);
  protectLocal(win.webContents);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('show', () => { if (lock.isLocked()) lock.cover(); });
  win.on('focus', () => { if (lock.isLocked()) lock.cover(); });
  // #12: shell renderer mati → reload UI-nya saja (view capture milik main
  // process, tetap hidup); tanpa ini sidebar hilang diam-diam.
  win.webContents.on('render-process-gone', () => { console.log('[shell] renderer gone; reload UI'); win.webContents.reload(); });
  // Tutup window = sembunyi ke tray; semua view tetap live (backgroundThrottling:false)
  // (renderer window.close() merusak tanpa event close — jalur X titlebar/Alt+F4 aman)
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  tray = new Tray(icon().resize({ width: 22, height: 22 }));
  tray.setToolTip('Nekochannel');
  buildTray();
  agent = createAgentView({ url: AGENT_URL, log: m => console.log(`[agent] ${m}`), lang: () => settings.lang });
  agent.start();
  hookSwitcher(agent.wc); // #14: Ctrl+K juga dari tab agent
  // M6 tab Action: WebContentsView lokal (transkrip + log eksekusi real-time).
  actionView = (() => {
    const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
    view.setBackgroundColor('#111b21');
    const wc = view.webContents;
    senders.add(wc); // preload sendSync i18n — harus masuk trusted SEBELUM load
    protectLocal(wc);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.loadFile(path.join(__dirname, 'action.html'));
    return { view, wc };
  })();
  hookSwitcher(actionView.wc); // #18: Ctrl+B/Ctrl+K juga dari tab Action
  win.contentView.addChildView(actionView.view);
  actionView.view.setVisible(false);
  // M6 engine: gating master/per-akun, antrean, LLM sendiri, audit. Send =
  // executeJavaScript + input trusted di view akun (bukan capture path).
  const engineSend = async (account, chat, text) => {
    if (lock?.isLocked()) return { ok: false, stage: 'view', detail: 'locked' };
    const a = accounts.find(x => x.account === account);
    if (!a || a.status.state !== 'connected') return { ok: false, stage: 'view', detail: 'akun tidak connected' };
    // insertText butuh view kelihatan + pegang fokus (view tersembunyi = teks
    // gak nempel). Aktifkan tab akun selama kirim — sekalian transparan: user
    // lihat langsung aksi agent, lalu balik ke tab semula.
    const prev = activeId;
    setActive(a.id);
    try {
      await new Promise(r => setTimeout(r, 700)); // setelah aktivasi, chat-list re-render (virtualized) — kasih settle
      return await waAction.sendReply(a.wc, chat, text, m => console.log(`[action:${a.id}] ${m}`));
    } finally {
      if (prev && prev !== a.id && !win.isDestroyed()) setActive(prev);
    }
  };
  const engineBusy = account => {
    const a = accounts.find(x => x.account === account);
    if (!a) return true;
    if (Date.now() - (a.lastInput || 0) < 90000) return true; // baru ngetik
    return activeId === a.id && !win.isDestroyed() && win.isFocused(); // lagi buka akun itu
  };
  // settings.action.accounts disimpan per sidebar-id (whatsapp-N, ikut accounts.json);
  // driver kirim nomor WA — resolve di sini.
  const engineEnabled = account => {
    if (!settings.action?.master) return false;
    const a = accounts.find(x => x.account === account);
    return !!a && !!settings.action.accounts[a.id];
  };
  engine = makeEngine({
    logFile: path.join(app.getPath('userData'), 'action-log.jsonl'),
    settings, // live ref: settings.action dibaca tiap attempt, diubah via applySettings/tray
    getModel: () => integrations.modelConfig(activeIntegrations),
    busy: engineBusy,
    enabled: engineEnabled,
    send: engineSend,
    log: m => console.log(`[action] ${m}`),
    onEvent: ev => { if (actionView && !actionView.wc.isDestroyed()) actionView.wc.send('nekochannel:action', ev); },
  });
  driver = makeDriver({
    enabled: settings.reader,
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
    // + M6: engine action = konsumen kedua callback yang sama (bukan driver baru)
    onMessages: (account, items) => { showNotif(account, items); engine.onMessages(account, items); },
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
    if (activeId === 'action') actionView.view.setBounds(p.full);
  });
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); agent.dispose(); });
  startWatch();
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts, driver, endpoint);
  if (process.env.NEKOCHANNEL_READER_SMOKE) {
    require('./reader-smoke')({ app, win, accounts, driver, backend, openSettings }).then(() => app.quit()).catch(error => { console.error('[reader-smoke]', error); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_INTEGRATIONS_SMOKE) {
    require('./integrations-smoke')({ app, win, backend, openSettings }).then(() => app.quit()).catch(error => { console.error('[integrations-smoke] FAIL', error.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n')); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_PRIVACY_SMOKE) {
    require('./privacy-smoke')({ app, win, accounts, lock, openSettings, settings, blur, globalShortcut }).then(() => { lock.dispose(); app.quit(); }).catch(error => { console.error('[privacy-smoke]', error); process.exitCode = 1; lock.dispose(); app.quit(); });
  }
}).catch(error => {
  console.error('[startup] Internal services failed:', error.message);
  process.exitCode = 1;
  if (backend) app.quit(); else app.exit(1);
});

let stopped = false, stopping = false;
app.on('before-quit', e => {
  if (lock?.isLocked()) { e.preventDefault(); lock.cover(); return; }
  quitting = true;
  globalShortcut.unregisterAll();
  lock?.dispose();
  if (!backend || stopped) return;
  e.preventDefault();
  if (stopping) return;
  stopping = true;
  driver?.dispose();
  engine?.setMaster(false);
  agent?.dispose();
  backend.close().catch(error => { console.error('[shutdown]', error.message); process.exitCode = 1; })
    .finally(() => { stopped = true; app.quit(); });
});

app.on('window-all-closed', () => { driver?.dispose(); app.quit(); });
