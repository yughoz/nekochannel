'use strict';
// Tab Agent: WebContentsView ke chat server wa-reader (127.0.0.1:4318) — nol UI
// baru di Nekochannel (PRD docs/modul_agent.md). Server mati → halaman error
// statis internal + tombol retry + auto-retry lewat health poll 10s.
const { WebContentsView } = require('electron');

const AGENT_URL = process.env.NEKOCHANNEL_AGENT_URL || 'http://127.0.0.1:4318';

// State machine poll (murni, agar bisa di-test tanpa Electron):
// hidup & belum tampil → muat chat; mati & tampil → fallback; sisanya idle.
const nextStep = (healthy, loaded) =>
  healthy && !loaded ? 'load-chat' :
  !healthy && loaded ? 'show-error' : 'idle';

const errorPage = url => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>Chat server mati</title>
<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#111b21;color:#8696a0;font:14px/1.6 system-ui,sans-serif;text-align:center}
button{margin-top:14px;padding:8px 22px;border:none;border-radius:8px;background:#1769aa;color:#fff;font:inherit;cursor:pointer}
button:hover{filter:brightness(1.15)}code{color:#e9edef}</style></head><body>
<div><div style="font-size:34px">🤖</div>
<div style="margin-top:8px"><b style="color:#e9edef">Chat server belum jalan</b></div>
<div style="margin-top:4px">Nyalakan dari repo wa-reader:<br><code>CHAT_MODE=fc node --experimental-sqlite chat/server.js</code></div>
<button onclick="location.replace('${url}')">Retry</button></div></body></html>`);

function createAgentView({ url = AGENT_URL, pollMs = 10000, log = console.log } = {}) {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true } });
  view.setBackgroundColor('#111b21');
  const wc = view.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' })); // semua navigasi tetap in-tab
  let loaded = false;
  let busy = false; // hindari loadURL tumpuk saat poll & retry bawaan barengan

  const showError = async () => {
    loaded = false;
    try { await wc.loadURL(errorPage(url)); } catch { /* data URL tak gagal */ }
    log('fallback error page tampil');
  };
  const loadChat = async () => {
    try {
      await wc.loadURL(url);
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
  };
}

module.exports = { createAgentView, nextStep, errorPage, AGENT_URL };
