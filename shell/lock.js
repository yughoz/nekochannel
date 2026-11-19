'use strict';
const path = require('node:path');
const { verifyPassword } = require('./privacy');

function createLock({ electron, settings, strings, onChange = () => {}, now = Date.now }) {
  const { BrowserWindow, screen, powerMonitor } = electron;
  const windows = new Map();
  let locked = false, disposing = false, busy = false, nextAttempt = 0, failures = 0, armed = true;
  const file = path.join(__dirname, 'lock.html');
  const owns = event => [...windows.values()].some(window => !window.isDestroyed() && window.webContents === event.sender) &&
    event.senderFrame === event.sender.mainFrame && event.senderFrame.url === require('node:url').pathToFileURL(file).href;
  function cover() {
    if (!locked) return;
    const displays = screen.getAllDisplays();
    for (const display of displays) {
      let window = windows.get(display.id);
      if (!window || window.isDestroyed()) {
        window = new BrowserWindow({
          ...display.bounds, frame: false, resizable: false, movable: false, minimizable: false,
          maximizable: false, closable: false, backgroundColor: '#111b21', show: false,
          webPreferences: { preload: path.join(__dirname, 'lock-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
        });
        windows.set(display.id, window);
        window.setAlwaysOnTop(true, 'screen-saver');
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        if (process.platform === 'darwin') window.setSimpleFullScreen(true);
        else window.setFullScreen(true);
        window.on('close', event => { if (!disposing) event.preventDefault(); });
        window.on('hide', () => { if (locked && !disposing) window.show(); });
        window.on('minimize', () => { if (locked) { window.restore(); window.show(); } });
        window.on('leave-full-screen', () => { if (locked) window.setFullScreen(true); });
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('before-input-event', (event, input) => {
          if (['F5', 'F11', 'Escape'].includes(input.key) || ((input.control || input.meta) && ['r', 'w', 'q'].includes(input.key.toLowerCase()))) event.preventDefault();
        });
        window.webContents.on('render-process-gone', () => { if (locked && !window.isDestroyed()) window.loadFile(file); });
        window.webContents.on('did-finish-load', () => window.webContents.send('lock:strings', strings()));
        window.loadFile(file);
      }
      window.setBounds(display.bounds);
      window.show();
    }
    for (const [id, window] of windows) if (!displays.some(display => display.id === id)) { window.destroy(); windows.delete(id); }
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
    disposing = true;
    for (const window of windows.values()) window.destroy();
    windows.clear();
    disposing = false;
    onChange();
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
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, cover);
  return {
    lock, unlock, owns, cover, tick, isLocked: () => locked,
    refresh: () => { for (const window of windows.values()) window.webContents.send('lock:strings', strings()); },
    dispose: () => { clearInterval(timer); for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, cover); dismiss(); },
    windows,
  };
}
module.exports = { createLock };
