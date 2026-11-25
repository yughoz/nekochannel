'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createLock } = require('../shell/lock');
const { normalize, hashPassword } = require('../shell/privacy');

// Tiruan minimal Electron: WebContentsView + jendela utama dengan contentView (urutan child = z-order).
class View {
  constructor() {
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = {};
    this.webContents.setWindowOpenHandler = () => {};
    this.webContents.send = () => {};
    this.webContents.focus = () => {};
    this.webContents.isDestroyed = () => !!this.dead;
    this.webContents.close = () => { this.dead = true; };
    this.webContents.loadFile = file => { this.webContents.mainFrame.url = pathToFileURL(file).href; };
    this.visible = true;
  }
  setBackgroundColor() {}
  setBounds(bounds) { this.bounds = bounds; }
  setVisible(value) { this.visible = value; }
}
function fakeWindow() {
  const children = [];
  return {
    children,
    contentView: {
      addChildView(view) { const i = children.indexOf(view); if (i >= 0) children.splice(i, 1); children.push(view); },
      removeChildView(view) { const i = children.indexOf(view); if (i >= 0) children.splice(i, 1); },
    },
    getContentBounds: () => ({ x: 120, y: 80, width: 900, height: 640 }),
    isDestroyed: () => false,
    isFocused: () => true,
  };
}

test('#58 lock: overlay di dalam jendela utama (bukan fullscreen), view lain disembunyikan, unlock tepercaya + cooldown + idle', async () => {
  const win = fakeWindow();
  const wa = new View(), agent = new View();
  win.contentView.addChildView(wa); win.contentView.addChildView(agent);
  let settings = normalize(), clock = 0, changes = 0;
  const lock = createLock({
    electron: { WebContentsView: View, powerMonitor: { getSystemIdleTime: () => 0 } },
    settings: () => settings, strings: () => ({}), now: () => clock, onChange: () => { changes++; },
    host: { window: () => win, views: () => [wa, agent] },
  });
  try {
    assert.equal(lock.lock(), false); // tanpa password tidak bisa mengunci
    settings.passwordHash = await hashPassword('disposable-test-password');
    lock.tick(9999);
    assert.equal(lock.isLocked(), false);
    settings.autoLockMinutes = 1;
    lock.tick(59); assert.equal(lock.isLocked(), false);
    lock.tick(60); assert.equal(lock.isLocked(), true);
    const shield = lock.view;
    assert.equal(win.children.at(-1), shield); // paling atas di jendela utama
    assert.deepEqual(shield.bounds, { x: 0, y: 0, width: 900, height: 640 }); // seluruh area isi jendela, bukan layar
    assert.equal(shield.visible, true);
    assert.equal(wa.visible || agent.visible, false); // isi WA/agent disembunyikan
    // Tata letak lain menaikkan view (setActive) → cover menaikkan overlay lagi.
    wa.visible = true; win.contentView.addChildView(wa);
    lock.cover();
    assert.equal(win.children.at(-1), shield);
    assert.equal(wa.visible, false);
    const event = { sender: shield.webContents, senderFrame: shield.webContents.mainFrame };
    assert.equal((await lock.unlock({ ...event, senderFrame: {} }, 'disposable-test-password')).ok, false);
    assert.equal((await lock.unlock({ sender: wa.webContents, senderFrame: wa.webContents.mainFrame }, 'disposable-test-password')).ok, false);
    assert.equal((await lock.unlock(event, 'incorrect-password')).ok, false);
    assert.equal((await lock.unlock(event, 'disposable-test-password')).ok, false); // cooldown
    clock = 1000;
    const attempt = lock.unlock(event, 'disposable-test-password');
    assert.equal((await lock.unlock(event, 'disposable-test-password')).ok, false); // satu percobaan sekaligus
    assert.equal((await attempt).ok, true);
    assert.equal(lock.isLocked(), false);
    assert.equal(win.children.includes(shield), false); // overlay dilepas
    assert.ok(changes >= 2); // lock + unlock → pemilik memulihkan tata letak
    lock.tick(61); assert.equal(lock.isLocked(), false); // tidak langsung terkunci lagi setelah unlock
    lock.tick(0); lock.tick(60); assert.equal(lock.isLocked(), true);
    assert.equal(lock.view, shield); // overlay dipakai ulang, bukan jendela baru
  } finally { lock.dispose(); }
  assert.equal(lock.isLocked(), false);
  assert.equal(lock.view.webContents.isDestroyed(), true);
});
