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
const sentry = require('./sentry');
const { STR, t } = require('./i18n');
const buildNotif = require('./notify');
const waAction = require('../adapters/whatsapp/action');
const { createActions, SEND_TYPES } = require('./wa-actions');
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
const { screen } = electron;
let integrationStore, activeIntegrations, integrationError = false;
const repoRaw = require('../package.json').repository || '';
const REPO = repoRaw.startsWith('github:') ? `https://github.com/${repoRaw.slice('github:'.length)}` : repoRaw;

// Renderer tepercaya: window utama + jendela settings (didata saat dibuat).
const senders = new Set();
const localPages = ['index.html', 'settings.html'].map(name => pathToFileURL(path.join(__dirname, name)).href);
const trusted = wc => senders.has(wc) && !wc.isDestroyed() && localPages.includes(wc.getURL());
const trustedEvent = event => trusted(event.sender) && event.senderFrame === event.sender.mainFrame && event.senderFrame.url === event.sender.getURL();
const protectLocal = wc => {
  wc.on('will-navigate', event => event.preventDefault());
  wc.on('will-attach-webview', event => event.preventDefault());
};

// Kamus UI untuk preload (sendSync sekali saat load renderer).
ipcMain.on('nekochannel:i18n', e => { e.returnValue = trustedEvent(e) ? { id: STR.id, en: STR.en } : null; });
ipcMain.on('nekochannel:sentry-flag', e => { e.returnValue = trustedEvent(e) ? sentry.enabled() : false; });

let endpoint, AGENT_URL, backend;
const SIDEBAR_W = 232;
const SIDEBAR_W_COLLAPSED = 56; // #23: rail icon-only, target sentuh >=40px
const PROBE_MS = 30000; // PRD: status probe ringan sekali per 30s per akun
const file = () => path.join(app.getPath('userData'), 'accounts.json');

let win, driver, agent, tray;
const armedDeletes = new Set(); // #23b: popup nutup tiap klik — disarm kalau close tanpa delete
let viewSend = null; // kirim lewat view akun (input trusted), di-set saat app siap; dipakai send_message
let sendConfirming = false;
let waActions; // #29 aksi chat (wa_action), dibuat setelah window siap
const SEND_CONFIRM_MS = 120000;
let quitting = false;
let lock;
const blur = privacy.createInjector(() => settings.privacy, () => console.error('[privacy] CSS injection failed; retry on next load/settings change'));
const accounts = []; // live: { channel, n, label, id, view, wc, injected, account, status }
let activeId = null;
let agentSessionId = null; // akun terakhir yang dibuka = sesi chat Agent (tiap channel terpisah)
let agentDock = !!settings.agentDock; // #11: chat agent dock kanan (persist)
let sidebarCollapsed = !!settings.sidebarCollapsed; // #18: rail persist (#23 lebar 56px)
let serverOk = false;
const icon = () => nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
const ACCOUNT_EMOJI = ['🚀','🔥','⭐','❤️','👍','🎯','💼','📈','🎧','🛠️','📦','🤖','🐱','🐶','🌿','🌊','☀️','🌙','⚡','🎉','💡','🔒','📱','💬']; // #15/#23b
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
function snapshot() {
  return {
    accounts: accounts.map(({ id, channel, n, label, icon, account, status }) => {
      const masked = settings.privacy.enabled && settings.privacy.accountLabels;
      return { id, channel, n, label: masked ? `WA ${n}` : label, icon,
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
    settingsOpen: !!settingsOpen,
    sentry: sentry.enabled(),
  };
}
const broadcast = () => {
  // Saat quit (lock.dispose → onChange) win bisa sudah hancur: akses .webContents-nya melempar.
  const shellWc = win && !win.isDestroyed() ? win.webContents : null;
  for (const wc of [shellWc, settingsView?.wc]) if (wc && !wc.isDestroyed()) wc.send('nekochannel:state', snapshot());
  syncAgentSession();
};
// Sesi Agent ikut akun aktif; tab Agent penuh melanjutkan sesi akun terakhir.
// Dipanggil tiap broadcast → rename/privacy/nomor terdeteksi ikut ter-update.
function syncAgentSession() {
  if (!agent) return;
  const a = accounts.find(x => x.id === agentSessionId) || accounts.find(x => x.id === activeId) || accounts[0];
  if (!a) return;
  const masked = settings.privacy.enabled && settings.privacy.accountLabels;
  agent.setSession({ key: a.id, label: masked ? `WA ${a.n}` : a.label, account: a.account || '' });
}

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

// Bounds per mode: dock → kiri akun + kanan agent (dock cuma pasangan
// akun+agent); sisanya satu panel penuh.
function panes() {
  const b = win.contentView.getBounds();
  return {
    ...splitBounds(b.width, b.height, sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W),
    dock: agentDock && accounts.length > 0 && activeId !== 'agent',
  };
}

// All views stay attached & live (capture runs for every account simultaneously,
// backgroundThrottling:false); only the active one is visible/on top.
function setActive(id, keepSettings = false) {
  activeId = id;
  if (accounts.some(a => a.id === id)) agentSessionId = id;
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
  if (keepSettings && settingsOpen) {
    win.contentView.removeChildView(settingsView.view); // raise di atas semua
    win.contentView.addChildView(settingsView.view);
    settingsView.view.setBounds(settingsBounds());
    settingsView.view.setVisible(true);
    settingsView.wc.focus();
  } else if (!keepSettings) {
    settingsView.view.setVisible(false);
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
  if (agentDock && !accounts.some(x => x.id === activeId)) return setActive(accounts[0]?.id || 'agent', settingsOpen);
  setActive(activeId, settingsOpen);
}

// #18: collapse sidebar jadi rail — persist, lalu setActive pasang ulang
// bounds semua view dengan lebar sidebar baru (pola sama dengan setAgentDock).
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  settings.sidebarCollapsed = sidebarCollapsed;
  settingsStore.save(app.getPath('userData'), settings);
  setActive(activeId, settingsOpen);
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
    ...(process.env.NEKOCHANNEL_READER_SMOKE || process.env.NEKOCHANNEL_SEND_SMOKE || process.env.NEKOCHANNEL_AGENT_SESSION_SMOKE ? { url: require('./reader-smoke').fixture(rec.n) } : {}),
    ...(process.env.NEKOCHANNEL_WA_ACTIONS_SMOKE ? { url: require('./wa-actions-smoke').fixture(rec.n) } : {}),
    ...(process.env.NEKOCHANNEL_ACCOUNT_MENU_SMOKE ? { url: 'data:text/html,<title>WA fixture</title><main tabindex="0">WA</main>' } : {}),
    ...(process.env.NEKOCHANNEL_INTEGRATIONS_SMOKE ? { url: 'data:text/html,Local%20integration%20fixture' } : {}),
    log: m => console.log(`[${a.id}] ${m}`),
    onStatus: p => readerStatus(a, p),
  }));
  if (rec.channel === 'whatsapp') blur.attach(a.wc);
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
    { label: s('privacyBlur'), type: 'checkbox', checked: settings.privacy.enabled,
      enabled: !lock?.isLocked(), click: () => toggleBlur() },
    { label: s('lockNow'), enabled: !!settings.privacy.passwordHash, click: () => lock.lock() },
    { label: s('trayShow'), click: () => { win.show(); win.focus(); } },
    { label: s('traySettings'), enabled: !lock?.isLocked(), click: () => openSettings() },
    { type: 'separator' },
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

// #27 v2: Settings bukan window OS — WebContentsView penuh di kanan sidebar,
// di atas view WA/Agent/Action. Shell sidebar tetap kelihatan.
// ponytail: dibuat setelah window utama; Chromium butuh UI-thread window runtime.
let settingsView, settingsOpen = false;
const sentrySmokeViews = () => ({ settingsView });
function initSettingsView() {
  const view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  view.setBackgroundColor('#111b21');
  const wc = view.webContents;
  senders.add(wc); // preload sendSync i18n — masuk trusted SEBELUM load
  protectLocal(wc);
  // Link GitHub (About) dibuka di browser bawaan, bukan navigasi in-view.
  wc.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } });
  wc.loadFile(path.join(__dirname, 'settings.html'));
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); closeSettings(); }
  });
  view.setVisible(false);
  return { view, wc };
}
function settingsBounds() {
  const b = win.contentView.getBounds();
  return { x: sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W, y: 0,
    width: Math.max(1, b.width - (sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W)), height: b.height };
}
function openSettings() {
  if (lock?.isLocked()) return lock.cover();
  settingsOpen = true;
  setActive(activeId, true); // openSettings sentuh view, jangan ubah activeId
}
function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  settingsView.view.setVisible(false);
  setActive(activeId, true); // restore state persis sebelum settings
}

const liveModel = async () => {
  try {
    const h = await (await fetch(`${AGENT_URL}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
    return h.ok ? (h.model ? `${h.model}${h.fallback ? ` → ${h.fallback}` : ''}` : null) : null; // #30: tampilkan cadangan
  } catch { return null; }
};

// Tool send_message (Agent WA Engine + MCP): SELALU lewat dialog konfirmasi native.
// Isi arsip berasal dari pihak lain, jadi LLM tidak boleh bisa mengirim sendiri.
async function requestUserSend({ account, label, chat, chatJid, phone, isGroup, text, source }) {
  const s = key => STR[settings.lang]?.[key] ?? STR.id[key];
  const auditSend = (result, detail = '') => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'action-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), account, chat, action: 'send', source, text, result, detail, confirm: settings.confirmActions === false ? 'off' : 'dialog' }) + '\n'); }
    catch (error) { console.error(`[send] audit log failed: ${error.message}`); }
    console.log(`[send] ${source} ${result}${detail ? ` (${detail})` : ''}`); // isi pesan hanya di audit file
  };
  if (settings.sendEnabled !== true) return { status: 'disabled', detail: s('sendDisabled') }; // saklar Settings (default OFF)
  if (lock?.isLocked()) return { status: 'failed', detail: s('sendLocked') };
  const view = accounts.find(x => x.account === account);
  if (!viewSend || !win || win.isDestroyed() || !view) return { status: 'failed', detail: s('sendNoAccount') };
  if (view.status?.state !== 'connected') return { status: 'failed', detail: s('sendNotConnected') };
  if (sendConfirming) return { status: 'failed', detail: s('sendBusy') };
  sendConfirming = true;
  let approved = false;
  try {
    if (settings.confirmActions === false) { approved = true; console.log('[send] konfirmasi OFF (Settings) → tanpa dialog'); }
    else {
      if (!win.isVisible()) win.show();
      win.focus();
      const { response } = await electron.dialog.showMessageBox(win, {
        type: 'question', buttons: [s('sendConfirmSend'), s('sendConfirmCancel')], defaultId: 1, cancelId: 1, noLink: true,
        title: 'WA Engine', message: s('sendConfirmTitle'),
        detail: `${s('sendConfirmFrom')}: ${view.label || label || account}\n${s('sendConfirmTo')}: ${chat}${phone && chat.replace(/\D/g, '') !== phone ? ` (+${phone})` : ''}${isGroup ? ` (${s('sendConfirmGroup')})` : ''}\n${s('sendConfirmVia')}: ${source === 'mcp' ? 'MCP' : 'Agent'}\n\n${text}`,
        signal: AbortSignal.timeout(SEND_CONFIRM_MS), // tidak dijawab = batal
      });
      approved = response === 0;
    }
  } catch { approved = false; }
  finally { sendConfirming = false; }
  if (!approved) { auditSend('cancelled'); return { status: 'cancelled', detail: s('sendCancelled') }; }
  let result;
  try { result = await viewSend(account, chatJid, text, { name: chat, phone }); } // nama + nomor arsip → cocokkan baris chat
  catch (error) { result = { ok: false, stage: 'send', detail: String(error.message || error) }; }
  if (result?.ok) { auditSend('sent', result.title || ''); return { status: 'sent' }; }
  auditSend('error', `${result?.stage || 'send'}: ${result?.detail || ''}`.slice(0, 200));
  return { status: 'failed', detail: `${result?.stage || 'send'}: ${result?.detail || ''}`.slice(0, 200) };
}

const settingsPayload = async () => ({
  reader: settings.reader,
  lang: settings.lang,
  notif: settings.notif,
  llm: { ...(integrationStore?.public().llm || {}), fbUrl: integrationStore?.public().summary.url || '', fbName: integrationStore?.public().summary.name || '', fallback: integrationStore?.public().fallback || { url: '', name: '', keySet: false } },
  integrations: integrationStore?.public() || integrations.publicConfig(integrations.defaults()),
  integrationStatus: { secure: !integrationError, restartRequired: integrationStore ? JSON.stringify(integrationStore.get()) !== JSON.stringify(activeIntegrations) : false,
    mcpUrl: backend?.mcpUrl ? `${backend.mcpUrl}/mcp` : null, mcpEnabled: !!activeIntegrations?.mcp.enabled },
  about: { version: app.getVersion(), repo: REPO },
  liveModel: await liveModel(),
  sendEnabled: settings.sendEnabled === true,
  actionsEnabled: settings.actionsEnabled === true,
  confirmActions: settings.confirmActions !== false,
  accountsList: snapshot().accounts.map(({ id, label, icon }) => ({ id, label, icon })),
  backfill: Object.fromEntries(accounts.map(account => [account.id, (account.account && driver?.backfillProgress(account.account)) || null])),
  privacy: privacy.publicSettings(settings.privacy),
  settingsSection: settings.settingsSection,
});

async function applySettings(arg = {}) {
  if (lock?.isLocked()) throw new Error('Locked');
  if (!arg || typeof arg !== 'object' || Array.isArray(arg) || Object.keys(arg).some(key => !['reader', 'lang', 'notif', 'sendEnabled', 'actionsEnabled', 'confirmActions', 'llm', 'llmReset', 'privacy', 'integrations', 'settingsSection'].includes(key))) throw new TypeError('Invalid settings');
  const integrationPatch = { ...(arg.integrations || {}), ...(arg.llm ? { llm: arg.llm } : {}), ...(arg.llmReset ? { llm: { reset: true }, fallback: { reset: true } } : {}) };
  if ('integrations' in arg) integrations.validate(arg.integrations);
  if (Object.keys(integrationPatch).length) {
    if (!integrationStore) throw new Error('Secure storage unavailable');
    integrations.patchConfig(integrationStore.get(), integrationPatch);
  }
  if ('lang' in arg && !['id', 'en'].includes(arg.lang)) throw new TypeError('Invalid language');
  for (const key of ['reader', 'notif', 'llmReset', 'sendEnabled', 'actionsEnabled', 'confirmActions']) if (key in arg && typeof arg[key] !== 'boolean') throw new TypeError('Invalid boolean');
  if (arg.privacy !== undefined) privacy.validatePatch(arg.privacy);
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
  if (['general', 'reader', 'privacy', 'integrations', 'llm', 'about'].includes(arg.settingsSection)) {
    settings.settingsSection = arg.settingsSection;
    settingsStore.save(app.getPath('userData'), settings);
  }
  // Izin send_message: hanya lewat Settings (trusted sender), dibaca live tiap permintaan kirim.
  if (typeof arg.sendEnabled === 'boolean' && arg.sendEnabled !== settings.sendEnabled) {
    settings.sendEnabled = arg.sendEnabled;
    settingsStore.save(app.getPath('userData'), settings);
    console.log(`[send] send_message ${arg.sendEnabled ? 'ON' : 'OFF'} (Settings)`);
  }
  if (typeof arg.actionsEnabled === 'boolean' && arg.actionsEnabled !== settings.actionsEnabled) { // izin wa_action, sama: hanya lewat Settings
    settings.actionsEnabled = arg.actionsEnabled;
    settingsStore.save(app.getPath('userData'), settings);
    console.log(`[action] wa_action ${arg.actionsEnabled ? 'ON' : 'OFF'} (Settings)`);
  }
  // Konfirmasi native kirim/aksi (default ON). OFF = Agent/MCP langsung jalan tanpa dialog; hanya lewat Settings.
  if (typeof arg.confirmActions === 'boolean' && arg.confirmActions !== (settings.confirmActions !== false)) {
    settings.confirmActions = arg.confirmActions;
    settingsStore.save(app.getPath('userData'), settings);
    console.log(`[action] konfirmasi native ${arg.confirmActions ? 'ON' : 'OFF'} (Settings)`);
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

function removeAccount(id) {
  const i = accounts.findIndex(x => x.id === id);
  if (i < 0) return;
  const [account] = accounts.splice(i, 1);
  armedDeletes.delete(id);
  win.contentView.removeChildView(account.view);
  account.dispose();
  store.save(file(), persistList());
  if (activeId === account.id) setActive(accounts[0]?.id || 'agent'); else broadcast();
  // ponytail: view dibuang via removeChildView + drop ref (GC yang reclaim);
  // partisi & queue file sengaja disisakan — re-add dengan n yang sama langsung
  // reconnect sesi lama tanpa QR. Tambah opsi "hapus sesi" kalau pernah diminta.
}

// #23b: context menu account harus level OS — overlay shell tidak bisa menutupi
// WebContentsView (arsitektur sama dengan privacy #20). Sender diikat ke shell.
ipcMain.on('nekochannel:account-menu', (event, id) => {
  if (!trustedEvent(event) || event.sender !== win?.webContents || typeof id !== 'string') return;
  const account = accounts.find(x => x.id === id);
  if (!account || lock?.isLocked() || win.isDestroyed()) return;
  const s = k => t(settings.lang, k);
  let deleteClicked = false; // close callback bedakan klik vs Esc/outside
  Menu.buildFromTemplate([
      { label: s('accountRename'), click: () => { win.isDestroyed() || (win.webContents.focus(), win.webContents.send('nekochannel:account-action', { action: 'rename', id })) } },
      { label: s('accountReload'), click: () => { account.wc.isDestroyed() || account.wc.reload() } },
      {
        label: s('accountIcon'),
        submenu: [
          ...ACCOUNT_EMOJI.map(icon => ({ label: icon, click: () => { log('icon ' + icon); account.icon = icon; store.save(file(), persistList()); broadcast() } })),
          { type: 'separator' },
          { label: s('accountIconReset'), click: () => { delete account.icon; store.save(file(), persistList()); broadcast(); } },
        ],
      },
      { type: 'separator' },
      { label: s(armedDeletes.has(id) ? 'accountDeleteArmed' : 'accountDelete'), click: () => { deleteClicked = true; armedDeletes.delete(id) ? removeAccount(id) : armedDeletes.add(id); } },
  ]).popup({ window: win, callback: () => { if (!deleteClicked) armedDeletes.delete(id); } }); // ponytail: macOS popup callback sering telat; risiko armed salahtime saja
});

ipcMain.handle('nekochannel', async (_e, cmd, arg) => {
  if (!trustedEvent(_e)) return { error: 'untrusted sender' };
  if (lock?.isLocked() && cmd !== 'state') return { error: 'locked' };
  if (cmd === 'wa-action') return waActions ? waActions(arg, _e) : { status: 'failed', detail: 'engine unavailable' }; // butuh accountId + chatJid
  if (['settings-set', 'settings-get', 'reader-backfill', 'webhook-test', 'mcp-copy-key'].includes(cmd) && _e.sender !== settingsView.wc && (cmd !== 'settings-get' || _e.sender !== win?.webContents)) return { error: 'untrusted settings sender' };
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
      return { ok: true, progress: driver.backfillProgress(account.account) };
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
    removeAccount(arg?.id);
  } else if (cmd === 'active') {
    if (arg?.id === 'settings') { settingsOpen ? closeSettings() : openSettings(); }
    else if (arg?.id === 'agent' && agentDock && accounts.length) setAgentDock(false); // klik Agent saat dock → balik tab penuh
    else if (arg?.id === 'agent' || accounts.some(x => x.id === arg?.id)) setActive(arg.id);
  } else if (cmd === 'agent-dock') {
    setAgentDock(!agentDock);
  } else if (cmd === 'sidebar-toggle') { // #18
    toggleSidebar();
  } else if (cmd === 'open-settings') {
    settingsOpen ? closeSettings() : openSettings();
  } else if (cmd === 'settings-get') {
    return settingsPayload();
  } else if (cmd === 'settings-set') {
    settingsWrite = settingsWrite.catch(() => {}).then(() => applySettings(arg));
    try { await settingsWrite; } catch { return { error: 'invalid-settings' }; }
    return settingsPayload();
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
  if (activeIntegrations.sentry?.dsn && !sentry.initSentry(activeIntegrations.sentry.dsn)) console.error('[sentry] error tracking disabled');
  if (integrationError) activeIntegrations.mcp.enabled = false;
  backend = await startBackend({ dir: app.getPath('userData'), integrations: activeIntegrations, readerEnabled: settings.reader, sendMessage: requestUserSend, sendEnabled: () => settings.sendEnabled === true,
    actions: target => waActions ? waActions(target) : { status: 'failed', detail: 'engine unavailable' }, actionsEnabled: () => settings.actionsEnabled === true,
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
  settingsView = initSettingsView();
  // Kirim lewat view akun: executeJavaScript + input trusted (bukan capture path).
  // Dipakai tool send_message setelah izin Settings + konfirmasi user.
  viewSend = async (account, chat, text, { name = '', phone = '' } = {}) => {
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
      return await waAction.sendReply(a.wc, chat, text, m => console.log(`[send:${a.id}] ${m}`), { hint: name, phone });
    } finally {
      if (prev && prev !== a.id && !win.isDestroyed()) setActive(prev);
    }
  };
  // #29 aksi chat lewat bridge halaman (wa_action Agent/MCP, POST /api/action, IPC shell).
  // Saklar Settings > LLM Agent (default OFF); gambar/file/reply mengirim konten baru →
  // juga butuh saklar kirim. Tiap aksi dikonfirmasi native, rate limit per akun, audit.
  const str = key => STR[settings.lang]?.[key] ?? STR.id[key];
  waActions = createActions({
    accounts: () => accounts, trustedEvent, locked: () => !!lock?.isLocked(),
    logFile: path.join(app.getPath('userData'), 'action-log.jsonl'),
    gate: target => settings.actionsEnabled !== true ? str('actionsDisabled')
      : SEND_TYPES.has(target.action) && settings.sendEnabled !== true ? str('sendDisabled') : null,
    confirmMode: () => settings.confirmActions === false ? 'off' : 'dialog',
    confirm: async (account, target) => {
      if (settings.confirmActions === false) { console.log(`[action] konfirmasi OFF (Settings) → ${target.action} tanpa dialog`); return true; }
      if (!win || win.isDestroyed()) return false;
      if (!win.isVisible()) win.show();
      win.focus();
      const extra = [target.text, target.caption, target.file, target.emoji, target.msgId && `msgId: ${target.msgId}`].filter(Boolean).join('\n');
      const via = target.source === 'mcp' ? 'MCP' : target.source === 'agent' ? 'Agent' : 'Nekochannel';
      try {
        const { response } = await electron.dialog.showMessageBox(win, {
          type: 'question', buttons: [str('actionConfirmRun'), str('sendConfirmCancel')], defaultId: 1, cancelId: 1, noLink: true,
          title: 'WA Engine', message: `${str('actionConfirmTitle')} ${target.action}`,
          detail: `${str('sendConfirmFrom')}: ${account.label}\n${str('sendConfirmTo')}: ${target.chat}${target.phone ? ` (+${target.phone})` : ''}\n${str('sendConfirmVia')}: ${via}${extra ? `\n\n${extra}` : ''}`,
          signal: AbortSignal.timeout(SEND_CONFIRM_MS), // tidak dijawab = batal
        });
        return response === 0;
      } catch { return false; }
    },
    perform: async (account, target) => { // sama dengan viewSend: tab akun aktif selama aksi, lalu kembali
      const prev = activeId;
      setActive(account.id);
      try {
        await new Promise(r => setTimeout(r, 700));
        return await waAction.runPageAction(account.wc, target.chatJid, target, m => console.log(`[action:${account.id}] ${m}`), { hint: target.chat, phone: target.phone });
      } finally {
        if (prev && prev !== account.id && !win.isDestroyed()) setActive(prev);
      }
    },
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
    // Progress backfill live ke Settings > WA Reader (angka saja, tanpa JID).
    onBackfillProgress: (account, progress) => {
      if (!settingsView?.wc || settingsView.wc.isDestroyed()) return;
      for (const a of accounts) if (a.account === account) settingsView.wc.send('nekochannel:backfill', { id: a.id, progress });
    },
    // #9: notif desktop per batch pesan live yang baru masuk antrean
    onMessages: (account, items) => showNotif(account, items),
  });
  let recs = store.load(file());
  if (!recs.length) recs = [store.add(file(), [], 'whatsapp', registry.whatsapp.short)]; // first run: seed wa-1
  for (const rec of recs) spawn(rec);
  setActive(accounts[0].id);
  if (process.env.NEKOCHANNEL_ACCOUNT_MENU_SMOKE) accounts[0].wc.focus(); // smoke: view WA aktif seperti bug live
  win.on('resize', () => {
    if (!activeId) return;
    const p = panes();
    for (const a of accounts) if (a.id === activeId) a.view.setBounds(p.dock ? p.left : p.full);
    if (p.dock || activeId === 'agent') agent.view.setBounds(p.dock ? p.right : p.full);
    if (settingsOpen) settingsView.view.setBounds(settingsBounds());
  });
  win.on('closed', () => { for (const a of accounts.splice(0)) a.dispose(); agent.dispose(); });
  startWatch();
  if (process.env.NEKOCHANNEL_SMOKE) require('./smoke')(accounts, driver, endpoint);
  if (process.env.NEKOCHANNEL_READER_SMOKE) {
    require('./reader-smoke')({ app, win, accounts, driver, backend, openSettings, settingsView }).then(() => app.quit()).catch(error => { console.error('[reader-smoke]', error); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_AGENT_SESSION_SMOKE) {
    require('./agent-session-smoke')({ win, accounts, agent, setActive, settingsView }).then(() => app.quit()).catch(error => { console.error('[agent-session-smoke]', error); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_WA_ACTIONS_SMOKE) {
    require('./wa-actions-smoke')({ app, win, accounts, driver, backend, settingsView }).then(() => app.quit()).catch(error => { console.error('[wa-actions-smoke]', error); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_SEND_SMOKE) {
    require('./send-smoke')({ app, win, accounts, driver, backend, settingsView }).then(() => app.quit()).catch(error => { console.error('[send-smoke]', error); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_INTEGRATIONS_SMOKE) {
    require('./integrations-smoke')({ app, win, backend, openSettings, settingsView }).then(() => app.quit()).catch(error => { console.error('[integrations-smoke] FAIL', error.stack?.split('\n').filter(line => /^\s+at /.test(line)).join('\n')); process.exitCode = 1; app.quit(); });
  }
  if (process.env.NEKOCHANNEL_PRIVACY_SMOKE) {
    require('./privacy-smoke')({ app, win, accounts, lock, openSettings, settings, blur, globalShortcut, settingsView }).then(() => { lock.dispose(); app.quit(); }).catch(error => { console.error('[privacy-smoke]', error); process.exitCode = 1; lock.dispose(); app.quit(); });
  }
if (process.env.NEKOCHANNEL_SETTINGS_NAV_SMOKE) {
  require('./settings-nav-smoke')({ app, win, openSettings, setAgentDock, settingsView, closeSettings }).then(() => app.quit()).catch(error => { console.error('[settings-nav-smoke]', error); process.exitCode = 1; app.quit(); });
}
if (process.env.NEKOCHANNEL_ACCOUNT_MENU_SMOKE) {
  require('./account-menu-smoke')({ win, accounts, broadcast, lock, settings }).then(() => { lock?.dispose(); app.quit(); }).catch(error => { console.error('[account-menu-smoke]', error); process.exitCode = 1; lock?.dispose(); app.quit(); });
}
if (process.env.NEKOCHANNEL_SENTRY_SMOKE) {
  require('./sentry-smoke')({ app, win, backend, openSettings, views: sentrySmokeViews }).then(() => app.quit()).catch(error => { console.error('[sentry-smoke] FAIL', error); process.exitCode = 1; app.quit(); });
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
  agent?.dispose();
  // Batas waktu: close yang macet (koneksi/probe menggantung) jangan menahan app selamanya —
  // tanpa ini status "stopping" menolak semua quit berikutnya dan app cuma bisa di-kill.
  const timeout = new Promise(resolve => setTimeout(() => { console.error('[shutdown] backend close > 5s; quit tetap jalan'); resolve(); }, 5000).unref());
  Promise.race([backend.close(), timeout]).catch(error => { console.error('[shutdown]', error.message); process.exitCode = 1; })
    .finally(() => { stopped = true; app.quit(); });
});

app.on('window-all-closed', () => { driver?.dispose(); app.quit(); });
