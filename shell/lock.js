'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { verifyPassword } = require('./privacy');

// Kunci aplikasi (#58): overlay WebContentsView DI DALAM jendela Nekochannel — bukan jendela
// fullscreen per monitor. Overlay menutupi seluruh area isi (sidebar + WA + agent + Settings),
// selalu dinaikkan ke paling atas, dan semua view lain disembunyikan selama terkunci; aplikasi
// & monitor lain tetap bisa dipakai. host.window() = jendela utama, host.views() = view lain.
function createLock({ electron, settings, strings, onChange = () => {}, now = Date.now, host = {} }) {
  const { WebContentsView, powerMonitor } = electron;
  let view = null;
  let locked = false, busy = false, nextAttempt = 0, failures = 0, armed = true;
  const file = path.join(__dirname, 'lock.html');
  const live = () => view && !view.webContents.isDestroyed();
  const owns = event => !!live() && event.sender === view.webContents &&
    event.senderFrame === event.sender.mainFrame && event.senderFrame.url === pathToFileURL(file).href;
  function ensureView() {
    if (live()) return view;
    view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'lock-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    });
    view.setBackgroundColor('#111b21');
    const wc = view.webContents;
    wc.on('will-navigate', event => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('before-input-event', (event, input) => {
      if (['F5', 'F11', 'Escape'].includes(input.key) || ((input.control || input.meta) && ['r', 'w', 'q'].includes(String(input.key).toLowerCase()))) event.preventDefault();
    });
    wc.on('render-process-gone', () => { if (locked && live()) wc.loadFile(file); });
    wc.on('did-finish-load', () => wc.send('lock:strings', strings()));
    wc.loadFile(file);
    return view;
  }
  // Pasang/naikkan overlay. Dipanggil juga setelah tata letak berubah (setActive, resize, focus):
  // view lain bisa dinaikkan ke atas oleh setActive → overlay dinaikkan lagi + view lain disembunyikan.
  function cover() {
    if (!locked) return;
    const win = host.window?.();
    if (!win || win.isDestroyed()) return;
    const shield = ensureView();
    for (const other of host.views?.() || []) if (other && other !== shield) { try { other.setVisible(false); } catch { /* view hancur */ } }
    win.contentView.removeChildView(shield); // re-add = paling atas
    win.contentView.addChildView(shield);
    const { width, height } = win.getContentBounds();
    shield.setBounds({ x: 0, y: 0, width, height });
    shield.setVisible(true);
    if (win.isFocused?.()) shield.webContents.focus();
  }
  function lock() {
    if (!settings().passwordHash) return false;
    locked = true;
    cover();
    onChange();
    return true;
  }
  function dismiss() {
    locked = false;
    const win = host.window?.();
    if (view) {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
      try { view.setVisible(false); } catch { /* view hancur */ }
    }
    onChange(); // pemilik host memulihkan tata letak (view tab aktif tampil lagi)
  }
  async function unlock(event, password) {
    if (!locked || !owns(event) || busy || now() < nextAttempt) return { ok: false };
    busy = true;
    try {
      const ok = await verifyPassword(password, settings().passwordHash);
      if (!ok) {
        failures++;
        nextAttempt = now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
        return { ok: false };
      }
      failures = 0;
      nextAttempt = 0;
      armed = false;
      dismiss();
      return { ok: true };
    } finally { busy = false; }
  }
  function tick(idle = powerMonitor.getSystemIdleTime()) {
    const threshold = settings().autoLockMinutes * 60;
    if (!threshold || idle < threshold) armed = true;
    if (threshold && armed && idle >= threshold && !locked) lock();
  }
  const timer = setInterval(tick, 1000);
  return {
    lock, unlock, owns, cover, tick, isLocked: () => locked,
    refresh: () => { if (live()) view.webContents.send('lock:strings', strings()); },
    dispose: () => {
      clearInterval(timer);
      dismiss();
      if (live()) { try { view.webContents.close(); } catch { /* sudah tutup */ } }
    },
    get view() { return view; },
  };
}
module.exports = { createLock };
