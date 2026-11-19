'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createLock } = require('../shell/lock');
const { normalize, hashPassword } = require('../shell/privacy');

test('lock: password gate, display topology, trusted unlock, cooldown and idle rearm', async () => {
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setSimpleFullScreen() {}
    setFullScreen() {}
    setBounds() {}
    show() {}
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return !!this.dead; }
    destroy() { this.dead = true; }
  }
  const screen = new EventEmitter();
  let displays = [{ id: 1, bounds: {} }, { id: 2, bounds: {} }];
  screen.getAllDisplays = () => displays;
  let settings = normalize(), clock = 0;
  const lock = createLock({ electron: { BrowserWindow: Window, screen, powerMonitor: { getSystemIdleTime: () => 0 } }, settings: () => settings, strings: () => ({}), now: () => clock });
  try {
    assert.equal(lock.lock(), false);
    settings.passwordHash = await hashPassword('disposable-test-password');
    lock.tick(9999);
    assert.equal(lock.isLocked(), false);
    settings.autoLockMinutes = 1;
    lock.tick(59); assert.equal(lock.isLocked(), false);
    lock.tick(60); assert.equal(lock.windows.size, 2);
    displays = [displays[1]]; screen.emit('display-removed');
    assert.equal(lock.windows.size, 1);
    const shield = [...lock.windows.values()][0];
    let prevented = false;
    shield.emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    const event = { sender: shield.webContents, senderFrame: shield.webContents.mainFrame };
    assert.equal((await lock.unlock({ ...event, senderFrame: {} }, 'disposable-test-password')).ok, false);
    assert.equal((await lock.unlock(event, 'incorrect-password')).ok, false);
    assert.equal((await lock.unlock(event, 'disposable-test-password')).ok, false);
    clock = 1000;
    const attempt = lock.unlock(event, 'disposable-test-password');
    assert.equal((await lock.unlock(event, 'disposable-test-password')).ok, false);
    assert.equal((await attempt).ok, true);
    assert.equal(lock.windows.size, 0);
    lock.tick(61); assert.equal(lock.isLocked(), false);
    lock.tick(0); lock.tick(60); assert.equal(lock.isLocked(), true);
  } finally { lock.dispose(); }
  assert.equal(screen.listenerCount('display-added'), 0);
});
