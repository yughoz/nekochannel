'use strict';
// Tab Agent: WebContentsView ke chat server wa-reader (127.0.0.1:4318) — nol UI
// baru di Nekochannel (PRD docs/modul_agent.md). Server mati → halaman error
// statis internal + tombol retry + auto-retry lewat health poll 10s.
const { WebContentsView } = require('electron');
const { t } = require('./i18n');

const AGENT_URL = process.env.NEKOCHANNEL_AGENT_URL || 'http://127.0.0.1:4318';

// State machine poll (murni, agar bisa di-test tanpa Electron):
// hidup & belum tampil → muat chat; mati & tampil → fallback; sisanya idle.
const nextStep = (healthy, loaded) =>
  healthy && !loaded ? 'load-chat' :
  !healthy && loaded ? 'show-error' : 'idle';

const errorPage = (url, lang = 'id') => {
  const s = k => t(lang, k);
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${s('errTitle')}</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#111b21;color:#8696a0;font:14px/1.6 system-ui,sans-serif;text-align:center}
button{margin-top:14px;padding:8px 22px;border:none;border-radius:8px;background:#1769aa;color:#fff;font:inherit;cursor:pointer}
button:hover{filter:brightness(1.15)}code{color:#e9edef}</style></head><body>
<div><div style="font-size:34px">🤖</div>
<div style="margin-top:8px"><b style="color:#e9edef">${s('errHead')}</b></div>
<div style="margin-top:4px">${s('errStart')}<br><code>Restart Nekochannel / check local service ports</code></div>
<button onclick="location.replace('${url}')">${s('errRetry')}</button></div></body></html>`);
};

function createAgentView({ url = AGENT_URL, pollMs = 10000, log = console.log, lang = () => 'id' } = {}) {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true } });
  view.setBackgroundColor('#111b21');
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // semua navigasi tetap in-tab
  let loaded = false;
  let busy = false; // hindari loadURL tumpuk saat poll & retry bawaan barengan
  // Sesi chat per channel: { key, label, account } → hash URL halaman chat.
  // Ganti sesi = ganti hash (tanpa reload, riwayat sesi lain tetap di halaman);
  // muat ulang (crash/retry) tetap membawa sesi aktif.
  let session = null;
  const target = () => url + sessionHash(session);

  const showError = async () => {
    loaded = false;
    try { await wc.loadURL(errorPage(target(), lang())); } catch { /* data URL tak gagal */ }
    log('fallback error page tampil');
  };
  const loadChat = async () => {
    try {
      await wc.loadURL(target());
      loaded = true;
      log(`chat server siap (${url})`);
    } catch {
      await showError();
    }
  };
  wc.on('did-fail-load', (_e, code, _desc, _validated, isMainFrame) => {
    // -3 ABORTED = navigasi digantikan; hanya main-frame yang relevan.
    if (!isMainFrame || code === -3) return;
    showError();
  });
  // #12: renderer crash → anggap belum muat, biar poll yang reload (server
  // hidup → load-chat ≤10s; mati → fallback error). busy ikut di-reset karena
  // loadURL yang sedang pending tidak akan pernah selesai normal.
  wc.on('render-process-gone', () => { loaded = false; busy = false; log('renderer gone; menunggu poll reload'); });
  const tick = async () => {
    if (busy) return;
    let healthy = false;
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
      healthy = Boolean((await res.json()).ok);
    } catch { healthy = false; }
    const step = nextStep(healthy, loaded);
    if (step === 'idle') return;
    busy = true;
    if (step === 'load-chat') await loadChat(); else await showError();
    busy = false;
  };
  let timer = null;
  return {
    id: 'agent',
    view,
    wc,
    start: () => {
      tick().catch(() => {}); // tick pertama di boot, bukan nunggu interval
      timer = setInterval(() => tick().catch(() => {}), pollMs);
      timer.unref?.();
    },
    dispose: () => { if (timer) clearInterval(timer); },
    setSession(next) {
      const changed = sessionHash(next) !== sessionHash(session);
      session = next;
      if (!changed || !loaded || wc.isDestroyed()) return; // belum termuat → loadChat membawa hash
      wc.executeJavaScript(`location.hash = ${JSON.stringify(sessionHash(next))}`).catch(() => {});
    },
  };
}

const sessionHash = s => s?.key ? `#${new URLSearchParams({ s: s.key, label: s.label || '', account: s.account || '', phone: s.phone || '', chat: s.chat || '' })}` : '';

// ---- #11: dock kanan --------------------------------------------------------
// Chat agent nempel di kanan konten, akun aktif di kiri — murni (di-test tanpa
// Electron). Tanpa akun / konten sempit, pemanggil boleh jatuh ke `full`.
const DOCK_RATIO = 0.45; // porsi agent dari lebar konten
const splitBounds = (width, height, sidebarW, ratio = DOCK_RATIO) => {
  const w = Math.max(1, width - sidebarW);
  const h = Math.max(1, height);
  const rw = Math.min(Math.max(1, Math.round(w * ratio)), Math.max(0, w - 1)); // kiri min 1px
  const lw = w - rw;
  return {
    left: { x: sidebarW, y: 0, width: lw, height: h },
    right: { x: sidebarW + lw, y: 0, width: rw, height: h },
    full: { x: sidebarW, y: 0, width: w, height: h },
  };
};

module.exports = { createAgentView, nextStep, errorPage, sessionHash, AGENT_URL, splitBounds, DOCK_RATIO };
